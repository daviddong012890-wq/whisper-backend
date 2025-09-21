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

// <<< FIX: keep long uploads alive (disable per-request timeouts)
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

// ---------- language helpers (Fix 1) ----------
function isChineseLang(code) {
  const c = (code || '').toLowerCase().trim();
  const sinitic = [
    'zh', 'zh-cn', 'zh-tw', 'zh-hk', // Chinese
    'cmn', 'yue', 'wuu', 'gan', 'hak', 'nan' // Mandarin, Cantonese, Wu, Gan, Hakka, Minnan
  ];
  return sinitic.some(p => c === p || c.startsWith(p));
}
function cjkRatio(text) {
  if (!text) return 0;
  const cjk = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF]/g) || []; // CJK Ext-A + Unified
  return cjk.length / text.length;
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

// Extra heuristics for dialect-ish Chinese → prefer Mode A
const DIALECT_MARKERS = [
  // Cantonese
  '唔','冇','咗','喺','嚟','嗰','嘅','啲','咁','佢哋','邊度',
  // Shanghainese / Wu (very rough)
  '侬','阿拉','伲','勿','伊拉','辰光','宁','沪','海派','老早',
  // Hokkien / Minnan (very rough)
  '咱','嘛','閣','媠','袂','攏','曉','啥物','欲',
  // Hakka (very rough)
  '該','伓','毋','佗位'
];
function looksDialectChinese(text) {
  const t = text || '';
  return DIALECT_MARKERS.some(w => t.includes(w));
}

// Script-based quick guess for per-segment grouping
function guessLangFromText(t) {
  if (!t) return 'latin';
  const cjk = (t.match(/[\u4E00-\u9FFF]/g) || []).length;
  const hira = (t.match(/[\u3040-\u309F]/g) || []).length;
  const kata = (t.match(/[\u30A0-\u30FF]/g) || []).length;
  const hang = (t.match(/[\uAC00-\uD7AF]/g) || []).length;
  if (hira + kata > Math.max(cjk, 0) && (hira + kata) >= 2) return 'ja';
  if (hang > Math.max(cjk, 0) && hang >= 2) return 'ko';
  if (cjk >= 2) return 'zh';
  return 'latin';
}

// ---------- keep-alive axios for OpenAI (reduces "socket hang up") ----------
// (Left as-is; no longer used for OpenAI calls, but keeping it to avoid broader edits.)
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

// ---------- DB helpers (Postgres) ----------
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

// Adaptive speech-first strategy: try 80k if it fits, else 64k, else 48k.
// "needsSplit" means the whole clip won't fit target at the chosen bitrate.
function chooseBitrateAndSplit(seconds) {
  const options = [80, 64, 48];
  for (const kb of options) {
    const est = estimateSizeBytes(seconds, kb);
    if (est <= TARGET_MAX_BYTES) {
      return { kbps: kb, needsSplit: false, estBytes: est };
    }
  }
  // If none fit as a single file, pick the lowest (48) and segment.
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
      .audioFilters(["dynaudnorm"]) // speech-safe normalization only
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
      .audioFilters(["dynaudnorm"]) // speech-safe normalization only
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

// ---------- OpenAI SDK client ----------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 5,
  timeout: 900_000, // 15 min
});

