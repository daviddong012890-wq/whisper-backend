import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import axios from "axios";
import FormData from "form-data";
import nodemailer from "nodemailer";
import { google } from "googleapis";
import crypto from "crypto";
import path from "path";

const app = express();
app.use(cors({ origin: "*" }));
app.options("*", cors());
const upload = multer({ dest: "/tmp" });
ffmpeg.setFfmpegPath(ffmpegStatic);

// ===== ENV =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GMAIL_USER     = process.env.GMAIL_USER;
const GMAIL_PASS     = process.env.GMAIL_PASS;
const SHEET_ID       = process.env.SHEET_ID;
const GOOGLE_KEYFILE = process.env.GOOGLE_APPLICATION_CREDENTIALS;

function fatal(m){ console.error("❌ " + m); process.exit(1); }
if (!OPENAI_API_KEY) fatal("Missing OPENAI_API_KEY");
if (!GMAIL_USER || !GMAIL_PASS) fatal("Missing GMAIL_USER or GMAIL_PASS");
if (!SHEET_ID) fatal("Missing SHEET_ID");
if (!GOOGLE_KEYFILE) fatal("Missing GOOGLE_APPLICATION_CREDENTIALS");

if (!fs.existsSync(GOOGLE_KEYFILE)) fatal(`Key not found at ${GOOGLE_KEYFILE}`);
let SA_EMAIL = "";
try {
  const j = JSON.parse(fs.readFileSync(GOOGLE_KEYFILE, "utf8"));
  SA_EMAIL = j.client_email || "";
  console.log("🔑 Using service account:", SA_EMAIL);
  console.log("🔑 Key path:", GOOGLE_KEYFILE);
} catch (e) { fatal("Bad service-account JSON: " + e.message); }

// ===== SAFE LOGGING =====
function logAxiosError(prefix, err) {
  const status = err?.response?.status;
  const code   = err?.code;
  const msg = err?.response?.data?.error?.message
          || err?.message
          || String(err);
  console.error(`${prefix}${status ? " ["+status+"]" : ""}${code ? " ("+code+")" : ""}: ${msg}`);
}

// ===== GOOGLE CLIENTS =====
const auth = new google.auth.GoogleAuth({
  keyFile: GOOGLE_KEYFILE,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
});

// ===== JOB TRACKER (in-memory) =====
const jobs = new Map(); // id -> { status, steps:[], error, metrics:{} }
function setJob(id, patch){
  const cur = jobs.get(id) || { status:"queued", steps:[], error:null, metrics:{} };
  const next = { ...cur, ...patch };
  jobs.set(id, next);
  return next;
}
function addStep(id, text){
  const cur = jobs.get(id) || { status:"queued", steps:[], error:null, metrics:{} };
  cur.steps.push({ at: new Date().toISOString(), text });
  jobs.set(id, cur);
  // also log to Render
  console.log(`[${id}] ${text}`);
}

// In-memory cumulative minutes (sheet is durable)
let cumulativeMinutes = 0;

// ===== Helpers =====
function statBytes(p){
  try { return fs.statSync(p).size; } catch { return 0; }
}
function getAudioMinutes(filePath){
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return reject(err);
      const seconds = meta?.format?.duration || 0;
      resolve(Math.max(1, Math.ceil(seconds/60)));
    });
  });
}

// Transcode with speech filters to MP3 mono 16 kHz at a specific bitrate (kbps)
async function toMp3Filtered(inPath, kbps, requestId){
  const out = inPath + `.${kbps}k.mp3`;
  addStep(requestId, `Transcoding with filters at ${kbps} kbps…`);
  await new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .audioFilters([
        "highpass=f=200",
        "lowpass=f=3800",
        "dynaudnorm"
      ])
      .outputOptions([
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-b:a", `${kbps}k`,
        "-codec:a", "libmp3lame"
      ])
      .save(out)
      .on("end", resolve)
      .on("error", reject);
  });
  addStep(requestId, `Transcode ${kbps} kbps done (${(statBytes(out)/1024/1024).toFixed(2)} MB).`);
  return out;
}

