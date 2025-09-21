import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import axios from "axios";
import FormData from "form-data";
import nodemailer from "nodemailer";
import crypto from "crypto";
import http from "http";
import https from "https";
import { Pool } from "pg";
import { Document, Packer, Paragraph } from "docx";
import OpenAI from "openai";

// ---------- notify PHP (worker-consume.php) ----------
const CONSUME_URL = process.env.CONSUME_URL || "";
const WORKER_SHARED_KEY = process.env.WORKER_SHARED_KEY || "";

// ---------- PHP endpoints ----------
const CALLBACK_URL = process.env.CALLBACK_URL || ""; // e.g. https://voixl.com/worker-callback.php
const STORE_URL    = process.env.STORE_URL || "";    // e.g. https://voixl.com/store-transcript.php

async function consume(payload) {
  if (!CONSUME_URL) return;
  try {
    await axios.post(CONSUME_URL, payload, {
      headers: WORKER_SHARED_KEY ? { "X-Worker-Key": WORKER_SHARED_KEY } : {},
      timeout: 10000,
    });
    console.log("→ consume() POST ok");
  } catch (e) {
    console.error("consume() error:", e?.response?.status || "", e?.message || e);
  }
}

// ---------- notify PHP dashboard (worker-callback.php) ----------
async function updateStatus(requestId, status, durationSec = 0) {
  if (!CALLBACK_URL) return;
  try {
    await axios.post(
      CALLBACK_URL,
      new URLSearchParams({
        request_id: requestId,
        status: status,
        duration_sec: durationSec.toString(),
      }),
      {
        headers: {
          "X-Worker-Key": WORKER_SHARED_KEY,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 10000,
      }
    );
    console.log(`→ updateStatus(${requestId}, ${status}) ok`);
  } catch (err) {
    console.error("updateStatus error:", err?.response?.status, err?.message || err);
  }
}

// ---------- NEW: store TXT/DOCX on PHP (store-transcript.php) ----------
async function storeTranscript(requestId, txtContent, docxBuffer) {
  if (!STORE_URL) return;
  try {
    const fd = new FormData();
    fd.append("request_id", requestId);
    if (txtContent) {
      fd.append("txt", Buffer.from(txtContent, "utf8"), {
        filename: "transcript.txt",
        contentType: "text/plain; charset=utf-8",
      });
    }
    if (docxBuffer) {
      fd.append("docx", docxBuffer, {
        filename: "transcript.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
    }
    await axios.post(STORE_URL, fd, {
      headers: {
        "X-Worker-Key": WORKER_SHARED_KEY,
        ...fd.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 20000,
    });
    console.log(`→ storeTranscript(${requestId}) ok`);
  } catch (err) {
    console.error("storeTranscript error:", err?.response?.status, err?.message || err);
  }
}

// ---------- app / setup ----------
const app = express();
const allowedOrigins = ["https://voixl.com", "https://www.voixl.com", "https://dottlight.com", "https://www.dottlight.com"];
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  })
);
app.options("*", cors());
app.use(express.json({ limit: "1mb" }));

// keep long uploads alive
app.use((req, _res, next) => {
  try { req.setTimeout?.(0); } catch {}
  try {
    if (req.socket) {
      req.socket.setTimeout?.(0);
      req.socket.setKeepAlive?.(true, 60_000);
    }
  } catch {}
  next();
});

// ===== Upload-only mode =====
const MAX_UPLOAD_BYTES = Number(
  process.env.MAX_UPLOAD_BYTES || 1.5 * 1024 * 1024 * 1024
); // 1.5 GB default
const upload = multer({
  dest: "/tmp",
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    const ok =
      (file.mimetype || "").startsWith("audio/") ||
      (file.mimetype || "").startsWith("video/");
    if (!ok) return cb(new Error("Only audio/video files are allowed."));
    cb(null, true);
  },
});
ffmpeg.setFfmpegPath(ffmpegStatic);

// ---------- env checks ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
const LOCAL_TZ = process.env.LOCAL_TZ || "America/Los_Angeles";
const FROM_EMAIL = process.env.FROM_EMAIL || GMAIL_USER;
const FROM_NAME = process.env.FROM_NAME || "VOIXL.com";

function fatal(m) {
  console.error("❌ " + m);
  process.exit(1);
}
if (!OPENAI_API_KEY) fatal("Missing OPENAI_API_KEY");
if (!GMAIL_USER || !GMAIL_PASS) fatal("Missing GMAIL_USER or GMAIL_PASS");

// ---------- Postgres pool ----------
const DATABASE_URL = process.env.DATABASE_URL || "";
const DB_HOST = process.env.DB_HOST || "";
const DB_PORT = Number(process.env.DB_PORT || 5432);
const DB_USER = process.env.DB_USER || "";
const DB_PASS = process.env.DB_PASS || "";
const DB_NAME = process.env.DB_NAME || "";
const DB_SSL = (process.env.DB_SSL || "true").toLowerCase() === "true";

