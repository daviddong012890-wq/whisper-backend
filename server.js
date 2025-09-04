import express from "express";
import multer from "multer";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import fetch from "node-fetch";
import FormData from "form-data";
import nodemailer from "nodemailer";
import { google } from "googleapis";

const app = express();
const upload = multer({ dest: "/tmp" }); // temp storage on Render
ffmpeg.setFfmpegPath(ffmpegStatic);

// ENV vars
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
const SHEET_ID = process.env.SHEET_ID;

if (!OPENAI_API_KEY || !GMAIL_USER || !GMAIL_PASS || !SHEET_ID) {
  console.error("Missing environment variables!");
  process.exit(1);
}

// Google Sheets auth
const auth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASS,
  },
});

// Track cumulative minutes in memory (reset if service restarts)
let cumulativeMinutes = 0;

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const email = req.body.email;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const inputPath = req.file.path;
    const outputPath = inputPath + ".mp3";

    // Extract audio
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions(["-vn", "-ar 44100", "-ac 2", "-b:a 192k"])
        .save(outputPath)
        .on("end", resolve)
        .on("error", reject);
    });

    // Send to Whisper
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

    // Estimate minutes from file size (better: use ffprobe duration)
    const stats = fs.statSync(outputPath);
    const minutes = Math.ceil(stats.size / (192 * 1024 * 60)); // rough est. at 192 kbps
    cumulativeMinutes += minutes;

    // Log to Google Sheet
    const now = new Date().toISOString();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A:E",
      valueInputOption: "RAW",
      requestBody: {
        values: [[now, email, minutes, cumulativeMinutes, result.text.substring(0, 100)]],
      },
    });

    // Send email
    await transporter.sendMail({
      from: `"Transcription Service" <${GMAIL_USER}>`,
      to: email,
      subject: "Your Transcription Result",
      text: `Here is your transcription:\n\n${result.text}\n\n---\nMinutes: ${minutes}\nCumulative: ${cumulativeMinutes}`,
    });

    // Cleanup
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

    res.json({ success: true, transcript: result.text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Processing failed" });
  }
});

// Health check
app.get("/", (req, res) => res.send("Whisper backend running ✅"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
