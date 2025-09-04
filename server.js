import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import fetch from "node-fetch";
import FormData from "form-data";
import nodemailer from "nodemailer";
import { google } from "googleapis";
import crypto from "crypto";

const app = express();
app.use(cors({ origin: "*" })); // you can lock to your domain later
const upload = multer({ dest: "/tmp" });
ffmpeg.setFfmpegPath(ffmpegStatic);

// ===== ENV =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GMAIL_USER     = process.env.GMAIL_USER;
const GMAIL_PASS     = process.env.GMAIL_PASS;
const SHEET_ID       = process.env.SHEET_ID;
const GOOGLE_KEYFILE = process.env.GOOGLE_APPLICATION_CREDENTIALS; // /etc/secrets/gcp-sa.json

function fatal(m){ console.error("❌ " + m); process.exit(1); }
if (!OPENAI_API_KEY) fatal("Missing OPENAI_API_KEY");
if (!GMAIL_USER || !GMAIL_PASS) fatal("Missing GMAIL_USER or GMAIL_PASS");
if (!SHEET_ID) fatal("Missing SHEET_ID");
if (!GOOGLE_KEYFILE) fatal("Missing GOOGLE_APPLICATION_CREDENTIALS");

// verify key file + show which SA we’re using
if (!fs.existsSync(GOOGLE_KEYFILE)) fatal(`Key not found at ${GOOGLE_KEYFILE}`);
let SA_EMAIL = "";
try {
  const j = JSON.parse(fs.readFileSync(GOOGLE_KEYFILE, "utf8"));
  SA_EMAIL = j.client_email || "";
  console.log("🔑 Using service account:", SA_EMAIL);
  console.log("🔑 Key path:", GOOGLE_KEYFILE);
} catch (e) { fatal("Bad service-account JSON: " + e.message); }

// Google Sheets client
const auth = new google.auth.GoogleAuth({
  keyFile: GOOGLE_KEYFILE,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// Email (Gmail SMTP)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
});

// Cumulative minutes (resets on Render restart; sheet is the durable ledger)
let cumulativeMinutes = 0;

// ===== Helpers =====
function getAudioMinutes(filePath){
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return reject(err);
      const seconds = meta?.format?.duration || 0;
      resolve(Math.max(1, Math.ceil(seconds/60)));
    });
  });
}

// Whisper with verbose JSON (so we get auto-detected language)
async function whisperTranscribeVerbose(mp3Path){
  const fd = new FormData();
  fd.append("file", fs.createReadStream(mp3Path));
  fd.append("model", "whisper-1");
  fd.append("response_format", "verbose_json");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: fd,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Whisper transcribe failed: ${JSON.stringify(j)}`);
  return { text: j.text || "", language: j.language || "" };
}

async function whisperTranslateToEnglish(mp3Path){
  const fd = new FormData();
  fd.append("file", fs.createReadStream(mp3Path));
  fd.append("model", "whisper-1");
  fd.append("translate", "true");
  const r = await fetch("https://api.openai.com/v1/audio/translations", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: fd,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Whisper translate failed: ${JSON.stringify(j)}`);
  return j.text || "";
}

// GPT: English → Traditional Chinese (繁體)
async function toTraditionalChinese(text){
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "你是專業翻譯，請將使用者的英文內容翻譯為自然、精準、正式的繁體中文（保留專有名詞）。不得添加任何評論或說明。" },
        { role: "user", content: text || "" }
      ],
      temperature: 0.2
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Traditional Chinese translation failed: ${JSON.stringify(j)}`);
  return j.choices?.[0]?.message?.content?.trim() || "";
}

// Ensure header row exists (analytics columns)
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
    const same = HEADER.length === current.length && HEADER.every((h,i)=>h===current[i]);
    if (!same) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: "Sheet1!A1:M1",
        valueInputOption: "RAW",
        requestBody: { values: [HEADER] },
      });
    }
  } catch (e) {
    console.error("⚠️ ensureHeader failed (continuing):", e.message || e);
  }
}

// ===== Background processor =====
async function processJob({ email, inputPath, fileMeta, requestId }) {
  const start = Date.now();
  const model = "whisper-1";
  let succeeded = false;
  let errorMessage = "";
  let minutes = 0;
  let language = "";
  let fileType = fileMeta.mimetype || "";
  let fileName = fileMeta.originalname || "upload";
  let fileSizeMB = Math.max(0.01, Math.round(((fileMeta.size || 0)/(1024*1024))*100)/100);

  const mp3Path = inputPath + ".mp3";

  try {
    // Convert to speech-optimized MP3: mono, 16 kHz, 64 kbps
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([ "-vn", "-ac 1", "-ar 16000", "-b:a 64k" ])
        .save(mp3Path)
        .on("end", resolve)
        .on("error", reject);
    });

    minutes = await getAudioMinutes(mp3Path);
    cumulativeMinutes += minutes;

    const [{ text: originalText, language: langCode }, englishText] = await Promise.all([
      whisperTranscribeVerbose(mp3Path),
      whisperTranslateToEnglish(mp3Path),
    ]);
    language = langCode || "";

    const zhTraditional = await toTraditionalChinese(englishText || originalText);

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

(Service account: ${SA_EMAIL})
(RequestId: ${requestId})`;

    await transporter.sendMail({
      from: `"Transcription Service" <${GMAIL_USER}>`,
      to: email,
      subject: "Your Bilingual Transcription (EN & 繁體中文)",
      text: mailBody,
    });

    succeeded = true;

  } catch (err) {
    errorMessage = err?.message || String(err);
    console.error("❌ Error processing upload (requestId " + requestId + "):", err);
  }

  // Append analytics row (even on failure)
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
  } catch (sheetErr) {
    console.error("⚠️ Sheets append failed (continuing):", sheetErr?.message || sheetErr);
  }

  // Cleanup temp files
  try { fs.unlinkSync(inputPath); } catch {}
  try { fs.unlinkSync(mp3Path);   } catch {}
}

// ===== Immediate-ack upload endpoint =====
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const email = (req.body.email || "").trim();
    if (!email) return res.status(400).json({ error: "Email is required" });
    if (!req.file) return res.status(400).json({ error: "File is required" });

    const requestId = crypto.randomUUID();

    // ✅ Frontend-friendly: include success:true
    res.status(202).json({ success: true, accepted: true, requestId });

    // Background processing (fire-and-forget)
    setImmediate(() =>
      processJob({ email, inputPath: req.file.path, fileMeta: req.file, requestId })
        .catch(e => console.error("Background job failed:", e))
    );

  } catch (err) {
    console.error("❌ Error accepting upload:", err);
    res.status(500).json({ error: "Processing failed at accept stage" });
  }
});

app.get("/", (_req, res) => res.send("✅ Whisper backend running"));
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server listening on port ${port}`);
  console.log("🔎 GOOGLE_APPLICATION_CREDENTIALS =", GOOGLE_KEYFILE);
});