const pool =
  DATABASE_URL
    ? new Pool({
        connectionString: DATABASE_URL,
        ssl: DB_SSL ? { rejectUnauthorized: false } : undefined,
        max: 10,
      })
    : new Pool({
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USER,
        password: DB_PASS,
        database: DB_NAME,
        ssl: DB_SSL ? { rejectUnauthorized: false } : undefined,
        max: 10,
      });

pool
  .query("SELECT 1")
  .then(() => console.log("✅ DB connectivity OK (Postgres)"))
  .catch((e) => {
    console.error("❌ DB connectivity failed:", e.code || "", e.message);
  });

/** -------------------------------------------------------
 * Ensure required tables exist (auto-migrate on boot)
 * - jobs          (requestid, status, steps jsonb, error, created_at)
 * - transcriptions (columns your code writes to)
 * ------------------------------------------------------ */
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      requestid   TEXT PRIMARY KEY,
      status      TEXT NOT NULL,
      steps       JSONB NOT NULL DEFAULT '[]'::jsonb,
      error       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcriptions (
      id                  BIGSERIAL PRIMARY KEY,
      timestamputc        TIMESTAMPTZ NOT NULL,
      timestamplocal      TEXT NOT NULL,
      email               TEXT NOT NULL,
      jobseconds          INTEGER NOT NULL,
      cumulativeseconds   INTEGER NOT NULL,
      minutes             INTEGER NOT NULL,
      cumulativeminutes   INTEGER NOT NULL,
      filename            TEXT NOT NULL,
      filesizemb          NUMERIC(10,2) NOT NULL,
      language            TEXT NOT NULL,
      requestid           TEXT NOT NULL,
      processingms        INTEGER NOT NULL,
      succeeded           BOOLEAN NOT NULL,
      errormessage        TEXT NOT NULL,
      model               TEXT NOT NULL,
      filetype            TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trans_email ON transcriptions(email);
    CREATE INDEX IF NOT EXISTS idx_trans_reqid ON transcriptions(requestid);
    CREATE INDEX IF NOT EXISTS idx_trans_succeeded ON transcriptions(succeeded);
  `);

  console.log("✅ Schema ready (jobs, transcriptions)");
}

await ensureSchema().catch((e) => {
  console.error("❌ Schema init failed:", e);
  process.exit(1);
});

// ---------- mailer ----------
const mailer = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
});

// ---------- small utils ----------
const OPENAI_AUDIO_MAX = 25 * 1024 * 1024; // OpenAI per-file limit (25 MB)
const TARGET_MAX_BYTES = 24 * 1024 * 1024; // aim just under
const MIN_SEG_SECONDS = 420; // 7 min
const MAX_SEG_SECONDS = 600; // 10 min (cap tightened)
const DEFAULT_SEG_SECONDS = 600;

function statBytes(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}
function fmtLocalStamp(d) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LOCAL_TZ,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).formatToParts(d);
  let Y, M, D, hh, mm, ss, ap;
  for (const p of parts) {
    if (p.type === "year") Y = p.value;
    else if (p.type === "month") M = p.value;
    else if (p.type === "day") D = p.value;
    else if (p.type === "hour") hh = p.value;
    else if (p.type === "minute") mm = p.value;
    else if (p.type === "second") ss = p.value;
    else if (p.type === "dayPeriod") ap = p.value.toUpperCase();
  }
  return `${Y} ${M} ${D} ${hh}:${mm}:${ss} ${ap}`;
}
function secsToSheetMinutes(sec) {
  return Math.max(1, Math.ceil((sec || 0) / 60));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- language helpers (Fix 1 + block classifiers) ----------
function isChineseLang(code) {
  const c = (code || '').toLowerCase().trim();
  const sinitic = ['zh','zh-cn','zh-tw','zh-hk','cmn','yue','wuu','gan','hak','nan'];
  return sinitic.some(p => c === p || c.startsWith(p));
}
function cjkRatio(text) {
  if (!text) return 0;
  const cjk = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF]/g) || [];
  return cjk.length / text.length;
}
const reHira = /[\u3040-\u309F]/;
const reKata = /[\u30A0-\u30FF]/;
const reHangul = /[\uAC00-\uD7AF]/;
function classifyScript(text){
  if (!text) return 'other';
  if (reHira.test(text) || reKata.test(text)) return 'ja';
  if (reHangul.test(text)) return 'ko';
  if (cjkRatio(text) > 0.2) return 'zh';
  return 'other';
}
// quick & dirty Mandarin-likeliness via very common function words
const commonZh = new Set('的一是不在人有了和就要也到說為在你我他了沒這個吧嗎來去很可以對沒有把會讓跟還呢把像可是因為如果但是所以以及或者而且並且以及與於再又都把更最把給被從等與把等'.split(''));
function mandarinScore(text){
  const chars = (text || '').split('').filter(ch => /[\u4E00-\u9FFF]/.test(ch));
  if (!chars.length) return 0;
  let hits = 0;
  for (const ch of chars) if (commonZh.has(ch)) hits++;
  return hits / chars.length; // ~0.18–0.35 typical for natural Mandarin; <<0.12 often dialect/jibberish
}
function decideChinese(langs, text) {
  const counts = {};
  for (const l of langs) {
    const k = (l || '').toLowerCase();
    counts[k] = (counts[k] || 0) + 1;
  }
  let topLang = '';
  let topCount = -1;
  for (const [k, v] of Object.entries(counts)) {
    if (v > topCount) { topCount = v; topLang = k; }
  }
  if (isChineseLang(topLang)) {
    return { isChinese: true, finalLang: topLang, reason: `majority language "${topLang}"` };
  }
  const ratio = cjkRatio(text);
  if (ratio > 0.20) {
    return { isChinese: true, finalLang: topLang || 'zh', reason: `CJK ratio ${(ratio*100).toFixed(1)}%` };
  }
  return { isChinese: false, finalLang: topLang || '', reason: topLang ? `majority language "${topLang}"` : 'no language reported' };
}

// ---------- keep-alive axios for OpenAI ----------
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const axiosOpenAI = axios.create({
  httpAgent,
  httpsAgent,
  timeout: 900000, // 15 min
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
  headers: {
    Connection: "keep-alive",
    Accept: "application/json",
  },
});

// ---------- DB helpers ----------
async function createJob(id) {
  const step = { at: new Date().toISOString(), text: "Job accepted by server." };
  await pool.query(
    `INSERT INTO jobs (requestid, status, steps, created_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (requestid)
     DO UPDATE SET status = EXCLUDED.status, steps = EXCLUDED.steps`,
    [id, "accepted", JSON.stringify([step])]
  );
  console.log(`[${id}] Job created in database.`);
}

async function addStep(id, text) {
  const step = { at: new Date().toISOString(), text };
  await pool.query(
    `UPDATE jobs
        SET steps = COALESCE(steps, '[]'::jsonb) || $1::jsonb
      WHERE requestid = $2`,
    [JSON.stringify([step]), id]
  );
  console.log(`[${id}] ${text}`);
}

async function setJobStatus(id, status, error = null) {
  await pool.query(
    `UPDATE jobs SET status = $1, error = $2 WHERE requestid = $3`,
    [status, error, id]
  );
}

// status endpoint
app.get("/status", async (req, res) => {
  const id = (req.query.id || "").toString();
  if (!id) return res.status(400).json({ error: "Missing id" });
  const { rows } = await pool.query(
    `SELECT requestid, status, steps, error, created_at
        FROM jobs
       WHERE requestid = $1
       LIMIT 1`,
    [id]
  );
  const j = rows[0];
  if (!j) return res.status(404).json({ error: "Not found" });
  const steps =
    Array.isArray(j.steps)
      ? j.steps
      : (() => {
          try {
            return JSON.parse(j.steps || "[]");
          } catch {
            return [];
          }
        })();
  res.json({ ...j, steps });
});

// ---------- media analysis ----------
function ffprobeDurationSeconds(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return reject(err);
      resolve(Number(meta?.format?.duration) || 0);
    });
  });
}

// ---------- bitrate planning ----------
function estimateSizeBytes(seconds, kbps) {
  return Math.ceil(seconds * (kbps * 1000) / 8);
}
function chooseBitrateAndSplit(seconds) {
  const options = [80, 64, 48];
  for (const kb of options) {
    const est = estimateSizeBytes(seconds, kb);
    if (est <= TARGET_MAX_BYTES) {
      return { kbps: kb, needsSplit: false, estBytes: est };
    }
  }
  const kbps = options[options.length - 1];
  return { kbps, needsSplit: true, estBytes: estimateSizeBytes(seconds, kbps) };
}
function computeSegmentSeconds(kbps) {
  const seconds = Math.floor(TARGET_MAX_BYTES / ((kbps * 1000) / 8));
  return Math.max(MIN_SEG_SECONDS, Math.min(MAX_SEG_SECONDS, seconds || DEFAULT_SEG_SECONDS));
}

// ---------- single-pass encode helpers ----------
async function encodeSingleMp3(inPath, outMp3, kbps, requestId) {
  addStep(requestId, `Encode MP3 @ ${kbps} kbps (single file)…`);
  await new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .noVideo()
      .audioFilters(["dynaudnorm"])
      .outputOptions([
        "-ac", "1",
        "-ar", "16000",
        "-b:a", `${kbps}k`,
        "-codec:a", "libmp3lame",
      ])
      .save(outMp3)
      .on("end", resolve)
      .on("error", reject);
  });
  return outMp3;
}
async function encodeAndSegmentMp3(inPath, outPattern, kbps, segmentSeconds, requestId) {
  addStep(requestId, `Encode+Segment MP3 @ ${kbps} kbps, ~${segmentSeconds}s/part…`);
  await new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .noVideo()
      .audioFilters(["dynaudnorm"])
      .outputOptions([
        "-ac", "1",
        "-ar", "16000",
        "-b:a", `${kbps}k`,
        "-codec:a", "libmp3lame",
        "-f", "segment",
        "-segment_time", String(segmentSeconds),
        "-reset_timestamps", "1",
      ])
      .save(outPattern)
      .on("end", resolve)
      .on("error", reject);
  });
  const dir = path.dirname(outPattern);
  const base = path.basename(outPattern).split("%")[0];
  const files = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(base) && n.endsWith(".mp3"))
    .map((n) => path.join(dir, n))
    .sort();
  return files;
}

// ---------- OpenAI (Whisper) ----------
async function openaiTranscribeVerbose(audioPath, requestId, langHint) {
  const PER_CALL_MS = Number(process.env.WHISPER_CALL_TIMEOUT_MS || 360_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_CALL_MS);

  try {
    const fd = new FormData();
    fd.append("file", fs.createReadStream(audioPath), {
      filename: path.basename(audioPath),
    });
    fd.append("model", "whisper-1");
    fd.append("response_format", "verbose_json");
    fd.append("temperature", "0");
    // ask for segment timing explicitly (some runtimes require this)
    fd.append("timestamp_granularities[]", "segment");
    if (langHint) fd.append("language", String(langHint));

    const r = await axiosOpenAI.post(
      "https://api.openai.com/v1/audio/transcriptions",
      fd,
      {
        signal: controller.signal,
        validateStatus: (s) => s >= 200 && s < 300,
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          ...fd.getHeaders(),
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    );
    return r.data;
  } catch (err) {
    console.error(
      `[${requestId}] Whisper transcribe error:`,
      err?.response?.status,
      err?.code || err?.name || "",
      err?.message
    );
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- retries & bounded concurrency ----------
function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function withRetries(fn, { maxAttempts = 5, baseDelayMs = 700 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      const s = e?.response?.status;
      const code = (e?.code || "").toString();

      const retriable =
        s === 429 ||
        (s >= 500 && s < 600) ||
        code === "ECONNRESET" ||
        code === "ETIMEDOUT" ||
        code === "ECONNABORTED" ||
        code === "ERR_CANCELED";

      if (!retriable || attempt >= maxAttempts) throw e;

      const delay = Math.floor(baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 250);
      await sleepMs(delay);
    }
  }
}
async function runBounded(tasks, limit = 3) {
  const results = new Array(tasks.length);
  let next = 0, active = 0;
  return new Promise((resolve, reject) => {
    const launch = () => {
      if (next >= tasks.length && active === 0) return resolve(results);
      while (active < limit && next < tasks.length) {
        const idx = next++;
        active++;
        Promise.resolve()
          .then(() => tasks[idx]())
          .then((r) => { results[idx] = r; })
          .catch(reject)
          .finally(() => { active--; launch(); });
      }
    };
    launch();
  });
}

// ---------- OpenAI SDK client (Responses API) ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- GPT translation (Responses API + fallbacks) ----------
async function gptTranslateFaithful(originalAll, requestId, mode = 'A', emitHeader = true) {

  // === Prompts updated: no 【? ?】 anywhere; no em-dashes; no square-bracket wrappers ===
  const systemPromptModeA = `
You are a transcription & translation model operating in Mode A.
Use this for ANY source that is NOT Modern Standard Chinese (Mandarin). Includes Chinese dialects (Cantonese, Shanghainese/Wu, Hokkien/Minnan, Hakka, Taiwanese), even if Han characters appear.

=== OUTPUT HEADER (print once only if PRINT_HEADER=YES) ===
免責聲明：本翻譯／轉寫由自動系統產生，可能因口音、方言、背景雜音、語速、重疊語音、錄音品質等因素而不完全準確；請務必自行複核與修訂。本服務對因翻譯或轉寫錯誤所致之任何損失、損害或責任，概不負擔。
（說明：括號（）與方括號[] 內之內容若出現，皆為系統為協助理解所加入，非原文內容。Mode A 的「翻譯」行可於專名或外語詞後加中文釋義；以利核對。禁止使用破折號—或——，請改用；或、。）

=== FORMAT per sentence/unit ===
<ORIGINAL line exactly as ASR produced; do NOT wrap it in any brackets.>

(blank line)

翻譯：以繁體中文逐字直譯，完整保留資訊與不確定性；遇外語詞必翻譯為中文，並於詞後以（原文）或（中文釋義）輔助核對；不使用破折號。
（若原句含有真正的 [雜音]/[重疊]/[音樂]/[笑聲] 標記，僅當其影響準確性時在備註說明；不要另行添加方括號。）

（可選）備註：精簡且有用的說明（如：數字/人名存疑、日期格式含糊等）。不要加指令語氣。

(blank line)

=== CORE RULES ===
- 不要使用【? ?】任何形式；若詞義不清，保留原文字面，僅在備註說明「…語義不清／建議核對」。
- 翻譯行不得殘留羅馬字外語而未翻；一律翻成中文，並以（原文）保留對照。
- 嚴禁使用破折號—或——；以；或、替代。
- 不要創造、搬運或包裹任何一行於方括號[]；僅在原句本身有此標記且影響理解時，在備註描述之。
- 僅當原句雜訊極多且影響閱讀時，才新增一行「清整版：……」（可省略）。

INPUT:
You will receive:
PRINT_HEADER: YES or NO
<source>…text…</source>
Respect PRINT_HEADER strictly.`;

  const systemPromptModeB = `
You are a transcription model operating in Mode B (Modern Standard Chinese only).
If the source is any other language or a Chinese dialect, do NOT use Mode B—use Mode A.

=== OUTPUT HEADER (print once only if PRINT_HEADER=YES) ===
免責聲明：本翻譯／轉寫由自動系統產生，可能因口音、方言、背景雜音、語速、重疊語音、錄音品質等因素而不完全準確；請務必自行複核與修訂。本服務對因翻譯或轉寫錯誤所致之任何損失、損害或責任，概不負擔。
（說明：括號（）內為系統加入之中文釋義（若有）；方括號[] 僅用於原句已存在的雜訊標記，且只在影響正確性時於備註提及。嚴禁使用破折號—或——，請改用；或、。）

=== FORMAT per sentence/unit (no translation line) ===
<ORIGINAL line in Chinese exactly as spoken。若 ASR 為簡體，轉為繁體字形；不改詞。不得包裹方括號。>

（可選）備註：僅當有助於判讀時，短且客觀（如：日期格式含糊；數字發音不清；人名存疑）。不使用破折號。

(blank line)

CORE:
- 不要使用【? ?】；若詞義不清，保留原句，僅在備註說明。
- 不複製噪音標記到別行；不要人為新增方括號。
- 嚴禁破折號—或——；用；或、代替。
- 只做字形轉換（簡→繁），不做語詞修飾。

INPUT:
PRINT_HEADER: YES or NO
<source>…text…</source>
Respect PRINT_HEADER strictly.`;

  const systemPrompt = mode === 'B' ? systemPromptModeB : systemPromptModeA;
  const preferred = process.env.TRANSLATION_MODEL || "gpt-5-mini";

  const userPayload =
    `PRINT_HEADER: ${emitHeader ? 'YES' : 'NO'}\n<source>\n${originalAll || ""}\n</source>`;

  try {
    const resp = await openai.responses.create({
      model: preferred,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content: [{ type: "input_text", text: userPayload }] },
      ],
    });

    let out =
      (resp.output_text && resp.output_text.trim()) ||
      (Array.isArray(resp.output)
        ? resp.output.flatMap(o => (o?.content || []))
          .map(c => (typeof c?.text === "string" ? c.text : ""))
          .join("").trim()
        : "");

    out = postProcessText(out);
    if (out) return out;
    await addStep(requestId, `Responses output empty from ${preferred}; falling back.`);
  } catch (e) {
    const msg = e?.response?.data?.error?.message || e?.message || String(e);
    await addStep(requestId, `Responses API failed (${preferred}): ${msg}; falling back.`);
  }

  // Chat fallback
  const chatCandidates = ["gpt-4.1-mini", "gpt-4o-mini"];
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userPayload },
  ];

  for (const model of chatCandidates) {
    try {
      const r = await axiosOpenAI.post(
        "https://api.openai.com/v1/chat/completions",
        { model, temperature: 0, messages, response_format: { type: "text" } },
        {
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          validateStatus: () => true,
        }
      );
      if (r.status >= 200 && r.status < 300) {
        let out = r.data?.choices?.[0]?.message?.content?.trim() || "";
        out = postProcessText(out);
        if (out) {
          if (model !== preferred) await addStep(requestId, `Used fallback chat model: ${model}`);
          return out;
        }
        await addStep(requestId, `Chat output empty from ${model}; trying next.`);
      } else {
        await addStep(
          requestId,
          `Chat API error (${model}): ${r.data?.error?.message || `HTTP ${r.status}`}`
        );
      }
    } catch (e) {
      await addStep(requestId, `Chat API exception (${model}): ${e?.message || e}`);
    }
  }

  return "【翻譯暫不可用：已附上原文】\n\n" + (originalAll || "");
}

// ban em-dash; strip 【? ?】 markers if any slipped through; normalize extra square-bracket wrappers
function postProcessText(t=""){
  return t
    .replace(/【\?\s*([^【】]+?)\s*\?】/g, "$1")   // drop uncertain marker but keep inner text
    .replace(/[—–]+/g, "；")                     // ban em/en dashes
    .replace(/\r\n/g, "\n");
}

// ---------- main processor ----------
async function processJob({ email, inputPath, fileMeta, requestId, jobId, token, forceLang = '', forceMode = '' }) {
  await setJobStatus(requestId, "processing");
  await updateStatus(requestId, "processing");

  addStep(
    requestId,
    `Processing: ${fileMeta.originalname} (${(fileMeta.size / 1024 / 1024).toFixed(2)} MB)`
  );

  const tempFiles = new Set([inputPath]);
  const started = Date.now();
  const model = "whisper-1";
  let language = "";
  const fileType = fileMeta.mimetype || "";
  const fileName = fileMeta.originalname || "upload";
  const fileSizeMB = Math.max(0.01, Math.round(((fileMeta.size || 0) / (1024 * 1024)) * 100) / 100);

  try {
    const durationSec = await ffprobeDurationSeconds(inputPath);
    addStep(requestId, `Detected duration: ${Math.round(durationSec)}s`);

    const { kbps, needsSplit } = chooseBitrateAndSplit(durationSec);
    addStep(
      requestId,
      `Chosen bitrate: ${kbps} kbps; ${needsSplit ? "will segment" : "single file"}.`
    );

    let parts = [];
    const tmpBase = `/tmp/${requestId}`;
    if (!needsSplit) {
      const singleOut = `${tmpBase}.${kbps}k.mp3`;
      tempFiles.add(singleOut);
      await encodeSingleMp3(inputPath, singleOut, kbps, requestId);
      const sz = statBytes(singleOut);
      addStep(requestId, `Encoded size: ${(sz / 1024 / 1024).toFixed(2)} MB`);
      if (sz > OPENAI_AUDIO_MAX) {
        addStep(requestId, "Single file still >25MB — encoding again with segmentation …");
        try { fs.unlinkSync(singleOut); } catch {}
        tempFiles.delete(singleOut);
        const segSec = computeSegmentSeconds(kbps);
        const pattern = `${tmpBase}.part-%03d.mp3`;
        const segs = await encodeAndSegmentMp3(inputPath, pattern, kbps, segSec, requestId);
        segs.forEach((p) => tempFiles.add(p));
        parts = segs;
      } else {
        parts = [singleOut];
      }
    } else {
      const segSec = computeSegmentSeconds(kbps);
      const pattern = `${tmpBase}.part-%03d.mp3`;
      const segs = await encodeAndSegmentMp3(inputPath, pattern, kbps, segSec, requestId);
      segs.forEach((p) => tempFiles.add(p));
      parts = segs;
    }

    // duration per part
    async function getSeconds(filePath) {
      return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, meta) => {
          if (err) return reject(err);
          resolve(Number(meta?.format?.duration) || 0);
        });
      });
    }
    let jobSeconds = 0;
    const partDurations = [];
    for (const p of parts) {
      const s = Math.round(await getSeconds(p));
      partDurations.push(s);
      jobSeconds += s;
    }
    jobSeconds = Math.round(jobSeconds);

    const minutesForDb = secsToSheetMinutes(jobSeconds);

    // cumulative seconds (sum only succeeded jobs)
    let pastSeconds = 0;
    try {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(jobseconds), 0)::int AS total
           FROM transcriptions
          WHERE email = $1 AND succeeded = true`,
        [email]
      );
      pastSeconds = Number(rows?.[0]?.total || 0);
    } catch (e) {
      console.error("⚠️ getPastSeconds query error:", e.message || e);
    }
    const cumulativeSeconds = pastSeconds + jobSeconds;
    const cumulativeMinutesForDb = secsToSheetMinutes(cumulativeSeconds);
    addStep(requestId, `Duration this job: ${jobSeconds}s; cumulative: ${cumulativeSeconds}s.`);

    // parallel transcription
    addStep(requestId, `Transcribing ${parts.length} part(s) in parallel (bounded)…`);
    const concurrency = Number(process.env.WHISPER_CONCURRENCY || 3);
    const tasks = parts.map((filePath, idx) => async () => {
      addStep(requestId, `Part ${idx + 1}/${parts.length} → start`);
      const res = await withRetries(
        () => openaiTranscribeVerbose(filePath, requestId, forceLang || null),
        { maxAttempts: 5, baseDelayMs: 700 }
      );
      addStep(requestId, `Part ${idx + 1}/${parts.length} → done`);
      return res;
    });
    const results = await runBounded(tasks, concurrency);

    // Combine segments chronologically across parts (Gemini plan)
    let allSegments = [];
    let detectedLangs = [];
    let offset = 0;
    for (let i = 0; i < results.length; i++) {
      const verbose = results[i];
      if (verbose?.language) detectedLangs.push(verbose.language);
      const segs = Array.isArray(verbose?.segments) ? verbose.segments : [];
      for (const seg of segs) {
        allSegments.push({
          start: Number(seg.start || 0) + offset,
          end: Number(seg.end || 0) + offset,
          text: String(seg.text || "").trim(),
        });
      }
      offset += Number(partDurations[i] || 0);
    }
    allSegments.sort((a,b)=>a.start-b.start);

    // Fallback if segments missing
    if (!allSegments.length) {
      let originalAll = "";
      for (const v of results) originalAll += (originalAll ? "\n\n" : "") + (v?.text || "");
      detectedLangs = detectedLangs.length ? detectedLangs : [''];
      const decision = decideChinese(detectedLangs, originalAll);
      const mode = (forceMode === 'A' || forceMode === 'B') ? forceMode : (decision.isChinese ? 'B' : 'A');
      language = forceLang || decision.finalLang || language || '';
      addStep(requestId, `Mode decision (no segments): langs=${JSON.stringify(detectedLangs)}; reason=${decision.reason}; → ${mode==='B'?'Mode B (Chinese)':'Mode A (non-Chinese)'}`);
      addStep(requestId, "Calling GPT for translation…");
      const zh = await gptTranslateFaithful(originalAll, requestId, mode, true);
      await deliverAndRecord({ requestId, email, fileMeta, fileName, fileType, jobSeconds, zhTraditional: zh, originalAll, started, minutesForDb, cumulativeSeconds, cumulativeMinutesForDb, language: language || decision.finalLang || '', translationMode: mode });
      return;
    }

    // Group consecutive segments by script + Mandarin-likeliness
    const blocks = [];
    const pickModeForText = (txt) => {
      const script = classifyScript(txt);
      if (forceMode === 'A' || forceMode === 'B') return forceMode;
      if (script === 'zh') {
        const ms = mandarinScore(txt);
        return ms >= 0.16 ? 'B' : 'A'; // threshold tuned to prefer Mode A for dialect/gibberish
      }
      return 'A';
    };

    let cur = { mode: pickModeForText(allSegments[0].text), text: "" };
    for (const seg of allSegments) {
      const m = pickModeForText(seg.text);
      if (m === cur.mode) {
        cur.text += (cur.text ? " " : "") + seg.text;
      } else {
        blocks.push(cur);
        cur = { mode: m, text: seg.text };
      }
    }
    blocks.push(cur);

    // Build originals for email/docx (just the stitched text)
    const originalAll = allSegments.map(s => s.text).join(" ").replace(/\s+\n\s+/g,"\n").trim();

    // Translate per block; print header once on first block only
    addStep(requestId, `Block count: ${blocks.length}. Translating per block…`);
    let zhTraditional = "";
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const out = await gptTranslateFaithful(b.text, requestId, b.mode, i === 0);
      zhTraditional += (i === 0 ? "" : "\n") + out;
    }

    // choose overall language/mode info for DB/email subject
    const decision = decideChinese(detectedLangs, originalAll);
    if (!language || forceLang) language = forceLang || decision.finalLang || language || '';
    const overallMode = (forceMode === 'A' || forceMode === 'B')
      ? forceMode
      : (blocks.every(b=>b.mode==='B') ? 'B' : (blocks.every(b=>b.mode==='A') ? 'A' : 'A')); // default to A if mixed

    await deliverAndRecord({
      requestId, email, fileMeta, fileName, fileType, jobSeconds,
      zhTraditional, originalAll, started,
      minutesForDb, cumulativeSeconds, cumulativeMinutesForDb,
      language: language || decision.finalLang || '',
      translationMode: overallMode
    });

  } catch (err) {
    const eMsg = err?.message || "Processing error";
    addStep(requestId, "❌ " + eMsg);
    await setJobStatus(requestId, "error", eMsg);
    await consume({
      event: "transcription.finished",
      status: "failed",
      email,
      filename: fileName,
      request_id: requestId,
      job_id: jobId || "",
      token: String(token || ""),
      duration_sec: 0,
      charged_seconds: 0,
      language: "",
      finished_at: new Date().toISOString(),
      error: eMsg,
    });
    await updateStatus(requestId, "processing_fail");
  } finally {
    addStep(requestId, "Cleaning up temporary files...");
    // do not delete original upload path here; multer cleans /tmp automatically; but keep previous behavior:
    for (const f of Array.from(tempFiles)) {
      try {
        if (f && fs.existsSync(f)) fs.unlinkSync(f);
      } catch {}
    }
  }
}

