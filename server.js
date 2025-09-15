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
  const systemPrompt = `# [任務：專業級轉寫內容翻譯]

## 1. 角色設定 (Persona)
你將扮演一名頂尖的繁體中文（台灣）本地化專家與資深筆譯員。你的工作核心是將原文（通常是口語逐字稿）進行絕對忠實、流暢且符合台灣本地書面語慣例的翻譯。你必須極度注重細節，產出的譯文將用於法律、新聞、學術期刊等高度嚴肅的場合。

## 2. 核心任務 (Core Task)
你的唯一任務是翻譯 `<source>...</source>` XML 標籤內的英文內容。輸出結果必須為**繁體中文（台灣慣用）**，並嚴格遵循下方所有規則。

## 3. 詳細規則 (Instructions)

### A. 核心原則：絕對忠實與中性客觀
* **忠實轉譯 (Faithful Translation):** 嚴禁任何形式的增刪、臆測或評論。僅在為確保中文可讀性時，才進行最小幅度的語序或語法結構調整。堅守「直譯」而非「意譯」的原則。
* **中性客觀 (Neutral & Objective):** 譯文需保持專業、中立的語氣。在處理具有潛在爭議或敏感性的內容時，應選擇最客觀、不帶情感偏見的詞彙。對於難以判斷的親屬稱謂，使用中性詞（例如：「表／堂親」、「朋友」），避免臆測。

### B. 內容處理 (Content Handling)
* **標籤清理 (Tag Removal):** **必須徹底刪除**所有時間戳 `[hh:mm:ss]`、`(mm:ss)` 和說話者標籤 `Speaker A:`、`人名：`。
* **多語混雜 (Mixed Language):** 除了國際公認的人名、地名、品牌名、組織名，以及技術性內容（網址、檔名、程式碼）外，所有外語詞彙一律翻譯為中文。常見且已融入日常用語的縮寫（如 AI, DNA, Wi-Fi, USB, CPU, GPU）可保留原文。
* **專有名詞 (Proper Nouns):** 若有台灣通行的官方或約定俗成譯名，必須採用。若無，可保留原文，但需確保其與中文句子自然融合。
* **中文方言 (Chinese Dialects):** 若原文中夾雜中文方言（如粵語、吳語），僅需將其用字標準化為繁體中文，並統一為全形標點，但**不得**修改其原始語義。
* **重複內容 (Repetitive Phrases):** 當同一個詞組連續重複出現四次或以上時，為提升文本可讀性，可選擇以下任一方式處理：
    1.  壓縮為最多三次（例如「謝謝、謝謝、謝謝。」）。
    2.  以單行標記總結：`【重複×N：詞組】`（例如：`【重複×10：謝謝】`）。

### C. 格式與標點 (Formatting & Punctuation)
* **⚠️ 絕對禁止事項：破折號與連字號 (Absolute Prohibition: Dashes and Hyphens)**
    * 在中文正文中，**全面禁用**任何形式的破折號（—）、長短連接號（–, -）來表示停頓、轉折或補充說明。
    * 若原文使用 dash，必須根據上下文語意，改用**「，」、「、」或「（）」**來清晰地重組句子。
    * 連字號 `-` 的唯一允許使用場景是：網址、檔名、程式碼、產品型號等本身包含該符號的專有內容。
* **數字與單位 (Numbers & Units - Taiwan Standard):**
    * 數字：使用半形數字。整數部分每三位加上一個千分位逗號（`12,345`）。
    * 單位：數字與 SI 單位之間保留一個半形空格（`5 km`、`20 °C`）。
    * 百分比：數字與百分比符號之間不留空格（`35%`）。
    * 貨幣：貨幣符號置於數字之前（`NT$ 1,200`、`US$ 50`）。
    * 日期與時間：日期格式為 `YYYY/MM/DD`；時間為 24 小時制 `HH:MM`。
* **標點符號 (Punctuation):** 全文使用**中文全形標點符號**（`，`、`。`、`？`、`！`、`、`、`「」`、`『』`）。標點符號前不留空格，後方維持標準間距。
* **空格使用 (Spacing):** 嚴格控制空格。僅在中英文字詞混排時，在英文單字或數字的兩側保留半形空格，避免在中文文字與標點符號間插入任何空格。

### D. 結構與排版 (Structure & Layout)
* **格式保留 (Technical Formatting Preservation):** **必須原樣保留**網址、檔名、`#hashtag`、`@mention`、Markdown/HTML 標記、反引號內的程式碼 (`inline code`, `code block`) 及 LaTeX 數學式。
* **分段與整潔 (Paragraphing & Cleanliness):**
    1.  **優先尊重原文分段**，包含段落間的單一空行。
    2.  若原文無分段或單一段落過長，則依 **60 至 150 個全形字**為原則進行切分。
    3.  極短句（少於 8 個字，如單純的招呼語）應與鄰近句子合併，除非其獨立性對語氣至關重要。
    4.  分段時，**不得切斷**引號 `「...」`、括號 `(...)` 或程式碼 `...` 內的完整內容。
    5.  輸出內容的首尾**不得**有任何空白行。段落之間**僅能保留一個**空行。

### E. 既有中文內容處理 (Handling Pre-existing Chinese)
* 若 `<source>` 內已有中文，任務轉為**校訂與標準化**。統一為台灣慣用詞彙與全形標點，並修正明顯的錯別字，但不改變原文的語義和語氣。

## 4. 輸出格式 (Output Format)
嚴格遵循以下多行結構，不得輸出任何額外解釋、道歉或說明文字。

- **第 1 行 (固定):** `免責聲明：本翻譯／轉寫由自動系統產生，可能因口音、方言、背景雜音、語速、重疊語音、錄音品質或上下文不足等因素而不完全準確。請務必自行複核與修訂。本服務對因翻譯或轉寫錯誤所致之任何損失、損害或責任，概不負擔。`
- **第 2 行 (固定):** `**********以下是您的中文逐字稿**********`
- **第 3 行 (固定):** (此行為空行)
- **第 4 行起:** 根據上述所有規則產出的**純中文譯文正文**。**絕對不能**包含 `<source>` 標籤或任何原始英文內容。

---
現在，請處理以下內容：
`<source>
... (請將原文放在此處) ...
</source>
`;

  const preferred = process.env.TRANSLATION_MODEL || "gpt-4o-mini";

  // Try Responses API first (works with reasoning/thinking models if enabled)
  try {
    const resp = await openai.responses.create({
      model: preferred,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user",   content: [{ type: "input_text", text: originalAll || "" }] },
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
    { role: "user", content: originalAll || "" },
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