// ---------- Whisper via SDK (Fix 2) ----------
async function openaiTranscribeVerbose(audioPath, requestId, langHint) {
  const PER_CALL_MS = Number(process.env.WHISPER_CALL_TIMEOUT_MS || 360_000); // 6 minutes
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_CALL_MS);

  try {
    const r = await openai.audio.transcriptions.create(
      {
        model: "whisper-1",
        file: fs.createReadStream(audioPath),
        response_format: "verbose_json",
        temperature: 0,
        ...(langHint ? { language: String(langHint) } : {}),
      },
      { signal: controller.signal }
    );
    return r; // already JSON
  } catch (err) {
    console.error(
      `[${requestId}] Whisper transcribe error:`,
      err?.status || "",
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
      const s = e?.status || e?.response?.status;
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

// ---------- GPT translation prompts (updated A/B) ----------
function buildSystemPrompt(mode, includeHeader) {
  if (mode === 'B') {
    return `
You are an expert Chinese-language editor and transcription specialist operating in Mode B.
Your purpose is to take a raw Mandarin Chinese ASR transcript and transform it into a clean, accurate, and professionally polished document.
This mode is ONLY for Modern Standard Chinese (Mandarin). For any other language or Chinese dialect, you must refuse to use this mode.

=== OUTPUT HEADER (print once at the top) ===
免責聲明：本翻譯／轉寫由自動系統產生，可能因口音、方言、背景雜音、語速、重疊語音、錄音品質或上下文不足等因素而不完全準確。請務務必自行複核與修訂。本服務對因翻譯或轉寫錯誤所致之任何損失、損害或責任，概不負擔。
說明：括號（）與方括號[] 內的內容為系統為協助理解、整理與釐清而加入，非原文內容。

//// 以下是您的中文逐字稿 //// 客服聯係 HELP@VOIXL.COM
 ///// 感謝您的訂購與支持 /////

（在上述標頭後留兩個空行再開始輸出）

=== 格式（為每個句子／自然單位重複此結構）===

[此處直接放置 ASR 輸出轉寫成的**繁體中文**逐字稿。**不要**加上任何前綴。每句話自成一行。]

（可選）備註：[此處放置簡潔、客觀且有價值的註釋。此行**必須以「備註：」作為開頭**。]

（空一行後，處理下一句）

=== 指導原則 (Guiding Principles) ===

1.  **絕對忠實 (Absolute Fidelity)**
    * **逐字對應**：轉寫內容必須與 ASR 的原始語義逐字對應。不可捏造、刪改、或任意重組句子。
    * **保留原貌**：保留口吃、重複詞、以及原文中已存在的 \`[雜音]\`、\`[重疊]\` 等標記。不要人為新增此類標記。

2.  **優化轉寫 (Optimized Transcription)**
    * **繁體轉換**：若 ASR 輸出為簡體字，僅做字形轉換為繁體中文，不更改地區用詞（例如，「视频」轉為「視頻」，而非「影片」）。
    * **標點符號**：根據語氣和停頓，使用正確、全形的中文標點符號，如「，」「。」「？」。
    * **外語處理**：如遇外語詞，可直接保留原文，並在詞後以括號加上**中文釋義**，例如 \`เราต้องไป check-in（辦理登記）\`。括號內不得出現外語。

3.  增值註釋 (Value-Added Annotation)
    * **核心原則**：克制與精準。註釋的唯一目的是**防止讀者對句子的核心意義產生嚴重誤解**。
    * **判斷標準**：在新增備註前，先判斷：「如果沒有這條註釋，一般聽眾是否會完全無法理解這句話，或理解成完全錯誤的意思？」如果答案為否，則**不要**新增備註。
    * **避免百科全書式解釋**：對於特定領域（如宗教、科技、法律）的專有名詞，只要它在上下文中不產生歧義，就**不應**加以解釋。註釋不是為了教學，而是為了釐清。
    * **精準使用情境**：
        * **釐清關鍵歧義**：數字發音不清、日期格式含糊。
        * **標示重大不確定性**：人名／地名發音或寫法存疑，且該人物／地點是句子的關鍵主體。
        * **解釋極度罕見且影響理解的詞**：僅限於那些如果不知道意思，整個句子就無法理解的非通用詞彙。

4.  **禁止事項 (Strict Prohibitions)**
    * 嚴禁使用 \`【?…?】\` 或類似的不確定標記。
    * 嚴禁使用破折號 (\`—\` 或 \`——\`)。

=== INPUT ===
你將在單一 <source>…</source> 區塊內收到全文。只打印一次標頭，然後嚴格遵循上述格式與原則，產出專業、清晰、且附有洞見的中文逐字稿。
`;
  }

  // Mode A
  return `
You are an expert transcription and translation assistant operating in Mode A.
Your primary goal is to produce a clean, accurate, and highly readable translation.
This mode is for ANY source that is NOT Modern Standard Chinese (Mandarin), including all foreign languages and Chinese dialects.

=== OUTPUT HEADER (print once at the top) ===
免責聲明：本翻譯／轉寫由自動系統產生，可能因口音、方言、背景雜音、語速、重疊語音、錄音品質或上下文不足等因素而不完全準確。請務必自行複核與修訂。本服務對因翻譯或轉寫錯誤所致之任何損失、損害或責任，概不負擔。
說明：括號（）與方括號[] 內的內容為系統為協助理解、整理與釐清而加入，非原文內容。

//// 以下是您的中文逐字稿 //// 客服聯係 HELP@VOIXL.COM
 ///// 感謝您的訂購與支持 /////

（在上述標頭後留兩個空行再開始輸出）

=== FORMAT（對每個句子／自然單位重複）===
直接放置逐字輸出 ASR 的原句（不要再包任何括號或符號；保留口吃、贅詞；若原句自帶噪音標記如 [雜音]、[重疊]，原樣保留）

（留一個空行）

翻譯：以繁體中文進行**通順且忠實的翻譯**。翻譯應自然流暢，易於閱讀。

（可選）備註：**僅在絕對必要時**提供簡短、客觀、有效的補充，例如：
- 語義含糊，建議核對。
- 數字發音不清，建議核對。
- 人名／地名發音或寫法存疑。
- [重疊]／[雜音] 等嚴重影響內容準確性。

（可選）清整版：僅當原文口語贅詞或雜訊極多，嚴重影響閱讀時，提供更精煉的中文版本（非法律或事實依據）。

（留一個空行後，處理下一句）

=== CORE RULES ===

1.  **忠實原文**：原文行必須與 ASR 輸出逐字一致；不可捏造、刪改或任意拆分。

2.  **翻譯原則：以自然為先**
    - 翻譯為繁體中文，追求「信、達、雅」（忠實、流暢、典雅）的平衡。
    - **首要目標是可讀性**。避免過度直譯導致的生硬文體。

3.  **括號（註釋）使用原則：克制與精準**
    - **核心目的**：註釋是為了**釐清關鍵資訊或消除歧義**，而非干擾閱讀。
    - **禁止過度註釋**：**絕不**為常見人名（如 John, Maria）、地名（如 New York, Tokyo）、組織名（如 Google, Toyota）等普遍知曉的專有名詞加上註釋。
    - **精準使用情境**：只在以下情況考慮使用（原文）或（中文釋義）註釋：
        - **專業術語或技術縮寫** (例如：API, a
          RESTful API)
        - **非通用或可能混淆的特定名稱** (例如：一個小型、不知名的公司或產品)
        - **詞語在該上下文有多重含義，需要澄清**

4.  **標記處理**：
    - \`[雜音]\`, \`[重疊]\` 等標記僅保留在「原文行」。
    - 除非 \`[聽不清]\` 嚴重破壞關鍵資訊（如 \`序號是 73[聽不清]9\`），否則不要將其帶入「翻譯」行。

5.  **其他**：
    - 絕不使用 \`【?…?】\`\`—\`或 \`——\` 標記。若詞義不清，請在「備註」中說明。
    - 嚴禁使用破折號

=== INPUT ===
你將在單一 <source>…</source> 區塊內收到全文。只打印一次標頭，然後嚴格遵循上述格式與原則，產出專業、乾淨的逐字稿。
`;
}

// ---------- GPT call using Responses API + SDK Chat fallback ----------
async function gptTranslateFaithful(originalAll, requestId, mode = 'A', includeHeader = true) {
  const systemPrompt = buildSystemPrompt(mode, includeHeader);
  const preferred = process.env.TRANSLATION_MODEL || "gpt-5-mini";

  try {
    const resp = await openai.responses.create({
      model: preferred,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content: [{ type: "input_text", text: `<source>\n${originalAll || ""}\n</source>` }] },
      ],
    });

    const out =
      (resp.output_text && resp.output_text.trim()) ||
      (Array.isArray(resp.output)
        ? resp.output
            .flatMap(o => (o?.content || []))
            .map(c => (typeof c?.text === "string" ? c.text : ""))
            .join("")
            .trim()
        : "");

    if (out) return out;
    await addStep(requestId, `Responses output empty from ${preferred}; falling back.`);
  } catch (e) {
    const msg = e?.message || String(e);
    await addStep(requestId, `Responses API failed (${preferred}): ${msg}; falling back.`);
  }

  // SDK Chat fallback (no axios)
  const chatCandidates = ["gpt-4.1-mini", "gpt-4o-mini"];
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: `<source>\n${originalAll || ""}\n</source>` },
  ];
  for (const model of chatCandidates) {
    try {
      const r = await openai.chat.completions.create({
        model, temperature: 0, messages
      });
      const out = r.choices?.[0]?.message?.content?.trim();
      if (out) {
        if (model !== preferred) await addStep(requestId, `Used fallback chat model: ${model}`);
        return out;
      }
      await addStep(requestId, `Chat output empty from ${model}; trying next.`);
    } catch (e) {
      await addStep(requestId, `Chat API exception (${model}): ${e?.message || e}`);
    }
  }

  return "【翻譯暫不可用：已附上原文】\n\n" + (originalAll || "");
}