// helper to email/store/db record
async function deliverAndRecord({
  requestId, email, fileMeta, fileName, fileType, jobSeconds,
  zhTraditional, originalAll, started,
  minutesForDb, cumulativeSeconds, cumulativeMinutesForDb,
  language, translationMode
}) {
  const localStamp = fmtLocalStamp(new Date());
  const emailSubject = translationMode === 'B'
    ? '您的中文逐字稿（原文＋備註）'
    : '您的逐字稿（原文＋繁體中文翻譯）';
  const headerZh = translationMode === 'B'
    ? '＝＝ 中文逐字稿（繁體） ＝＝'
    : '＝＝ 中文（繁體） ＝＝';

  const attachmentText = `${headerZh}
${zhTraditional}

＝＝ 原文 ＝＝
${originalAll}
`;

  const safeBase =
    (fileName || "transcript").replace(/[^\w.-]+/g, "_").slice(0, 50) || "transcript";
  const txtName = `${safeBase}-${requestId}.txt`;
  const docxName = `${safeBase}-${requestId}.docx`;
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph(headerZh),
          ...String(zhTraditional || "")
            .split("\n")
            .map((line) => new Paragraph(line)),
          new Paragraph(""),
          new Paragraph("＝＝ 原文 ＝＝"),
          ...String(originalAll || "")
            .split("\n")
            .map((line) => new Paragraph(line)),
        ],
      },
    ],
  });
  const docxBuffer = await Packer.toBuffer(doc);

  addStep(requestId, "Sending email …");
  await mailer.sendMail({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: email,
    replyTo: FROM_EMAIL,
    subject: emailSubject,
    text: `轉寫已完成 ${localStamp}

本次上傳時長（秒）：${jobSeconds}
檔案名稱：${fileMeta.originalname}

（服務單號：${requestId}）`,
    attachments: [
      {
        filename: txtName,
        content: attachmentText,
        contentType: "text/plain; charset=utf-8",
      },
      {
        filename: docxName,
        content: docxBuffer,
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    ],
  });
  addStep(requestId, "Email sent.");

  await storeTranscript(requestId, attachmentText, docxBuffer);

  try {
    const sql = `
      INSERT INTO transcriptions (
        timestamputc, timestamplocal, email,
        jobseconds, cumulativeseconds, minutes, cumulativeminutes,
        filename, filesizemb, language, requestid, processingms,
        succeeded, errormessage, model, filetype
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12,
        $13, $14, $15, $16
      )
    `;
    const values = [
      new Date(),
      localStamp,
      email,
      jobSeconds,
      cumulativeSeconds,
      minutesForDb,
      cumulativeMinutesForDb,
      fileName,
      Math.max(0.01, Math.round(((fileMeta.size || 0) / (1024 * 1024)) * 100) / 100),
      language || "",
      requestId,
      Date.now() - started,
      true,
      "",
      "whisper-1",
      fileType,
    ];
    await pool.query(sql, values);
    addStep(requestId, "Database record created.");
  } catch (e) {
    addStep(requestId, "⚠️ Database insert failed: " + (e?.message || e));
  }

  await consume({
    event: "transcription.finished",
    status: "succeeded",
    email,
    filename: fileName,
    request_id: requestId,
    job_id: "",
    token: "",
    duration_sec: jobSeconds,
    charged_seconds: jobSeconds,
    language: language || "",
    finished_at: new Date().toISOString(),
  });
  await updateStatus(requestId, "succeeded", jobSeconds);
  await setJobStatus(requestId, "done");
  addStep(requestId, "✅ Done");
}

