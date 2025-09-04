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

// Google Sheets client
const auth = new google.auth.GoogleAuth({
  keyFile: GOOGLE_KEYFILE,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// Gmail SMTP
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
});

// Cumulative minutes (resets on restart; sheet is durable)
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

// Convert any input to WAV mono 16k PCM with speech-friendly filters
async function toCleanWav(inPath){
  const out = inPath + ".wav";
  await new Promise((resolve, reject) => {
    ffmpeg(inPath)
      // denoise-ish chain: remove rumble & hiss, normalize dialog
      .audioFilters([
        "highpass=f=200",
        "lowpass=f=3800",
        "dynaudnorm"
      ])
      .outputOptions([
        "-vn",
        "-acodec", "pcm_s16le",
        "-ac", "1",
        "-ar", "16000",
        "-f", "wav"
      ])
      .save(out)
      .on("end", resolve)
      .on("error", reject);
  });
  return out;
}

// Whisper (verbose JSON -> language)
async function whisperTranscribeVerbose(wavPath){
  const fd = new FormData();
  fd.append("file", fs.createReadStream(wavPath), { filename: "audio.wav" });
  fd.append("model", "whisper-1");
  fd.append("response_format", "verbose_json");
  fd.append("temperature", "0");

  const r = await axios.post("https://api.openai.com/v1/audio/transcriptions", fd, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...fd.getHeaders() },
    maxBodyLength: Infinity,
  });
  return r.data; // { text, language, ... }
}

// Whisper translate -> English
async function whisperTranslateToEnglish(wavPath){
  const fd = new FormData();
  fd.append("file", fs.createReadStream(wavPath), { filename: "audio.wav" });
  fd.append("model", "whisper-1");
  fd.append("translate", "true");
  fd.append("temperature", "0");

  const r = await axios.post("https://api.openai.com/v1/audio/translations", fd, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...fd.getHeaders() },
    maxBodyLength: Infinity,
  });
  return r.data; // { text }
}

// GPT: EN -> Traditional Chinese
async function toTraditionalChinese(text){
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
  return r.data?.choices?.[0]?.message?.content?.trim() || "";
}

// Ensure sheet header
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
  const model = "whisper-1";
  let succeeded = false;
  let errorMessage = "";
  let minutes = 0;
  let language = "";
  let fileType = fileMeta.mimetype || "";
  let fileName = fileMeta.originalname || "upload";
  let fileSizeMB = Math.max(0.01, Math.round(((fileMeta.size || 0)/(1024*1024))*100)/100);

  const wavPath = await toCleanWav(inputPath).catch(e => { throw e; });

  try {
    minutes = await getAudioMinutes(wavPath);
    cumulativeMinutes += minutes;

    const verbose = await whisperTranscribeVerbose(wavPath);
    language = verbose.language || "";
    const originalText = verbose.text || "";

    const englishText = (await whisperTranslateToEnglish(wavPath)).text || originalText;
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
  } catch (sheetErr) {
    console.error("⚠️ Sheets append failed:", sheetErr?.message || sheetErr);
  }

  // Cleanup
  try { fs.unlinkSync(inputPath); } catch {}
  try { fs.unlinkSync(wavPath);   } catch {}
}

// ===== Immediate-ack upload =====
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const email = (req.body.email || "").trim();
    if (!email) return res.status(400).json({ error: "Email is required" });
    if (!req.file) return res.status(400).json({ error: "File is required" });

    const requestId = crypto.randomUUID();
    res.status(202).json({ success: true, accepted: true, requestId });

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
app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));
