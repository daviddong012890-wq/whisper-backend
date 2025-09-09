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
import { Pool } from "pg";
import { Document, Packer, Paragraph } from "docx";

// ---------- notify PHP (worker-consume.php) ----------
const CONSUME_URL = process.env.CONSUME_URL || "";
const WORKER_SHARED_KEY = process.env.WORKER_SHARED_KEY || "";

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

// ---------- app / setup ----------
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

// ===== Upload-only mode =====
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 1.5 * 1024 * 1024 * 1024); // 1.5 GB default
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
const FROM_NAME = process.env.FROM_NAME || "逐字稿產生器";

function fatal(m) {
  console.error("❌ " + m);
  process.exit(1);
}
if (!OPENAI_API_KEY) fatal("Missing OPENAI_API_KEY");
if (!GMAIL_USER || !GMAIL_PASS) fatal("Missing GMAIL_USER or GMAIL_PASS");

// ---------- Postgres pool ----------
/**
 * Prefer Render’s DATABASE_URL. Fallback to DB_* if provided.
 * DATABASE_URL example: postgres://user:pass@host:5432/dbname
 */
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
  .catch((e) =>
    console.error("❌ DB connectivity failed:", e.code || "", e.message)
  );

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
const MAX_SEG_SECONDS = 900; // 15 min
const DEFAULT_SEG_SECONDS = 900;

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

// ---------- DB helpers (Postgres) ----------
async function createJob(id) {
  const step = { at: new Date().toISOString(), text: "Job accepted by server." };
  // Insert as JSONB array with one element
  await pool.query(
    `INSERT INTO jobs (requestId, status, steps)
     VALUES ($1, $2, $3::jsonb)`,
    [id, "accepted", JSON.stringify([step])]
  );
  console.log(`[${id}] Job created in database.`);
}

async function addStep(id, text) {
  const step = { at: new Date().toISOString(), text };
  // Append element to jsonb array: steps = steps || [step]
  await pool.query(
    `UPDATE jobs
       SET steps = COALESCE(steps, '[]'::jsonb) || $1::jsonb
     WHERE requestId = $2`,
    [JSON.stringify([step]), id]
  );
  console.log(`[${id}] ${text}`);
}

async function setJobStatus(id, status, error = null) {
  await pool.query(
    `UPDATE jobs SET status = $1, error = $2 WHERE requestId = $3`,
    [status, error, id]
  );
}

// status endpoint (unchanged shape)
app.get("/status", async (req, res) => {
  const id = (req.query.id || "").toString();
  if (!id) return res.status(400).json({ error: "Missing id" });
  const { rows } = await pool.query(
    `SELECT requestId, status, steps, error, created_at
       FROM jobs
      WHERE requestId = $1
      LIMIT 1`,
    [id]
  );
  const j = rows[0];
  if (!j) return res.status(404).json({ error: "Not found" });
  // pg returns jsonb already parsed in many clients, but ensure we output array
  const steps = Array.isArray(j.steps)
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
  return Math.ceil(seconds * (kbps * 1000 / 8));
}
function chooseBitrateAndSplit(seconds, candidateKbps = [96, 64, 48, 32, 24, 16]) {
  for (const kb of candidateKbps) {
    const est = estimateSizeBytes(seconds, kb);
    if (est <= TARGET_MAX_BYTES) {
      return { kbps: kb, needsSplit: false, estBytes: est };
    }
  }
  return {
    kbps: candidateKbps[candidateKbps.length - 1],
    needsSplit: true,
    estBytes: estimateSizeBytes(seconds, candidateKbps[candidateKbps.length - 1]),
  };
}
function computeSegmentSeconds(kbps) {
  const seconds = Math.floor(TARGET_MAX_BYTES / (kbps * 1000 / 8));
  return Math.max(MIN_SEG_SECONDS, Math.min(MAX_SEG_SECONDS, seconds || DEFAULT_SEG_SECONDS));
}

// ---------- single-pass encode helpers ----------
async function encodeSingleMp3(inPath, outMp3, kbps, requestId) {
  addStep(requestId, `Encode MP3 @ ${kbps} kbps (single file)…`);
  await new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .noVideo()
      .audioFilters(["highpass=f=200", "lowpass=f=3800", "dynaudnorm"])
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
      .audioFilters(["highpass=f=200", "lowpass=f=3800", "dynaudnorm"])
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
  // capture base like `${requestId}.part-`
  const base = path.basename(outPattern).split("%")[0];
  const files = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(base) && n.endsWith(".mp3"))
    .map((n) => path.join(dir, n))
    .sort();
  return files;
}

