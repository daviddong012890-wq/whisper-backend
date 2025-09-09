import express from "express";
import cors from "cors";
import multer from "multer";
import { promises as fs } from "fs";
import { statSync, existsSync, readdirSync, createReadStream } from "fs";
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

// ===================================================================================
//
//                              CONFIGURATION & SETUP
//
// ===================================================================================

/**
 * Centralized configuration object.
 * Reads from environment variables and provides sensible defaults.
 */
const config = {
  // Service URLs & Keys
  consumeUrl: process.env.CONSUME_URL || "",
  callbackUrl: process.env.CALLBACK_URL || "",
  workerSharedKey: process.env.WORKER_SHARED_KEY || "",
  openaiApiKey: process.env.OPENAI_API_KEY,

  // Nodemailer (Gmail)
  gmailUser: process.env.GMAIL_USER,
  gmailPass: process.env.GMAIL_PASS,
  fromEmail: process.env.FROM_EMAIL || process.env.GMAIL_USER,
  fromName: process.env.FROM_NAME || "逐字稿產生器",

  // Upload & File Handling
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 1.5 * 1024 * 1024 * 1024), // 1.5 GB
  openAiAudioMax: 25 * 1024 * 1024, // OpenAI's hard limit (25 MB)
  targetMaxBytes: 24 * 1024 * 1024, // Our target size, just under the limit

  // Ffmpeg Audio Processing
  minSegSeconds: 420, // 7 min
  maxSegSeconds: 900, // 15 min
  defaultSegSeconds: 900,

  // Concurrency & Timeouts
  whisperConcurrency: Number(process.env.WHISPER_CONCURRENCY || 3),
  axiosTimeout: 120000, // 120 seconds

  // Database
  databaseUrl: process.env.DATABASE_URL || "",
  dbHost: process.env.DB_HOST || "",
  dbPort: Number(process.env.DB_PORT || 5432),
  dbUser: process.env.DB_USER || "",
  dbPass: process.env.DB_PASS || "",
  dbName: process.env.DB_NAME || "",
  dbSsl: (process.env.DB_SSL || "true").toLowerCase() === "true",

  // App Behavior
  localTz: process.env.LOCAL_TZ || "America/Los_Angeles",
};

/**
 * Exits the process if a critical environment variable is missing.
 * @param {string} m - The error message.
 */
function fatal(m) {
  console.error("❌ " + m);
  process.exit(1);
}

// --- Critical Config Validation ---
if (!config.openaiApiKey) fatal("Missing OPENAI_API_KEY");
if (!config.gmailUser || !config.gmailPass) fatal("Missing GMAIL_USER or GMAIL_PASS");

// --- Express App Setup ---
const app = express();
const allowedOrigins = ["https://voixl.com", "https://www.voixl.com"];
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

// --- Multer Setup (for file uploads) ---
const upload = multer({
  dest: "/tmp",
  limits: { fileSize: config.maxUploadBytes },
  fileFilter: (_req, file, cb) => {
    const ok =
      (file.mimetype || "").startsWith("audio/") ||
      (file.mimetype || "").startsWith("video/");
    if (!ok) return cb(new Error("Only audio/video files are allowed."));
    cb(null, true);
  },
});
ffmpeg.setFfmpegPath(ffmpegStatic);

// --- Database Pool ---
const poolConfig = config.databaseUrl
  ? {
      connectionString: config.databaseUrl,
      ssl: config.dbSsl ? { rejectUnauthorized: false } : undefined,
    }
  : {
      host: config.dbHost,
      port: config.dbPort,
      user: config.dbUser,
      password: config.dbPass,
      database: config.dbName,
      ssl: config.dbSsl ? { rejectUnauthorized: false } : undefined,
    };
const pool = new Pool({ ...poolConfig, max: 10 });

// --- Nodemailer Transport ---
const mailer = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: { user: config.gmailUser, pass: config.gmailPass },
});

// --- Keep-Alive Axios Instance for OpenAI ---
const axiosOpenAI = axios.create({
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 50 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50 }),
  timeout: config.axiosTimeout,
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
  headers: { Connection: "keep-alive", Accept: "application/json" },
});


// ===================================================================================
//
//                                  UTILITY FUNCTIONS
//
// ===================================================================================

