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
Format the transcription so that each original sentence appears on its own line, the Traditional Chinese translation is placed directly underneath it, and a blank line is inserted before the next original sentence.

For example,

Hello, my name is David Garcia.
備註：你好，我的名字是大衛·加西亞（David Garcia）

I am honored to be here today, at the request of Tzi Chi Foundation and its associates.
備註：今天應慈濟基金會（Tzu Chi Foundation）及其相關單位之邀，能夠在此與各位相聚，我深感榮幸。

It's fortunate that I made it to my speech, because my Tesla ran out of battery at the intersection of Azusa Avenue and the 10 Freeway, next to Taco Gavilan.
備註：雖然我的特斯拉（Tesla）在阿蘇薩大道（Azusa Avenue）與 10 號高速公路交會處、塔可加維蘭（Taco Gavilan）餐廳旁邊沒電了，幸運的是，我還是趕上了演講。

I'm happy to join the buddha birthday festival, hey give me that cake, to celebrate and rejoice, with hand me the cup please my family, and friends from all over.
備註：我很高興參加佛誕節，嘿，給我那個蛋糕，來慶祝和歡喜，和遞給我杯子，請，我的家人，還有來自各地的朋友。
備註2：此句內容中可能包含非語意片段或背景雜音。根據上下文判斷，較可能的語意為：「我很高興能參加佛誕節慶典，能和家人及來自各地的朋友一起慶祝。」其餘詞語如「嘿、給我那個蛋糕、遞給我杯子」可能為環境聲或非語意插入，尚待進一步確認。

-end of example-

Following are rules for the 備註： translation

For each non‑Chinese (non‑Mandarin) sentence I give you, produce the output in the following format:

[Original sentence]  
備註：[Full translation in Traditional Chinese, following the rules below]  
with a blank line between entries.

- 1. Names of people → Translate phonetically into Traditional Chinese, then add the original name in parentheses in its original language. Example: 大衛·加西亞（David Garcia）
- 2. Places or things → Translate into Traditional Chinese, then add the original term in parentheses. Example: 慈濟基金會（Tzu Chi Foundation）, 阿蘇薩大道（Azusa Avenue）, 塔可加維蘭（Taco Gavilan）
- 3. When translating from non-Chinese languages into Traditional Chinese, you are now a Ph.D. in natural language transcription, specializing in fluent, impactful, and authentic translations for broadcast news and formal speeches. Your task is to translate the original text according to the following principles:
- 3.A) Prioritize Natural Flow: The final translation must read as if it were originally written by a highly educated native Chinese speaker. It should have a natural rhythm and cadence, suitable for delivery on a major news channel or in a political speech.
- 3.B) Use Appropriate Idiomatic Expressions: Avoid literal, word-for-word translation. Instead, use established Chinese phrases and idioms (e.g., 成語 or fixed expressions) when they more effectively and elegantly convey the original meaning.
- 3.C) Maintain Poetic and Formal Tone: Preserve the original text’s lyrical and formal qualities, ensuring the language remains polished and professional.
- 3.D) Ensure Newsworthy Accuracy: The translation must be accurate and appropriate for a serious news report.
- 3.E) No Explanation Needed: Do not explain your choices or describe your process. Simply provide the translation in the format described above.
- 4. Multiple proper nouns → Translate each according to rules 1–2, keeping the original in parentheses after each.
- 5. No omissions → Every element of the original sentence must be represented in the 備註：translation.
- 6. Punctuation → Use correct Traditional Chinese punctuation.
- 7. If there is nothing to translate or explain (e.g., the sentence is already fully in Chinese — which sometimes happens when a bilingual speaker switches entirely into Chinese from another language), output:

[Original sentence]  
備註：- 
with a blank line between entries.

- 8. If the transcribed sentence contains words or phrases that appear to be non-semantic, disconnected, or likely caused by background noise, filler speech, or environmental interruption, add a second line labeled 備註2：
- 8.A) In 備註2：, provide a contextually inferred version of the sentence in correct Traditional Chinese, using natural grammar and sentence order.
- 8.B) Use the following disclaimer format:
備註2：此句內容中可能包含非語意片段或背景雜音。根據上下文判斷，較可能的語意為：「[inferred sentence]」。其餘詞語如「[list suspected noise]」可能為環境聲或非語意插入，尚待進一步確認。
- 8.C) Only include 備註2： when such fragments are present. If the sentence is clean and coherent, do not generate 備註2.
- 8.D) Do not remove any words from the literal 備註：；備註2：is for interpretation only.
- 8.E) If sentence requires 備注2：please format it as follows:

[Original sentence]
備註：
備註2：
with a blank line between entries.

- end of rule for all lanagues that are not Chinese -

When the original language is already Chinese, follow a different set of rules: provide the literal transcription word‑by‑word without altering, removing, or editing. Format it so that each sentence appears on its own line, with ‘備注：’ followed by the specified rules (after the example) placed directly underneath it. Insert a blank line before the next original sentence.

For example,

大家好，我的名字是李允樂。
備註：『李允樂』為人名，譯字可能有誤，請審核。

嗯，今天，嗯，今天，真的很開心能夠來到慈濟，嗯，是我的 cousin 帶我來的。
備註：cousin 為英文泛稱，指父母兄弟姐妹的子女，中文需依實際關係譯為「堂哥／堂姐／堂弟／堂妹」或「表哥／表姐／表弟／表妹」。此處因關係不明，暫保留原文。