// Prepare audio for Whisper: try 64k → 48k → 32k → 24k until <= 25 MB
const OPENAI_AUDIO_MAX = 25 * 1024 * 1024; // ~25 MB
async function prepareAudioForWhisper(inPath, requestId){
  const ladder = [64, 48, 32, 24]; // kbps
  for (const kbps of ladder) {
    const out = await toMp3Filtered(inPath, kbps, requestId);
    const sz = statBytes(out);
    if (sz <= OPENAI_AUDIO_MAX) {
      addStep(requestId, `Using ${kbps} kbps (final ${(sz/1024/1024).toFixed(2)} MB).`);
      return { path: out, kbps, bytes: sz };
    }
    try { fs.unlinkSync(out); } catch {}
  }
  const out = await toMp3Filtered(inPath, 24, requestId);
  const sz = statBytes(out);
  addStep(requestId, `Using 24 kbps (final ${(sz/1024/1024).toFixed(2)} MB).`);
  return { path: out, kbps: 24, bytes: sz };
}

// ===== OpenAI calls (with safe logging) =====
async function whisperTranscribeVerbose(audioPath, requestId){
  try {
    addStep(requestId, "Calling Whisper: /audio/transcriptions …");
    const fd = new FormData();
    fd.append("file", fs.createReadStream(audioPath), { filename: path.basename(audioPath) });
    fd.append("model", "whisper-1");
    fd.append("response_format", "verbose_json");
    fd.append("temperature", "0");
    const r = await axios.post("https://api.openai.com/v1/audio/transcriptions", fd, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...fd.getHeaders() },
      maxBodyLength: Infinity,
    });
    addStep(requestId, "Whisper transcription done.");
    return r.data; // { text, language, ... }
  } catch (err) {
    logAxiosError(`[${requestId}] Whisper transcribe failed`, err);
    throw new Error("Transcription failed");
  }
}
async function whisperTranslateToEnglish(audioPath, requestId){
  try {
    addStep(requestId, "Calling Whisper: /audio/translations (EN) …");
    const fd = new FormData();
    fd.append("file", fs.createReadStream(audioPath), { filename: path.basename(audioPath) });
    fd.append("model", "whisper-1");
    fd.append("translate", "true");
    fd.append("temperature", "0");
    const r = await axios.post("https://api.openai.com/v1/audio/translations", fd, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...fd.getHeaders() },
      maxBodyLength: Infinity,
    });
    addStep(requestId, "Whisper EN translation done.");
    return r.data; // { text }
  } catch (err) {
    logAxiosError(`[${requestId}] Whisper translate→EN failed`, err);
    throw new Error("English translation failed");
  }
}
async function toTraditionalChinese(text, requestId){
  try {
    addStep(requestId, "Calling GPT: EN→繁中 …");
    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "你是專業翻譯，請將使用者的英文內容翻譯為自然、精準、正式的繁體中文（保留專有名詞）。不得添加任何評論或說明。" },
          { role: "user", content: text || "" }
        ],
        temperature: 0.2
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    addStep(requestId, "GPT EN→繁中 done.");
    return r.data?.choices?.[0]?.message?.content?.trim() || "";
  } catch (err) {
    logAxiosError(`[${requestId}] GPT EN→繁中 failed`, err);
    throw new Error("Traditional Chinese translation failed");
  }
}

// ===== Sheets header =====
const HEADER = [
  "Timestamp","Email","Minutes","CumulativeMinutes","FileName","FileSizeMB",
  "Language","RequestId","ProcessingMs","Succeeded","ErrorMessage","Model","FileType"
];
async function ensureHeader(){
  try {
    const get = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A1:M1",
    });
    const current = get.data.values?.[0] || [];
    const ok = HEADER.length === current.length && HEADER.every((h,i)=>h===current[i]);
    if (!ok) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: "Sheet1!A1:M1",
        valueInputOption: "RAW",
        requestBody: { values: [HEADER] },
      });
    }
  } catch (e) {
    console.error("⚠️ ensureHeader failed:", e.message || e);
  }
}

