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

const app = express();
app.use(cors({ origin: "*" })); // you can lock to https://dottlight.com later
const upload = multer({ dest: "/tmp" });
ffmpeg.setFfmpegPath(ffmpegStatic);

// ==== ENV ====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
const SHEET_ID   = process.env.SHEET_ID;
if (!OPENAI_API_KEY || !GMAIL_USER || !GMAIL_PASS || !SHEET_ID) {
  console.error("❌ Missing env vars (OPENAI_API_KEY, GMAIL_USER, GMAIL_PASS, SHEET_ID)");
  process.exit(1);
}

// ==== Google Sheets ====
const auth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  // With GOOGLE_APPLICATION_CREDENTIALS set, googleapis will auto-load the key.
});
const sheets = google.sheets({ version: "v4", auth });

// ==== Email ====
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
});

// cumulative minutes (resets when Render instance restarts; the Sheet keeps history)
let cumulativeMinutes = 0;

// helper: precise audio duration (minutes)
function getAudioMinutes(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const sec = metadata.format?.duration || 0;
      resolve(Math.max(1, Math.ceil(sec / 60))); // at least 1 minute
    });
  });
}

// helper: call Whisper transcription
async function whisperTranscribe(mp3Path) {
  const fd = new FormData();
  fd.append("file", fs.createReadStream(mp3Path));
  fd.append("model", "whisper-1");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: fd,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Whisper transcribe failed: ${JSON.stringify(j)}`);
  return j.text || "";
}

// helper: call Whisper translate→English
async function whisperTranslateToEnglish(mp3Path) {
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

// helper: GPT to produce Chinese translation from English (or from original if English)
async function translateToChinese(text) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a precise translator. Translate to clear, natural Simplified Chinese without adding commentary." },
        { role: "user", content: text }
      ],
      temperature: 0.2
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Chinese translation failed: ${JSON.stringify(j)}`);
  return j.choices?.[0]?.message?.content?.trim() || "";
}

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const email = req.body.email?.trim();
    if (!email) return res.status(400).json({ error: "Email is required" });

    const inputPath = req.file.path;          // uploaded temp file
    const mp3Path   = inputPath + ".mp3";     // extracted audio

    // 1) Extract audio as MP3 (192 kbps stereo 44.1k)
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions(["-vn", "-ar 44100", "-ac 2", "-b:a 192k"])
        .save(mp3Path)
        .on("end", resolve)
        .on("error", reject);
    });

    // 2) Duration in minutes
    const minutes = await getAudioMinutes(mp3Path);
    cumulativeMinutes += minutes;

    // 3) Whisper: original-language transcript + English translation
    const [originalText, englishText] = await Promise.all([
      whisperTranscribe(mp3Path),
      whisperTranslateToEnglish(mp3Path),
    ]);

    // 4) Chinese translation (from English to guarantee clean CN)
    const chineseText = await translateToChinese(englishText || originalText);

    // 5) Log to Google Sheet (Date | Email | Minutes | Cumulative | Preview)
    const nowIso = new Date().toISOString();
    const preview = (englishText || originalText).slice(0, 120);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A:E",
      valueInputOption: "RAW",
      requestBody: { values: [[nowIso, email, minutes, cumulativeMinutes, preview]] },
    });

    // 6) Email the user
    const mailBody =
`Your transcription is ready.

— Minutes: ${minutes}
— Cumulative minutes: ${cumulativeMinutes}

== English ==
${englishText || originalText}

== Chinese (中文) ==
${chineseText}

== Original language ==
${originalText}

(Do not reply to this email. If you need help, contact support.)`;

    await transporter.sendMail({
      from: `"Transcription Service" <${GMAIL_USER}>`,
      to: email,
      subject: "Your Bilingual Transcription (EN & 中文)",
      text: mailBody,
    });

    // 7) Cleanup
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(mp3Path);   } catch {}

    // 8) Response to the page
    res.json({
      success: true,
      minutes,
      cumulativeMinutes,
      preview,
    });
  } catch (err) {
    console.error("❌ Error processing upload:", err);
    res.status(500).json({ error: "Processing failed" });
  }
});

app.get("/", (_req, res) => res.send("✅ Whisper backend running"));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));