const statBytes = (p) => { try { return statSync(p).size; } catch { return 0; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secsToSheetMinutes = (sec) => Math.max(1, Math.ceil((sec || 0) / 60));

/**
 * Formats a date into a human-readable local timestamp.
 * @param {Date} d - The date object to format.
 * @returns {string} The formatted date string (e.g., 'Sep 8, 2025, 11:33:00 PM').
 */
function fmtLocalStamp(d) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: config.localTz,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(d);
}

/**
 * Wraps an async function with exponential backoff retry logic.
 * @param {Function} fn - The async function to execute.
 * @param {object} options - maxAttempts and baseDelayMs.
 * @returns {Promise<any>} The result of the successful function call.
 */
async function withRetries(fn, { maxAttempts = 5, baseDelayMs = 700 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      const s = e?.response?.status;
      const retriable = s === 429 || (s >= 500 && s < 600) || e.code === "ECONNRESET" || e.code === "ETIMEDOUT";
      if (!retriable || attempt >= maxAttempts) throw e;
      const delay = Math.floor(baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 250);
      await sleep(delay);
    }
  }
}

/**
 * Runs a set of async tasks with a concurrency limit.
 * @param {Array<Function>} tasks - An array of zero-argument functions that return promises.
 * @param {number} limit - The maximum number of tasks to run concurrently.
 * @returns {Promise<Array<any>>} An array of results in the same order as the tasks.
 */
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

/**
 * Asynchronously deletes a set of files, ignoring any errors.
 * @param {Set<string>} fileSet - A set of file paths to delete.
 * @param {string} requestId - The ID of the job for logging.
 */
async function cleanupFiles(fileSet, requestId) {
  const cleanupPromises = Array.from(fileSet).map(file => {
    if (file) {
      return fs.unlink(file).catch(err => {
        console.warn(`[${requestId}] Failed to delete temp file ${file}:`, err.message);
      });
    }
  });
  await Promise.all(cleanupPromises);
}


// ===================================================================================
//
//                             DATABASE & SCHEMA MGMT
//
// ===================================================================================