// ---------- routes (ACK-first upload) ----------
app.post(
  "/upload",
  (req, res, next) => {
    upload.single("file")(req, res, function (err) {
      if (err && err.code === "LIMIT_FILE_SIZE") {
        console.error("[/upload] Multer LIMIT_FILE_SIZE:", err);
        return res
          .status(413)
          .json({
            error: `File too large. Max ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`,
          });
      }
      if (err) {
        console.error("[/upload] Multer error:", err);
        return res.status(400).json({ error: err.message || "Upload error" });
      }
      next();
    });
  },
  async (req, res) => {
    const email = (req.body?.email || "").trim();
    if (!email) return res.status(400).json({ error: "Email is required" });
    if (!req.file) return res.status(400).json({ error: "File is required" });

    const requestId =
      (req.body?.request_id || "").toString().trim() || crypto.randomUUID();

    res.status(202).json({ success: true, accepted: true, requestId });

    setImmediate(async () => {
      try {
        try {
          await createJob(requestId);
        } catch (dbErr) {
          console.error(
            `[${requestId}] createJob DB error (continuing):`,
            dbErr?.message || dbErr
          );
        }

        const force_lang = (req.body?.force_lang || '').toString().trim();
        const force_mode = (req.body?.force_mode || '').toString().trim().toUpperCase();

        await processJob({
          email,
          inputPath: req.file.path,
          fileMeta: req.file,
          requestId,
          jobId: String(req.body?.job_id || ""),
          token: String(req.body?.token || ""),
          forceLang: force_lang || '',
          forceMode: (force_mode === 'A' || force_mode === 'B') ? force_mode : ''
        });
      } catch (e) {
        console.error(`[${requestId}] Background crash:`, e?.message || e);
        try {
          await setJobStatus(requestId, "error", e?.message || String(e));
          await updateStatus(requestId, "processing_fail");
        } catch {}
      }
    });
  }
);