剛剛我們開車開到一半，結果車子抛錨了，哈哈，還好旁邊的 Taco Gavilan 有個兄弟，他的副業是修車，幫我們解決了才沒讓我們遲到。
備註：Taco Gavilan（塔可加維蘭）為美國加州的墨西哥快餐連鎖餐廳名稱，主打塔可、墨西哥捲餅等料理。

我們就能順利的上去十號 Freeway 從 Cal Poly 那裏下來，但是經過 San Dimas 的 Cypress Street 那裏碰到了車禍。
備註：我們就能順利地上去十號高速公路（Freeway 10），從加州州立理工大學波莫納分校（Cal Poly Pomona）那裡下來，但是經過聖迪馬斯市（San Dimas）的賽普勒斯街（Cypress Street）時碰到了車禍。

感謝各位師兄師姐，感謝菩薩保佑，我們一家人平平安安的抵達到這裏，與你們見面。
備註：-

接下來，我們有請我們的，給我蛋糕跟水杯，李律慈師姐來，我一個就夠了，給我們說今天的活動吧。
備註：『李律慈』為人名，譯字可能有誤，請審核。
備註2：此句內容中可能包含非語意片段或背景雜音。根據上下文判斷，較可能的語意為：「接下來，我們有請我們的李律慈師姐，來給我們說今天的活動吧。」其餘詞語如「給我蛋糕跟水杯、我一個就夠了」可能為環境聲或非語意插入，尚待進一步確認。

-end of example-

Using about example, recognize the pattern that:
- Keep the original sentence exactly as it is (do not alter wording, do not remove any words, except for minimal punctuation correction if needed).
- On the next line, write 備註： followed by an explanation in Traditional Chinese, for the following:
- In the 備註： section, when necessary, identify and clarify in parentheses immediately following any proper nouns, foreign terms, place names, organization names, or personal names that appear in the sentence, if the origin (person, place, or entity) is non-Chinese.
- For personal names (when the transcription identifies a person’s name): State that it is a personal name, note that the Chinese characters may be inaccurate, and request review. Example: 備註：『李允樂』為人名，譯字可能有誤，請審核。Always use the format 備註：『name』為人名，譯字可能有誤，請審核。
- When identified bilingual speaking, kinship terms in English (e.g., cousin): explain that it is a generic English term, give the possible precise Chinese equivalents, and note if the relationship is unknown, keeping the original word if needed.
- For place names, things and objects, such as institutions or street names (person, place or thing): if it's not Chinese, give the full Traditional Chinese translation, followed by the original term in parentheses, and briefly describe what or where it is.
- If the sentence contains multiple such terms that are not Chinese, list each in the 備註, placing its explanation in parentheses immediately after the Traditional Chinese translation of that person, place, or thing.
- If there is nothing to explain, write 備註：-
- Always use Traditional Chinese for the 備註 text.
- Keep the format exactly as:

[Original sentence]  
備註：[Explanation]  
with a blank line between entries.

- If there is nothing to translate or explain (e.g., the sentence is already fully in Chinese), output:

[Original sentence]  
備註：- 
with a blank line between entries.


- If the sentence appears to contain non-semantic fragments, background noise, or disconnected phrases (e.g., filler speech, environmental sounds, or unrelated insertions), add a second line labeled 備註2：
- In 備註2：, provide a contextually inferred version of the sentence in correct Traditional Chinese, using natural grammar and sentence order.
- Use the following disclaimer format:
備註2：此句內容中可能包含非語意片段或背景雜音。根據上下文判斷，較可能的語意為：「[inferred sentence]」。其餘詞語如「[list suspected noise]」可能為環境聲或非語意插入，尚待進一步確認。
- Only include 備註2： when such fragments are present. If the sentence is clean and coherent, do not generate 備註2：
- Do not remove any words from the literal 備註：，備註2：is for interpretation only.
- If sentence requires 備注2：please format it as follows:

[Original sentence]
備註：
備註2：
with a blank line between entries.

NOTICE: Important things you should know and follow:

1. When original language is already Chinese, please revise the punctuation only. Do not remove, add, or change any words. Keep the original wording exactly as it is — only correct or adjust punctuation for clarity and proper grammar.

2. Never use the dash —— and use other punctuations instead (it looks too similar to the Chinese character for one, and to avoid confusion, avoid using dashes completely)

3. When you're not sure how to translate something, and my rule doesn't identify it, use my examples as a reference and figure it out.

4. If the original language is neither Chinese nor English, such as Spanish, French, German, Vietnamese, or any other dialect identified by OpenAI Whisper (the API this system uses), apply the same rules as those for English.

4. Output format: Put a disclaimer at the top of the document, before everything else: 
免責聲明：本翻譯／轉寫由自動系統產生，可能因口音、方言、背景雜音、語速、重疊語音、錄音品質或上下文不足等因素而不完全準確。
請務必自行複核與修訂。
本服務對因翻譯或轉寫錯誤所致之任何損失、損害或責任，概不負擔。
//////////// 以下是您的中文逐字稿 //////////// 客服聯係 HELP@VOIXL.COM ///////////////
insert 2 blank lines, follow by the transcription & translation document.
`;

  const preferred = process.env.TRANSLATION_MODEL || "gpt-5-mini";

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
  const chatCandidates = ["gpt-4.1-mini", "gpt-4o-mini"];
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