// ---------- sanitizer to enforce your rules ----------
function sanitizeForDelivery(s) {
  if (!s) return s;
  let out = String(s);

  // 1) remove 【? … ?】 blocks entirely -> keep inner text
  out = out.replace(/【\s*\?+\s*([^】]+?)\s*\?+\s*】/g, "$1");

  // 2) ban em-dashes — / ——  -> replace with ； (Chinese semicolon)
  out = out.replace(/—+/g, "；");

  // 3) if a whole line is wrapped in [ ... ], drop the brackets
  out = out.replace(/^\[([^\[\]]+)\]\s*$/gm, "$1");

  return out;
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

    // compute duration & keep per-part seconds
    async function getSeconds(filePath) {
      return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, meta) => {
          if (err) return reject(err);
          resolve(Number(meta?.format?.duration) || 0);
        });
      });
    }
    let jobSeconds = 0;
    const partSeconds = [];
    for (const p of parts) {
      const s = Math.round(await getSeconds(p));
      partSeconds.push(s);
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

    // Stitch segments chronologically (Gemini suggestion)
    let allSegments = [];
    let offset = 0;
    for (let i = 0; i < results.length; i++) {
      const verbose = results[i] || {};
      const segs = Array.isArray(verbose?.segments) && verbose.segments.length
        ? verbose.segments
        : [{ start: 0, end: partSeconds[i] || 0, text: verbose?.text || "" }];
      for (const seg of segs) {
        allSegments.push({
          start: (Number(seg.start) || 0) + offset,
          end: (Number(seg.end) || 0) + offset,
          text: String(seg.text || ""),
        });
      }
      offset += partSeconds[i] || 0;
      if (!language && verbose?.language) language = verbose.language;
    }
    allSegments.sort((a, b) => a.start - b.start);

    // Group consecutive segments by inferred script/language
    const blocks = [];
    for (const seg of allSegments) {
      const kind = guessLangFromText(seg.text);
      const last = blocks[blocks.length - 1];
      if (last && last.kind === kind) {
        last.text += (last.text ? " " : "") + seg.text;
      } else {
        blocks.push({ kind, text: seg.text });
      }
    }

    // Build ORIGINAL text (raw, chronological)
    const originalAll = allSegments.map(s => s.text).join("\n\n");

    // Decide per-block Mode and translate
    let zhTraditional = "";
    if (blocks.length === 0) {
      // fallback: behave like before
      const topDecision = decideChinese([language || ""], originalAll);
      const mode = (forceMode === 'A' || forceMode === 'B')
        ? forceMode
        : (topDecision.isChinese ? 'B' : 'A');
      addStep(requestId, `Mode decision (fallback): ${mode}`);
      const translated = await gptTranslateFaithful(originalAll, requestId, mode, true);
      zhTraditional = sanitizeForDelivery(translated);
    } else {
      addStep(requestId, `Blocks: ${blocks.length} (script-informed)`);
      const pieces = [];
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        // Decide mode for this block
        let mode = 'A';
        if (b.kind === 'zh') {
          mode = looksDialectChinese(b.text) ? 'A' : 'B';
        } else {
          mode = 'A';
        }
        const includeHeader = (i === 0); // only first block prints header
        addStep(requestId, `Block ${i + 1}/${blocks.length}: kind=${b.kind}, mode=${mode}, chars=${b.text.length}`);
        const out = await gptTranslateFaithful(b.text, requestId, mode, includeHeader);
        pieces.push(sanitizeForDelivery(out));
      }
      zhTraditional = pieces.join("\n\n");
    }

    // email with attachments (Fix 5)
    const localStamp = fmtLocalStamp(new Date());
    const emailSubject = (blocks.some(b => b.kind === 'zh') && !blocks.some(b => b.kind !== 'zh'))
      ? '您的中文逐字稿（原文＋備註）'
      : '您的逐字稿（原文＋繁體中文翻譯）';
    const headerZh = (blocks.some(b => b.kind === 'zh') && !blocks.some(b => b.kind !== 'zh'))
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

    // save to PHP so dashboard download buttons work
    await storeTranscript(requestId, attachmentText, docxBuffer);

    // insert transcriptions row
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
        fileSizeMB,
        language || "",
        requestId,
        Date.now() - started,
        true,
        "",
        model,
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
      job_id: jobId || "",
      token: token || "",
      duration_sec: jobSeconds,
      charged_seconds: jobSeconds,
      language: language || "",
      finished_at: new Date().toISOString(),
    });
    await updateStatus(requestId, "succeeded", jobSeconds);
    await setJobStatus(requestId, "done");
    addStep(requestId, "✅ Done");
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
    for (const f of Array.from(tempFiles)) {
      try {
        if (f && fs.existsSync(f)) fs.unlinkSync(f);
      } catch {}
    }
  }
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

    // Respond first so frontend doesn't see DB blips
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

        // Fix 3: read QA overrides
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
// <<< FIX: capture server and relax default Node timeouts
const server = app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));
server.requestTimeout = 0;        // no overall per-request timeout
server.headersTimeout = 0;        // allow slow clients to send headers
server.keepAliveTimeout = 60_000;