// ===== Background processor =====
async function processJob({ email, inputPath, fileMeta, requestId }) {
  const start = Date.now();
  setJob(requestId, { status: "processing", metrics: { start }});
  addStep(requestId, `Accepted from ${email} — ${fileMeta.originalname} — ${(fileMeta.size/1024/1024).toFixed(2)} MB`);

  const model = "whisper-1";
  let succeeded = false;
  let errorMessage = "";
  let minutes = 0;
  let language = "";
  let fileType = fileMeta.mimetype || "";
  let fileName = fileMeta.originalname || "upload";
  let fileSizeMB = Math.max(0.01, Math.round(((fileMeta.size || 0)/(1024*1024))*100)/100);

  let audio = null;
  try {
    audio = await prepareAudioForWhisper(inputPath, requestId);
  } catch (e) {
    errorMessage = "Transcode failed: " + (e?.message || e);
    addStep(requestId, "❌ " + errorMessage);
  }

  try {
    minutes = await getAudioMinutes(audio?.path || inputPath);
    cumulativeMinutes += minutes;
    addStep(requestId, `Audio minutes: ${minutes} (cumulative ${cumulativeMinutes}).`);

    const verbose = await whisperTranscribeVerbose(audio?.path || inputPath, requestId);
    language = verbose.language || "";
    const originalText = verbose.text || "";

    const englishText = (await whisperTranslateToEnglish(audio?.path || inputPath, requestId)).text || originalText;
    const zhTraditional = await toTraditionalChinese(englishText || originalText, requestId);

    const mailBody =
`Your transcription is ready.

— Minutes: ${minutes}
— Cumulative minutes: ${cumulativeMinutes}

== English ==
${englishText || originalText}

== 中文（繁體） ==
${zhTraditional}

== Original language ==
${originalText}

(RequestId: ${requestId})
(Encoded: ${audio?.kbps || "?"} kbps, ${(audio?.bytes||0/1024/1024).toFixed(2)} MB)`;

    addStep(requestId, "Sending email…");
    await transporter.sendMail({
      from: `"Transcription Service" <${GMAIL_USER}>`,
      to: email,
      subject: "Your Bilingual Transcription (EN & 繁體中文)",
      text: mailBody,
    });
    addStep(requestId, "Email sent.");

    succeeded = true;

  } catch (err) {
    errorMessage = err?.message || "Processing error";
    addStep(requestId, "❌ " + errorMessage);
  }

  // Append analytics row
  try {
    await ensureHeader();
    const row = [
      new Date().toISOString(),
      email,
      minutes || 0,
      cumulativeMinutes || 0,
      fileName,
      fileSizeMB || 0,
      language || "",
      requestId,
      Date.now() - start,
      succeeded,
      errorMessage || "",
      model,
      fileType
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A:M",
      valueInputOption: "RAW",
      requestBody: { values: [row] },
    });
    addStep(requestId, "Sheets row appended.");
  } catch (sheetErr) {
    addStep(requestId, "⚠️ Sheets append failed: " + (sheetErr?.message || sheetErr));
  }

  // Cleanup temp files
  try { fs.unlinkSync(inputPath); } catch {}
  try {
    if (audio?.path && fs.existsSync(audio.path)) fs.unlinkSync(audio.path);
    ["64k","48k","32k","24k"].forEach(k => {
      const p = inputPath + "." + k + ".mp3";
      if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch {}
    });
  } catch {}

  setJob(requestId, { status: succeeded ? "done" : "error", metrics:{ ...jobs.get(requestId)?.metrics, end: Date.now() }, error: succeeded? null : errorMessage });
  addStep(requestId, succeeded ? "✅ Done" : "❌ Finished with error");
}

// ===== Immediate-ack upload =====
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const email = (req.body.email || "").trim();
    if (!email) return res.status(400).json({ error: "Email is required" });
    if (!req.file) return res.status(400).json({ error: "File is required" });

    const requestId = crypto.randomUUID();
    setJob(requestId, { status:"accepted", steps:[], error:null, metrics:{} });
    addStep(requestId, "Upload accepted by server.");
    res.status(202).json({ success: true, accepted: true, requestId });

    setImmediate(() =>
      processJob({ email, inputPath: req.file.path, fileMeta: req.file, requestId })
        .catch(e => {
          addStep(requestId, "❌ Background job crash: " + (e?.message || e));
          setJob(requestId, { status:"error", error: e?.message || String(e) });
        })
    );

  } catch (err) {
    console.error("❌ Error accepting upload:", err?.message || err);
    res.status(500).json({ error: "Processing failed at accept stage" });
  }
});

// ===== Status endpoint =====
app.get("/status", (req, res) => {
  const id = (req.query.id || "").toString();
  if (!id) return res.status(400).json({ error: "Missing id" });
  const j = jobs.get(id);
  if (!j) return res.status(404).json({ error: "Not found" });
  res.json(j);
});

app.get("/", (_req, res) => res.send("✅ Whisper backend running"));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));