// ---------- OpenAI ----------
async function openaiTranscribeVerbose(audioPath, requestId) {
  try {
    const fd = new FormData();
    fd.append("file", fs.createReadStream(audioPath), {
      filename: path.basename(audioPath),
    });
    fd.append("model", "whisper-1");
    fd.append("response_format", "verbose_json");
    fd.append("temperature", "0");
    const r = await axios.post(
      "https://api.openai.com/v1/audio/transcriptions",
      fd,
      {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...fd.getHeaders() },
        maxBodyLength: Infinity,
        timeout: 300000,
      }
    );
    return r.data;
  } catch (err) {
    console.error(`[${requestId}] Whisper transcribe error:`, err?.response?.status, err?.message);
    throw err;
  }
}

// ---------- bounded concurrency + retries ----------
function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }
async function withRetries(fn, { maxAttempts = 5, baseDelayMs = 700 } = {}) {
  let attempt = 0;
  while (true) {
    try { return await fn(); }
    catch (e) {
      attempt++;
      const s = e?.response?.status;
      const retriable = s === 429 || (s >= 500 && s < 600);
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
        const idx = next++; active++;
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

// ---------- main processor ----------
async function processJob({ email, inputPath, fileMeta, requestId, jobId, token }) {
  await setJobStatus(requestId, "processing");
  addStep(requestId, `Processing: ${fileMeta.originalname} (${(fileMeta.size / 1024 / 1024).toFixed(2)} MB)`);

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
    addStep(requestId, `Chosen bitrate: ${kbps} kbps; ${needsSplit ? "will segment" : "single file"}.`);

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
    // Here we compute pastSeconds from transcriptions table (Postgres)
    let pastSeconds = 0;
    try {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(jobSeconds), 0)::int AS total FROM transcriptions WHERE email = $1 AND succeeded = true`,
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
      const res = await withRetries(() => openaiTranscribeVerbose(filePath, requestId), {
        maxAttempts: 5,
        baseDelayMs: 700,
      });
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
    addStep(requestId, "Calling GPT 原文→繁中 (faithful) …");
    const systemPrompt = `你是國際會議的專業口筆譯員。請把使用者提供的「原文」完整翻譯成「繁體中文（台灣慣用）」並嚴格遵守：
1) 忠實轉譯：不可增刪、不可臆測，不加入任何評論；僅做必要語法與詞序調整以使中文通順。
2) 句序與段落：依原文順序與段落輸出；保留所有重複、口號與語氣詞。
3) 中英夾雜：凡是非中文的片段一律翻成中文。
4) 標點使用中文全形標點。只輸出中文譯文，不要任何說明。`;
    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: originalAll || "" },
        ],
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    const zhTraditional = r.data?.choices?.[0]?.message?.content?.trim() || "";
    addStep(requestId, "繁中 done.");

    // email with attachments
    const localStamp = fmtLocalStamp(new Date());
    const attachmentText = `＝＝ 中文（繁體） ＝＝\n${zhTraditional}\n\n＝＝ 原文 ＝＝\n${originalAll}\n`;
    const safeBase =
      (fileName || "transcript").replace(/[^\w.-]+/g, "_").slice(0, 50) || "transcript";
    const txtName = `${safeBase}-${requestId}.txt`;
    const docxName = `${safeBase}-${requestId}.docx`;
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph("＝＝ 中文（繁體） ＝＝"),
            ...String(zhTraditional || "").split("\n").map((line) => new Paragraph(line)),
            new Paragraph(""),
            new Paragraph("＝＝ 原文 ＝＝"),
            ...String(originalAll || "").split("\n").map((line) => new Paragraph(line)),
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
      text: `轉寫已完成 ${localStamp}\n\n本次上傳時長（秒）：${jobSeconds}\n\n（服務單號：${requestId}）`,
      attachments: [
        { filename: txtName, content: attachmentText, contentType: "text/plain; charset=utf-8" },
        {
          filename: docxName,
          content: docxBuffer,
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      ],
    });
    addStep(requestId, "Email sent.");

    // insert transcriptions row
    try {
      const sql = `
        INSERT INTO transcriptions (
          timestampUTC, timestampLocal, email,
          jobSeconds, cumulativeSeconds, minutes, cumulativeMinutes,
          fileName, fileSizeMB, language, requestId, processingMs,
          succeeded, errorMessage, model, fileType
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
      token: token || "",
      duration_sec: 0,
      charged_seconds: 0,
      language: "",
      finished_at: new Date().toISOString(),
      error: eMsg,
    });
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
          .json({ error: `File too large. Max ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.` });
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

    const requestId = crypto.randomUUID();

    // Respond first so frontend doesn't see DB blips
    res.status(202).json({ success: true, accepted: true, requestId });

    setImmediate(async () => {
      try {
        try {
          await createJob(requestId);
        } catch (dbErr) {
          console.error(`[${requestId}] createJob DB error (continuing):`, dbErr?.message || dbErr);
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
        try { await setJobStatus(requestId, "error", e?.message || String(e)); } catch {}
      }
    });
  }
);

app.get("/", (_req, res) => res.send("✅ Whisper backend (upload-only, Postgres) running"));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));
