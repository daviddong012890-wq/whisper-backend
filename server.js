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
import OpenAI from "openai"; // ← NEW

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
// CHANGED: send request_id (not job_id)
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
 *  Ensure required tables exist (auto-migrate on boot)
 *  - jobs           (requestid, status, steps jsonb, error, created_at)
 *  - transcriptions (columns your code writes to)
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
      id                 BIGSERIAL PRIMARY KEY,
      timestamputc       TIMESTAMPTZ NOT NULL,
      timestamplocal     TEXT NOT NULL,
      email              TEXT NOT NULL,
      jobseconds         INTEGER NOT NULL,
      cumulativeseconds  INTEGER NOT NULL,
      minutes            INTEGER NOT NULL,
      cumulativeminutes  INTEGER NOT NULL,
      filename           TEXT NOT NULL,
      filesizemb         NUMERIC(10,2) NOT NULL,
      language           TEXT NOT NULL,
      requestid          TEXT NOT NULL,
      processingms       INTEGER NOT NULL,
      succeeded          BOOLEAN NOT NULL,
      errormessage       TEXT NOT NULL,
      model              TEXT NOT NULL,
      filetype           TEXT NOT NULL
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

// ---------- keep-alive axios for OpenAI (reduces "socket hang up") ----------
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

// ---------- OpenAI (Whisper) ----------
async function openaiTranscribeVerbose(audioPath, requestId) {
  // === CHANGE START: AbortController per-call timeout (industry standard) ===
  const PER_CALL_MS = Number(process.env.WHISPER_CALL_TIMEOUT_MS || 360_000); // 6 minutes
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_CALL_MS);
  // === CHANGE END ===

  try {
    const fd = new FormData();
    fd.append("file", fs.createReadStream(audioPath), {
      filename: path.basename(audioPath),
    });
    fd.append("model", "whisper-1");
    fd.append("response_format", "verbose_json");
    fd.append("temperature", "0");

    const r = await axiosOpenAI.post(
      "https://api.openai.com/v1/audio/transcriptions",
      fd,
      {
        // === CHANGE START: make call abortable & throw on non-2xx ===
        signal: controller.signal,
        validateStatus: (s) => s >= 200 && s < 300,
        // === CHANGE END ===
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
    clearTimeout(timer); // === CHANGE: always clear timer
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
        code === "ERR_CANCELED"; // ← CHANGE: retry on AbortController abort

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

// ---------- OpenAI SDK client (for Responses API) ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); // ← NEW

// ---------- GPT translation (Responses API + fallbacks) ----------
async function gptTranslateFaithful(originalAll, requestId) {
  const systemPrompt = `
[任務：專業級轉寫內容翻譯（含二度校對）]

1) 角色設定（Persona）
- 你是頂尖的繁體中文（台灣）本地化專家與資深筆譯員。你的工作是將原文（常為口語逐字稿）以中文母語者的方式，做出忠實、通順、可於法律／新聞／學術等嚴肅場合使用的翻譯；不得新增虛構資訊。
- 你是一位資深筆譯員，擅長將任何語言的原文轉化為繁體中文，用字精準、語氣自然，可直接用於法律、新聞、學術等正式場合。請忠實呈現原意，不得增刪、臆測或評論。

2) 核心任務（Core Task）
僅翻譯 <source>...</source> 內的內容（不論語言）。輸出必須為繁體中文（台灣慣用），並嚴格遵守下列規則與流程。

3) 兩階段流程（必做）
A. 初稿：依規則產生完整譯文草稿。
B. 二度校對：通讀初稿，逐項檢查並必要時修正：
   - 連貫性與邏輯（指代、時態、主詞一致）
   - 專有名詞與固定用語前後一致
   - 口號／標語的自然節奏
   - 數字、單位、日期、貨幣格式
   - 禁止破折號與連字號是否落實
   - 分段與空白是否符合規範
   完成後，僅輸出「第二次校對後的最終譯文」，不得輸出草稿或任何說明。

4) 詳細規則（Instructions）

A. 核心原則：忠實與中性
- 忠實轉譯：讓語言如鏡，忠實映照原意，不添一筆、不減一字、不妄加評斷。唯在語序或語法無法直譯時，方可輕微調整，使語句得以自然落地。直譯為先，意譯為後，讓原文的呼吸在譯文中延續。
- 中性客觀：保持語言的中性與客觀，如霧中之影，不偏不倚。對於無法確定的親屬或社交關係，請以中性詞處理，使語言既不失準確，也不涉情感投射。讓每一個稱謂都如水般包容，不濁不斷。

B. 內容處理（Content Handling）
- 標籤清理：刪除所有時間戳 [hh:mm:ss]、(mm:ss)、0:07 等，以及說話者標籤（Speaker A:、人名：）。
- 多語混雜：除人名、地名、品牌名、組織名與技術性內容（網址、檔名、程式碼）外，外語詞彙一律譯為中文；口語中夾雜多語亦須統一譯為中文。常見縮寫（AI、DNA、Wi-Fi、USB、CPU、GPU）可保留。
- 專有名詞：有台灣通行譯名必採用；無通行譯名可保留原語，但須與中文語句自然融合。
- 方言：若夾雜粵語、上海話、台語／閩南語等，只做用字標準化與全形標點，勿改動語義。
- 重複內容：同一詞組連續出現 4 次以上，可壓縮為最多 3 次；或改為單行標記：【重複×N：詞組】（例：【重複×10：謝謝】）。
- 不確定標示：若對某處譯法信心明顯不足（約低於 80%），在該處後以【存疑：請核對】標示；避免大量濫用。

C. 格式與標點（Formatting & Punctuation）
- 破折號與連字號全面禁用：翻譯禁止用 —、–、- 表示停頓／轉折／補述。遇到原文 dash，一律改用「，」「、」或「（ ）」。連字號 - 僅可在網址、檔名、程式碼、產品型號等原樣內容中保留。
- 數字與單位（台灣慣用）：半形數字；整數用千分位（例 12,345）。數字與 SI 單位間留半形空格（5 km、20 °C）；百分比不留空格（35%）；貨幣置前（NT$ 1,200／US$ 50）；日期 YYYY/MM/DD；時間 HH:MM（24 小時制）。
- 標點與空白：使用全形標點（，。？！、「」『』）。中英混排時，在英文單字或數字兩側保留半形空格；中文文字與標點之間不得插入空格。
- 禁止裝飾：不得輸出 Markdown 標頭（#、##）或列表符號作為排版裝飾。

D. 結構與排版（Structure & Layout）
- 技術格式保留：原樣保留網址、檔名、#hashtag、@mention、Markdown／HTML 標記，以及程式碼與 LaTeX 內容（不需輸出反引號符號本身）。
- 分段與整潔：
  1) 優先尊重原文段落（段間僅一個空行）。
  2) 原文無分段或過長時，依 60–150 個全形字或 2–4 句切分。
  3) 極短句（少於 8 字，如招呼語）與相鄰句合併，除非獨立性對語氣至關重要。
  4) 不得把段落切在引號、括號或程式碼片段中間。
  5) 首尾不得有空白行；段落之間僅保留一個空行；不得連續輸出多於一個空行。

E. 口號與標語（一般規則，優先於逐詞直譯）
- 在語言的開端，請輕輕掠過那些直白的語氣開場詞；無論來自哪一種語言，無論是表驚訝、猶豫、肯定或否定的語助詞，皆不以字面翻譯處理。請以語氣的流轉、語境的節奏與標點的呼吸，讓情緒自然滲透。讓語言不說出口，卻已讓人心領神會。
- 當語句中蘊含潛能、可能性或行動的暗示時，請以自然結果補語收尾，而非僅以「能」、「可以」等抽象助詞作結。讓語言不止表態，更呈現行動的成果與情緒的落點。
- 讓語言的主體始終如一:「我」、「你」、「我們」各自承載不同的情感視角，請讓它們在句中保持一致，不混不亂。當語句如咒語般重複出現，請讓每一次回響都忠於原形;字字不改，標點不移，使語言成為儀式，而非雜音。
- 節奏 3–8 字為佳；允許用驚嘆號強化語氣，但不得新增情緒詞。
- 口號中同樣禁止破折號與連字號。

F. 英文結構轉換（易出錯，優先於逐詞直譯）
- 範圍 from A to B：譯為「從 A 到 B 都…」或並列句「在 A…，也在 B…」，避免「一路…到…」的連續行進誤讀。
- 被動 that X … by those who …：可改寫為主動句，保持語義不變（例：那些…的人，再次肯定了這項 X）。
- 長修飾名詞／關係子句：必要時拆句，再以「也、以及、並」連接；避免一逗到底。

G. 已有中文處理
- 若 <source> 內已有中文，則進行校訂與標準化：統一台灣慣用詞與全形標點，修正明顯錯別字，但不改變語義與語氣。
- 口語填充詞（嗯、哦等）可視可讀性保留或少量刪減，但不得刪除資訊點。

5) 輸出格式（Output Format）
僅輸出以下多行結構，不得輸出任何額外說明、步驟或道歉：
- 第 1 行（固定）：免責聲明：本翻譯／轉寫由自動系統產生，可能因口音、方言、背景雜音、語速、重疊語音、錄音品質或上下文不足等因素而不完全準確。請務必自行複核與修訂。本服務對因翻譯或轉寫錯誤所致之任何損失、損害或責任，概不負擔。
- 第 2 行（固定）：**********以下是您的中文逐字稿**********
- 第 3 行（固定）：（此行為空行）
- 第 4 行起：僅輸出「二度校對後的最終譯文」。嚴禁包含任何原文、<source> 或「原文」標題。若確實無可翻譯內容，輸出：【無可翻譯內容】。
`;

  const preferred = process.env.TRANSLATION_MODEL || "gpt-4o-mini";

  // Try Responses API first (works with reasoning/thinking models if enabled)
  try {
    const resp = await openai.responses.create({
      model: preferred,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content: [{ type: "input_text", text: `<source>\n${originalAll || ""}\n</source>` }] },
      ],
      // reasoning: { effort: "medium" },
      // response_format: { type: "text" },
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
    const msg = e?.response?.data?.error?.message || e?.message || String(e);
    await addStep(requestId, `Responses API failed (${preferred}): ${msg}; falling back.`);
  }

  // Fallback to Chat Completions (stable, widely available)
  const chatCandidates = ["gpt-4.1-nano", "gpt-4o-mini"];
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: `<source>\n${originalAll || ""}\n</source>` },
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
        const out = r.data?.choices?.[0]?.message?.content?.trim();
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

  // Last resort: never return blank
  return "【翻譯暫不可用：已附上原文】\n\n" + (originalAll || "");
}

// ---------- main processor ----------
async function processJob({ email, inputPath, fileMeta, requestId, jobId, token }) {
  await setJobStatus(requestId, "processing");
  await updateStatus(requestId, "processing"); // CHANGED: requestId

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

    // compute duration from encoded parts
    async function getSeconds(filePath) {
      return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, meta) => {
          if (err) return reject(err);
          resolve(Number(meta?.format?.duration) || 0);
        });
      });
    }
    let jobSeconds = 0;
    for (const p of parts) jobSeconds += await getSeconds(p);
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
        () => openaiTranscribeVerbose(filePath, requestId),
        { maxAttempts: 5, baseDelayMs: 700 }
      );
      addStep(requestId, `Part ${idx + 1}/${parts.length} → done`);
      return res;
    });
    const results = await runBounded(tasks, concurrency);

    let originalAll = "";
    for (const verbose of results) {
      if (!language && verbose?.language) language = verbose.language;
      originalAll += (originalAll ? "\n\n" : "") + (verbose?.text || "");
    }

    // zh-TW faithful translation
    addStep(requestId, "Calling GPT 原文→繁中 (faithful, multilingual) …");
    let zhTraditional = "";
    try {
      const inputForGpt = originalAll || "";
      zhTraditional = await gptTranslateFaithful(inputForGpt, requestId);
      addStep(requestId, "繁中 done.");
    } catch (_) {
      addStep(requestId, "⚠️ GPT translation failed — sending original only.");
      zhTraditional = "";
    }

    // email with attachments
    const localStamp = fmtLocalStamp(new Date());
    const attachmentText = `＝＝ 中文（繁體） ＝＝
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
            new Paragraph("＝＝ 中文（繁體） ＝＝"),
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
      subject: "您的逐字稿（原文與繁體中文）",
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
    await updateStatus(requestId, "succeeded", jobSeconds); // CHANGED: requestId
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
    await updateStatus(requestId, "processing_fail"); // CHANGED: requestId
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
        await processJob({
          email,
          inputPath: req.file.path,
          fileMeta: req.file,
          requestId,
          jobId: String(req.body?.job_id || ""),
          token: String(req.body?.token || ""),
        });
      } catch (e) {
        console.error(`[${requestId}] Background crash:`, e?.message || e);
        try {
          await setJobStatus(requestId, "error", e?.message || String(e));
          await updateStatus(requestId, "processing_fail"); // CHANGED: requestId
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
server.requestTimeout = 0;       // no overall per-request timeout
server.headersTimeout = 0;       // allow slow clients to send headers
server.keepAliveTimeout = 60_000;
