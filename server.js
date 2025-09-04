import express from "express";
import multer from "multer";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import fetch from "node-fetch";
import FormData from "form-data";
import nodemailer from "nodemailer";
import { google } from "googleapis";
import cors from "cors";

const app = express();

// ✅ Allow cross-origin requests (so Google Site can call this API)
app.use(cors({
  origin: "*", // later you can lock this down to "https://dottlight.com"
}));

const upload = multer({ dest: "/tmp" }); // temp storage
ffmpeg.setFfmpegPath(ffmpegStatic);

// ENV vars
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
const SHEET_ID = process.env.SHEET_ID;

if (!OPENAI_API_KEY || !GMAIL_USER || !GMAIL_PASS || !SHEET_ID) {
  console.error("❌ Missing environment variables!");
  process.exit(1);
}

// Google Sheets setup
const auth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// Nodemailer setup
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASS,
  },
});

// Track cumulative minutes (resets if Render restarts)
let cumulativeMinutes = 0;

// Helper → get duration using ffmpeg
function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration / 60); // minutes
    });
  });
}

// Main upload route
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const email = req.body.email;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const inputPath = req.file.path;
    const outputPath = inputPath + ".mp3";

    // Convert to MP3
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions(["-vn", "-ar 44100", "-ac 2", "-b:a 192k"])
        .save(outputPath)
        .on("end", resolve)
        .on("error", reject);
    });

    // Get duration
    const durationMinutes = Math.ceil(await getAudioDuration(outputPath));
    cumulativeMinutes += durationMinutes;

    // Send audio to Whisper
    const formData = new FormData();
    formData.append("file", fs.createReadStream(outputPath));
    formData.append("model", "whisper-1");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: formData,
    });
    const result = await response.json();

    if (!result.text) throw new Error("Whisper failed: " + JSON.stringify(result));

    // Log to Google Sheets
    const now = new Date().toISOString();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A:E",
      valueInputOption: "RAW",
      requestBody: {
        values: [[now, email, durationMinutes, cumulativeMinutes, result.text.substring(0, 100)]],
      },
    });

    // Send email with transcript
    await transporter.sendMail({
      from: `"Transcription Service" <${GMAIL_USER}>`,
      to: email,
      subject: "Your Transcription Result",
      text: `Here is your transcription:\n\n${result.text}\n\n---\nMinutes: ${durationMinutes}\nCumulative: ${cumulativeMinutes}`,
    });

    // Clean up
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

    res.json({ success: true, transcript: result.text });
  } catch (err) {
    console.error("❌ Error processing upload:", err);
    res.status(500).json({ error: "Processing failed" });
  }
});

// Health check
app.get("/", (req, res) => res.send("✅ Whisper backend running"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));