// === DB TRIM/PURGE START ===
const TRIM_JOBS_EMPTY_DAYS = Number(process.env.TRIM_JOBS_EMPTY_DAYS || 1);
const PURGE_JOBS_DAYS = Number(process.env.PURGE_JOBS_DAYS || 1);

app.post("/admin/trim-jobs", async (req, res) => {
  try {
    const key = req.get("X-Worker-Key") || "";
    if (!WORKER_SHARED_KEY || key !== WORKER_SHARED_KEY) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const r1 = await pool.query(
      `
      UPDATE jobs
           SET steps = '[]'::jsonb
         WHERE status IN ('done','error')
           AND created_at < now() - ($1 || ' days')::interval
      `,
      [String(TRIM_JOBS_EMPTY_DAYS)]
    );

    const r2 = await pool.query(
      `
      DELETE FROM jobs
        WHERE created_at < now() - ($1 || ' days')::interval
      `,
      [String(PURGE_JOBS_DAYS)]
    );

    await pool.query(`ANALYZE jobs;`);

    return res.json({
      ok: true,
      trimmed_steps_rows: r1.rowCount || 0,
      purged_job_rows: r2.rowCount || 0,
      trim_days: TRIM_JOBS_EMPTY_DAYS,
      purge_days: PURGE_JOBS_DAYS,
    });
  } catch (err) {
    console.error("/admin/trim-jobs error:", err?.message || err);
    return res.status(500).json({ error: "Internal error" });
  }
});
// === DB TRIM/PURGE END ===

app.get("/", (_req, res) =>
  res.send("✅ Whisper backend (upload-only, Postgres) running")
);

const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 60_000;
