import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import fetch from "node-fetch";
import FormData from "form-data";
import nodemailer from "nodemailer";
import { google } from "googleapis";

const app = express();
app.use(cors({ origin: "*" })); // lock to https://dottlight.com later if you want
const upload = multer({ dest: "/tmp" });
ffmpeg.setFfmpegPath(ffmpegStatic);

// ===== ENV =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GMAIL_USER     = process.env.GMAIL_USER;
const GMAIL_PASS     = process.env.GMAIL_PASS;
const SHEET_ID       = process.env.SHEET_ID;
const GOOGLE_KEYFILE = process.env.GOOGLE_APPLICATION_CREDENTIALS; // e.g. /etc/secrets/gcp-sa.json

function fatal(msg) { console.error("❌ " + msg); process.exit(1); }

if (!OPENAI_API_KEY) fatal("Missing OPENAI_API_KEY");
if (!GMAIL_USER || !GMAIL_PASS) fatal("Missing GMAIL_USER or GMAIL_PASS");
if (!SHEET_ID) fatal("Missing SHEET_ID");
if (!GOOGLE_KEYFILE) fatal("Missing GOOGLE_APPLICATION_CREDENTIALS (path to your service-account JSON)");

// ===== Verify key file exists & show the service-account email =====
if (!fs.existsSync(GOOGLE_KEYFILE)) {
  fatal(`Service-account key file not found at ${GOOGLE_KEYFILE}. Did you add it as a Secret File on Render and set GOOGLE_APPLICATION_CREDENTIALS to /etc/secrets/gcp-sa.json?`);
}
let SA_EMAIL = "";
try {
  const raw = fs.readFileSync(GOOGLE_KEYFILE, "utf8");
  const j = JSON.parse(raw);
  SA_EMAIL = j.client_email || "";
  console.log("🔑 Using service account:", SA_EMAIL);
  console.log("🔑 Key path:", GOOGLE_KEYFILE);
} catch (e) {
  fatal("Could not read/parse service-account JSON: " + e.message);
}

// ===== Google Sheets (explicitly point to the key file) =====
const auth = new google.auth.GoogleAuth({
  keyFile: GOOGLE_KEYFILE,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// ===== Email (Gmail SMTP) =====
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
});

// ===== Helpers =====
let cumulativeMinutes = 0;

function getAudioMinutes(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return reject(err);
      const seconds = meta?.format?.duration || 0;
      resolve(Math.max(1, Math.ceil(seconds / 60)));
    });
  });
}

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
        { role: "user", content: text || "" }
      ],
      temperature: 0.2
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Chinese translation failed: ${JSON.stringify(j)}`);
  return j.choices?.[0]?.message?.content?.trim() || "";
}

// ===== Main upload endpoint =====
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const email = (req.body.email || "").trim();
    if (!email) return res.status(400).json({ error: "Email is required" });

    const inputPath = req.file.path;
    const mp3Path = inputPath + ".mp3";

    // Extract audio to MP3
    await new Promise((resolve, reject) => {
      ffmpeg(inp