/**
 * Ensures the 'jobs' and 'transcriptions' tables exist in the database.
 */
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      requestid  TEXT PRIMARY KEY,
      status     TEXT NOT NULL,
      steps      JSONB NOT NULL DEFAULT '[]'::jsonb,
      error      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcriptions (
      id                BIGSERIAL PRIMARY KEY,
      timestamputc      TIMESTAMPTZ NOT NULL,
      timestamplocal    TEXT NOT NULL,
      email             TEXT NOT NULL,
      jobseconds        INTEGER NOT NULL,
      cumulativeseconds INTEGER NOT NULL,
      minutes           INTEGER NOT NULL,
      cumulativeminutes INTEGER NOT NULL,
      filename          TEXT NOT NULL,
      filesizemb        NUMERIC(10,2) NOT NULL,
      language          TEXT NOT NULL,
      requestid         TEXT NOT NULL,
      processingms      INTEGER NOT NULL,
      succeeded         BOOLEAN NOT NULL,
      errormessage      TEXT NOT NULL,
      model             TEXT NOT NULL,
      filetype          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trans_email ON transcriptions(email);
    CREATE INDEX IF NOT EXISTS idx_trans_reqid ON transcriptions(requestid);
    CREATE INDEX IF NOT EXISTS idx_trans_succeeded ON transcriptions(succeeded);
  `);
  console.log("✅ Schema ready (jobs, transcriptions)");
}

// --- DB Helper Functions ---
async function createJob(id) {
  const step = { at: new Date().toISOString(), text: "Job accepted by server." };
  await pool.query(
    `INSERT INTO jobs (requestid, status, steps, created_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (requestid) DO UPDATE SET status = EXCLUDED.status, steps = EXCLUDED.steps`,
    [id, "accepted", JSON.stringify([step])]
  );
  console.log(`[${id}] Job created in database.`);
}

async function addStep(id, text) {
  const step = { at: new Date().toISOString(), text };
  await pool.query(
    `UPDATE jobs SET steps = COALESCE(steps, '[]'::jsonb) || $1::jsonb WHERE requestid = $2`,
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


// ===================================================================================
//
//                        EXTERNAL NOTIFICATION SERVICES (PHP)
//
// ===================================================================================

async function consume(payload) {
  if (!config.consumeUrl) return;
  try {
    await axios.post(config.consumeUrl, payload, {
      headers: config.workerSharedKey ? { "X-Worker-Key": config.workerSharedKey } : {},
      timeout: 10000,
    });
    console.log("→ consume() POST ok");
  } catch (e) {
    console.error("consume() error:", e?.response?.status || "", e?.message || e);
  }
}

async function updateStatus(jobId, status, durationSec = 0) {
  if (!config.callbackUrl) return;
  try {
    await axios.post(
      config.callbackUrl,
      new URLSearchParams({
        job_id: jobId,
        status: status,
        duration_sec: durationSec.toString(),
      }),
      {
        headers: {
          "X-Worker-Key": config.workerSharedKey,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 10000,
      }
    );
    console.log(`→ updateStatus(${jobId}, ${status}) ok`);
  } catch (err) {
    console.error("updateStatus error:", err?.response?.status, err?.message || err);
  }
}


// ===================================================================================
//
//                          CORE JOB PROCESSING WORKFLOW
//
// ===================================================================================

// ---------------------------
// --- STEP 1: PREPARE AUDIO ---
// ---------------------------

function ffprobeDurationSeconds(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return reject(err);
      resolve(Number(meta?.format?.duration) || 0);
    });
  });
}

function chooseBitrateAndSplit(seconds) {
  const candidateKbps = [96, 64, 48, 32, 24, 16];
  for (const kb of candidateKbps) {
    const estBytes = Math.ceil(seconds * (kb * 1000) / 8);
    if (estBytes <= config.targetMaxBytes) {
      return { kbps: kb, needsSplit: false };
    }
  }
  return { kbps: candidateKbps[candidateKbps.length - 1], needsSplit: true };
}

function computeSegmentSeconds(kbps) {
  const seconds = Math.floor(config.targetMaxBytes / ((kbps * 1000) / 8));
  return Math.max(config.minSegSeconds, Math.min(config.maxSegSeconds, seconds || config.defaultSegSeconds));
}

async function encodeAudio(inPath, { kbps, needsSplit, requestId }) {
  const tmpBase = `/tmp/${requestId}`;
  addStep(requestId, `Chosen bitrate: ${kbps} kbps; ${needsSplit ? "will segment" : "single file"}.`);

  const commonOptions = {
    noVideo: true,
    audioFilters: ["highpass=f=200", "lowpass=f=3800", "dynaudnorm"],
    outputOptions: [
      "-ac", "1",
      "-ar", "16000",
      "-b:a", `${kbps}k`,
      "-codec:a", "libmp3lame",
    ],
  };

  if (!needsSplit) {
    const singleOut = `${tmpBase}.${kbps}k.mp3`;
    addStep(requestId, `Encode MP3 @ ${kbps} kbps (single file)…`);
    await new Promise((resolve, reject) => {
      ffmpeg(inPath)
        .noVideo().audioFilters(commonOptions.audioFilters).outputOptions(commonOptions.outputOptions)
        .save(singleOut).on("end", resolve).on("error", reject);
    });
    // If the single file is still too large, we must segment it.
    if (statBytes(singleOut) > config.openAiAudioMax) {
      addStep(requestId, "Single file still >25MB — re-encoding with segmentation…");
      await fs.unlink(singleOut); // Delete the oversized file
      return encodeAudio(inPath, { kbps, needsSplit: true, requestId });
    }
    return [singleOut];
  } else {
    const segmentSeconds = computeSegmentSeconds(kbps);
    const pattern = `${tmpBase}.part-%03d.mp3`;
    addStep(requestId, `Encode+Segment MP3 @ ${kbps} kbps, ~${segmentSeconds}s/part…`);
    await new Promise((resolve, reject) => {
      ffmpeg(inPath)
        .noVideo().audioFilters(commonOptions.audioFilters).outputOptions([
          ...commonOptions.outputOptions,
          "-f", "segment",
          "-segment_time", String(segmentSeconds),
          "-reset_timestamps", "1",
        ])
        .save(pattern).on("end", resolve).on("error", reject);
    });
    const dir = path.dirname(pattern);
    const base = path.basename(pattern).split("%")[0];
    return readdirSync(dir)
      .filter((n) => n.startsWith(base) && n.endsWith(".mp3"))
      .map((n) => path.join(dir, n)).sort();
  }
}

async function prepareAudio({ inputPath, requestId }, tempFiles) {
  const durationSec = await ffprobeDurationSeconds(inputPath);
  addStep(requestId, `Detected duration: ${Math.round(durationSec)}s`);

  const { kbps, needsSplit } = chooseBitrateAndSplit(durationSec);
  const audioParts = await encodeAudio(inputPath, { kbps, needsSplit, requestId });
  audioParts.forEach(p => tempFiles.add(p));

  return { audioParts, durationSec: Math.round(durationSec) };
}

// -----------------------------
// --- STEP 2: TRANSCRIBE AUDIO ---
// -----------------------------

async function openaiTranscribeVerbose(audioPath, requestId) {
  const fd = new FormData();
  fd.append("file", createReadStream(audioPath), { filename: path.basename(audioPath) });
  fd.append("model", "whisper-1");
  fd.append("response_format", "verbose_json");
  fd.append("temperature", "0");
  try {
    const r = await axiosOpenAI.post("https://api.openai.com/v1/audio/transcriptions", fd, {
      headers: { Authorization: `Bearer ${config.openaiApiKey}`, ...fd.getHeaders() },
    });
    return r.data;
  } catch (err) {
    console.error(`[${requestId}] Whisper transcribe error:`, err?.response?.status, err?.message);
    throw err;
  }
}

async function transcribeAudio(audioParts, requestId) {
  addStep(requestId, `Transcribing ${audioParts.length} part(s) in parallel (concurrency: ${config.whisperConcurrency})…`);
  const tasks = audioParts.map((filePath, idx) => async () => {
    addStep(requestId, `Part ${idx + 1}/${audioParts.length} → start`);
    const res = await withRetries(() => openaiTranscribeVerbose(filePath, requestId));
    addStep(requestId, `Part ${idx + 1}/${audioParts.length} → done`);
    return res;
  });

  const results = await runBounded(tasks, config.whisperConcurrency);

  let originalAll = "";
  let language = "";
  for (const verbose of results) {
    if (!language && verbose?.language) language = verbose.language;
    originalAll += (originalAll ? "\n\n" : "") + (verbose?.text || "");
  }
  return { originalAll, language };
}

// -------------------------------
// --- STEP 3: TRANSLATE SCRIPT ---
// -------------------------------

async function translateTranscript(originalAll, requestId) {
  addStep(requestId, "Calling GPT for faithful multilingual translation to zh-TW…");
  const systemPrompt = `你是國際會議的一線口筆譯員。請把使用者提供的「原文」完整翻譯成「繁體中文（台灣慣用）」並嚴格遵守：1) 忠實轉譯：不得增刪、不得臆測，不加入任何評論；僅做必要語序與語法調整，使中文可讀但不意譯。2) 句序與段落：依原文的順序與分段輸出；保留重複、口頭語與語氣詞（如「嗯」「呃」），除非影響理解才可輕微平順化。3) 多語切換：不論原文出現哪些語言（如英文、西文、法文、德文、中文等），一律譯為繁體中文。 - 專有名詞與常見譯名：使用台灣慣用或通行的中文譯名。 - 若無固定譯名：採音譯或意譯，並在「首次出現」於中文後加上原文括號，例如：桑德拉（Sandra）、哥倫比亞大學（Columbia University）。4) 數字與單位：數字使用阿拉伯數字；度量衡、貨幣等採台灣常用寫法（公里、公斤、美元…）。5) 標點：使用中文全形標點。6) 保留不應翻的內容：網址、電子郵件、檔名、程式碼片段、指令、模型名稱等以原樣保留（可配合中文標點）。7) 只輸出譯文正文：不要任何說明、標題或註解；不要摘要或重寫。8) 若原文本身是中文：統一為台灣慣用詞與全形標點，避免過度改寫。請直接輸出最終譯文。`;
  const payload = {
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: originalAll || "" },
    ],
  };

  try {
    const resp = await withRetries(() =>
      axiosOpenAI.post("https://api.openai.com/v1/chat/completions", payload, {
        headers: { Authorization: `Bearer ${config.openaiApiKey}` },
        validateStatus: (s) => s >= 200 && s < 500,
      }),
      { maxAttempts: 5, baseDelayMs: 800 }
    );
    const translated = resp?.data?.choices?.[0]?.message?.content?.trim() || "";
    addStep(requestId, "繁中 translation done.");
    return translated;
  } catch (err) {
    const s = err?.response?.status;
    const d = err?.response?.data;
    const errorDetails = typeof d === "string" ? d.slice(0, 180) : JSON.stringify(d || {}).slice(0, 180);
    addStep(requestId, `⚠️ GPT translation failed (${s || "no-status"}) — sending original only. Details: ${errorDetails}`);
    return ""; // Return empty string on failure
  }
}

// -----------------------------
// --- STEP 4: SEND RESULTS ---
// -----------------------------

async function sendResults(jobDetails, results) {
  const { email, fileMeta, requestId, started } = jobDetails;
  const { durationSec, originalAll, language, translatedText } = results;

  // --- Create Attachments ---
  const safeBase = (fileMeta.originalname || "transcript").replace(/[^\w.-]+/g, "_").slice(0, 50);
  const attachmentText = `＝＝ 中文（繁體） ＝＝\n${translatedText}\n\n＝＝ 原文 ＝＝\n${originalAll}\n`;
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph("＝＝ 中文（繁體） ＝＝"),
        ...String(translatedText || "").split("\n").map((line) => new Paragraph(line)),
        new Paragraph(""),
        new Paragraph("＝＝ 原文 ＝＝"),
        ...String(originalAll || "").split("\n").map((line) => new Paragraph(line)),
      ],
    }],
  });
  const docxBuffer = await Packer.toBuffer(doc);

  // --- Send Email ---
  addStep(requestId, "Sending email…");
  const localStamp = fmtLocalStamp(new Date());
  await mailer.sendMail({
    from: `"${config.fromName}" <${config.fromEmail}>`,
    to: email,
    replyTo: config.fromEmail,
    subject: "您的逐字稿（原文與繁體中文）",
    text: `轉寫已完成 ${localStamp}\n\n本次上傳時長（秒）：${durationSec}\n\n（服務單號：${requestId}）`,
    attachments: [
      {
        filename: `${safeBase}-${requestId}.txt`,
        content: attachmentText,
        contentType: "text/plain; charset=utf-8",
      },
      {
        filename: `${safeBase}-${requestId}.docx`,
        content: docxBuffer,
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    ],
  });
  addStep(requestId, "Email sent.");

  // --- Log to Database ---
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(jobseconds), 0)::int AS total FROM transcriptions WHERE email = $1 AND succeeded = true`,
      [email]
    );
    const pastSeconds = Number(rows?.[0]?.total || 0);
    const cumulativeSeconds = pastSeconds + durationSec;

    await pool.query(
      `INSERT INTO transcriptions (
         timestamputc, timestamplocal, email, jobseconds, cumulativeseconds,
         minutes, cumulativeminutes, filename, filesizemb, language, requestid,
         processingms, succeeded, errormessage, model, filetype
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        new Date(), localStamp, email, durationSec, cumulativeSeconds,
        secsToSheetMinutes(durationSec), secsToSheetMinutes(cumulativeSeconds),
        fileMeta.originalname || "upload", Math.max(0.01, Math.round((fileMeta.size / 1048576) * 100) / 100),
        language || "", requestId, Date.now() - started, true, "", "whisper-1", fileMeta.mimetype || ""
      ]
    );
    addStep(requestId, "Database record created.");
  } catch (e) {
    addStep(requestId, "⚠️ Database insert failed: " + (e?.message || e));
  }
}

// -------------------------
// --- STEP 5: FINALIZE JOB ---
// -------------------------

async function finalizeJob(requestId, durationSec, status, errorMsg = "") {
  if (status === "succeeded") {
    await setJobStatus(requestId, "done");
    await updateStatus(requestId, "succeeded", durationSec);
  } else {
    await setJobStatus(requestId, "error", errorMsg);
    await updateStatus(requestId, "processing_fail");
  }
}


// ---------------------------------
// --- MAIN JOB PROCESSOR (Orchestrator) ---
// ---------------------------------

/**
 * Main orchestrator for the transcription job.
 * @param {object} jobDetails - Contains email, paths, metadata, etc.
 */
async function processJob(jobDetails) {
  const { requestId, fileMeta } = jobDetails;
  const tempFiles = new Set([jobDetails.inputPath]);

  addStep(requestId, `Processing: ${fileMeta.originalname} (${(fileMeta.size / 1048576).toFixed(2)} MB)`);

  try {
    // 1. Prepare Audio: Probe, choose bitrate, and encode/segment.
    const { audioParts, durationSec } = await prepareAudio(jobDetails, tempFiles);

    // 2. Transcribe: Process audio parts in parallel with Whisper.
    const { originalAll, language } = await transcribeAudio(audioParts, requestId);

    // 3. Translate: Use GPT for high-fidelity translation.
    const translatedText = await translateTranscript(originalAll, requestId);

    // 4. Send Results: Email user and log success to the database.
    await sendResults(jobDetails, { durationSec, originalAll, language, translatedText });
    
    // 5. Finalize: Update job status and notify external services.
    await finalizeJob(requestId, durationSec, "succeeded");
    addStep(requestId, "✅ Done");

  } catch (err) {
    const eMsg = err?.message || "Processing error";
    addStep(requestId, "❌ " + eMsg);
    await finalizeJob(requestId, 0, "error", eMsg);
    // Optionally, notify external services about the failure.
    await consume({
      event: "transcription.finished", status: "failed",
      email: jobDetails.email, filename: fileMeta.originalname,
      request_id: requestId, job_id: jobDetails.jobId || "", token: jobDetails.token || "",
      duration_sec: 0, charged_seconds: 0, language: "",
      finished_at: new Date().toISOString(), error: eMsg,
    });
  } finally {
    addStep(requestId, "Cleaning up temporary files...");
    await cleanupFiles(tempFiles, requestId);
  }
}


// ===================================================================================
//
//                                  API & ROUTES
//
// ===================================================================================

app.get("/status", async (req, res) => {
  const id = (req.query.id || "").toString();
  if (!id) return res.status(400).json({ error: "Missing id" });

  try {
    const { rows } = await pool.query(
      `SELECT requestid, status, steps, error, created_at FROM jobs WHERE requestid = $1 LIMIT 1`,
      [id]
    );
    const j = rows[0];
    if (!j) return res.status(404).json({ error: "Not found" });
    res.json(j);
  } catch(e) {
    res.status(500).json({ error: "Database error." });
  }
});

app.post("/upload",
  // --- Multer Middleware with Custom Error Handling ---
  (req, res, next) => {
    upload.single("file")(req, res, function (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        const maxMb = Math.round(config.maxUploadBytes / 1048576);
        return res.status(413).json({ error: `File too large. Max ${maxMb} MB.` });
      }
      if (err) {
        return res.status(400).json({ error: err.message || "Upload error" });
      }
      next();
    });
  },
  // --- Main Request Handler ---
  async (req, res) => {
    const email = (req.body?.email || "").trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!email || !emailRegex.test(email)) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "File is required" });
    }

    const requestId = crypto.randomUUID();

    // Respond immediately to the client.
    res.status(202).json({ success: true, accepted: true, requestId });

    // --- Start background processing ---
    setImmediate(async () => {
      try {
        // CRITICAL: Ensure the job is logged in the DB before starting.
        // If this fails, the entire process stops and the error is caught below.
        await createJob(requestId);
        
        await processJob({
          email,
          inputPath: req.file.path,
          fileMeta: req.file,
          requestId,
          jobId: String(req.body?.job_id || ""),
          token: String(req.body?.token || ""),
          started: Date.now(),
        });

      } catch (e) {
        console.error(`[${requestId}] Background crash:`, e?.message || e);
        // Attempt to update status, but the record might not exist if createJob failed.
        await finalizeJob(requestId, 0, "error", e?.message || String(e));
      }
    });
  }
);

app.get("/", (_req, res) =>
  res.send("✅ Whisper backend (upload-only, Postgres) running")
);


// ===================================================================================
//
//                                 SERVER INITIALIZATION
//
// ===================================================================================

async function startServer() {
  try {
    await pool.query("SELECT 1");
    console.log("✅ DB connectivity OK (Postgres)");
    await ensureSchema();
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));
  } catch (e) {
    console.error("❌ Server initialization failed:", e.code || "", e.message);
    process.exit(1);
  }
}

startServer();
