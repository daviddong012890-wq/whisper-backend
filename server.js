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

// read SA email just to show in logs/email footer
let SA_EMAIL = "";
try { SA_EMAIL = JSON.parse(fs.readFileSync(GOOGLE_KEYFILE,"utf8")).client_email || ""; }
catch(e){ fatal("Bad service-account JSON: " + e.message); }

// ===== SAFE LOGGING =====
function logAxiosError(prefix, err) {
  const status = err?.response?.status;
  const code   = err?.code;
  const msg = err?.response?.data?.error?.message || err?.message || String(err);
  console.error(`${prefix}${status ? " ["+status+"]" : ""}${code ? " ("+code+")" : ""}: ${msg}`);
}

// ===== GOOGLE =====
const auth = new google.auth.GoogleAuth({
  keyFile: GOOGLE_KEYFILE,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: { user: GMAIL_USER, pass: GMAIL_PASS }
});

// ===== JOB TRACKING =====
const jobs = new Map(); // id -> { status, steps[], error, metrics{} }
function addStep(id, text){
  const cur = jobs.get(id) || { status:"queued", steps:[], error:null, metrics:{} };
  cur.steps.push({ at: new Date().toISOString(), text });
  jobs.set(id, cur);
  console.log(`[${id}] ${text}`);
}
function setJob(id, patch){
  const cur = jobs.get(id) || { status:"queued", steps:[], error:null, metrics:{} };
  jobs.set(id, { ...cur, ...patch });
}
app.get("/status", (req,res)=>{
  const id = (req.query.id||"").toString();
  if (!id) return res.status(400).json({ error:"Missing id" });
  const j = jobs.get(id);
  if (!j) return res.status(404).json({ error:"Not found" });
  res.json(j);
});

// ===== SHEETS HEADER =====
const HEADER = [
  "Timestamp","Email","Minutes","CumulativeMinutes","FileName","FileSizeMB",
  "Language","RequestId","ProcessingMs","Succeeded","ErrorMessage","Model","FileType"
];
async function ensureHeader(){
  try {
    const got = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A1:M1",
    });
    const cur = got.data.values?.[0] || [];
    const ok = HEADER.length === cur.length && HEADER.every((h,i)=>h===cur[i]);
    if (!ok) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: "Sheet1!A1:M1",
        valueInputOption: "RAW",
        requestBody: { values: [HEADER] }
      });
    }
  } catch(e){ console.error("⚠️ ensureHeader:", e.message || e); }
}

// ===== AUDIO PIPELINE =====
const OPENAI_AUDIO_MAX = 25 * 1024 * 1024; // ~25 MB

function statBytes(p){ try { return fs.statSync(p).size; } catch { return 0; } }

function getAudioMinutes(filePath){
  return new Promise((resolve, reject)=>{
    ffmpeg.ffprobe(filePath, (err, meta)=>{
      if (err) return reject(err);
      const sec = meta?.format?.duration || 0;
      resolve(Math.max(1, Math.ceil(sec/60)));
    });
  });
}

// extract audio from any input to an intermediate WAV (for filtering)
async function extractToWav(inPath, outPath){
  await new Promise((resolve, reject)=>{
    ffmpeg(inPath)
      .noVideo()
      .audioCodec("pcm_s16le")
      .audioChannels(1)
      .audioFrequency(16000)
      .format("wav")
      .save(outPath)
      .on("end", resolve)
      .on("error", reject);
  });
  return outPath;
}

// apply denoise/normalize and encode MP3 mono 16kHz at chosen bitrate
async function wavToMp3Filtered(inWav, outMp3, kbps){
  await new Promise((resolve, reject)=>{
    ffmpeg(inWav)
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
      .save(outMp3)
      .on("end", resolve)
      .on("error", reject);
  });
  return outMp3;
}

// Try 64 → 48 → 32 → 24 kbps until ≤ 25 MB
async function prepareMp3UnderLimit(inMediaPath, requestId){
  const tmpWav = inMediaPath + ".clean.wav";
  addStep(requestId, "Extracting audio → WAV …");
  await extractToWav(inMediaPath, tmpWav);

  const ladder = [64, 48, 32, 24]; // kbps
  for (const kb of ladder){
    const candidate = inMediaPath + `.${kb}k.mp3`;
    addStep(requestId, `Encode MP3 ${kb} kbps …`);
    await wavToMp3Filtered(tmpWav, candidate, kb);
    const sz = statBytes(candidate);
    addStep(requestId, `MP3 ${kb} kbps = ${(sz/1024/1024).toFixed(2)} MB`);
    if (sz <= OPENAI_AUDIO_MAX) {
      try { fs.unlinkSync(tmpWav); } catch {}
      return { path: candidate, kbps: kb, bytes: sz };
    }
    try { fs.unlinkSync(candidate); } catch {}
  }
  // keep 24k result anyway
  const fallback = inMediaPath + `.24k.mp3`;
  await wavToMp3Filtered(tmpWav, fallback, 24);
  try { fs.unlinkSync(tmpWav); } catch {}
  return { path: fallback, kbps: 24, bytes: statBytes(fallback) };
}

// If still > 25MB (very long audio), split into parts
async function splitIfNeeded(mp3Path, kbps, requestId){
  const size = statBytes(mp3Path);
  if (size <= OPENAI_AUDIO_MAX) return [mp3Path];

  addStep(requestId, "File still >25MB — segmenting …");
  const dir = path.dirname(mp3Path);
  const base = path.basename(mp3Path, ".mp3");
  const pattern = path.join(dir, `${base}.part-%03d.mp3`);

  const segmentSeconds = 900; // 15 minutes
  await new Promise((resolve, reject)=>{
    ffmpeg(mp3Path)
      .outputOptions([
        "-f", "segment",
        "-segment_time", `${segmentSeconds}`,
        "-reset_timestamps", "1"
      ])
      .save(pattern)
      .on("end", resolve)
      .on("error", reject);
  });

  const parts = fs.readdirSync(dir)
    .filter(n => n.startsWith(`${base}.part-`) && n.endsWith(".mp3"))
    .map(n => path.join(dir, n))
    .sort();

  addStep(requestId, `Created ${parts.length} segment(s).`);
  return parts;
}

// ===== OpenAI: Whisper =====
async function openaiTranscribeVerbose(audioPath, requestId){
  try {
    addStep(requestId, "Calling Whisper /transcriptions …");
    const fd = new FormData();
    fd.append("file", fs.createReadStream(audioPath), { filename: path.basename(audioPath) });
    fd.append("model", "whisper-1");
    fd.append("response_format", "verbose_json");
    fd.append("temperature", "0");
    const r = await axios.post("https://api.openai.com/v1/audio/transcriptions", fd, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...fd.getHeaders() },
      maxBodyLength: Infinity,
    });
    addStep(requestId, "Transcription done.");
    return r.data; // { text, language, segments… }
  } catch (err) {
    logAxiosError(`[${requestId}] Whisper transcribe`, err);
    throw new Error("Transcription failed");
  }
}
async function openaiTranslateToEnglish(audioPath, requestId){
  try {
    addStep(requestId, "Calling Whisper /translations (EN) …");
    const fd = new FormData();
    fd.append("file", fs.createReadStream(audioPath), { filename: path.basename(audioPath) });
    fd.append("model", "whisper-1");
    fd.append("translate", "true");
    fd.append("temperature", "0");
    const r = await axios.post("https://api.openai.com/v1/audio/translations", fd, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...fd.getHeaders() },
      maxBodyLength: Infinity,
    });
    addStep(requestId, "English translation done.");
    return r.data; // { text }
  } catch (err) {
    logAxiosError(`[${requestId}] Whisper translate→EN`, err);
    throw new Error("English translation failed");
  }
}

// ===== OpenAI: STRICT EN→繁中 =====
async function strictZhTwTranslate(englishText, requestId){
  try {
    addStep(requestId, "Calling GPT EN→繁中 (strict) …");
    const systemPrompt =
`你是專業口筆譯員。請「逐句、忠實」將英文翻成「繁體中文（台灣用字）」，並嚴格遵守：
1) 不可增刪、不改寫、不意譯；只做必要的語法轉換。
2) 保留重複與修辭（例如連續出現的 "Thank you." 必須完整保留次數）。
3) 依原文段落與換行輸出；不要合併或拆分句子。
4) 專有名詞固定：
   - United States of America → 美利堅合眾國
   - Yes, we can. → 是的，我們可以。
   - Yes, we did. → 是的，我們做到了。
   - God bless you. → 上帝保佑你們。
5) 標點：中文全形標點；數字、專名、日期照原文保留或慣用譯名。
6) 只輸出中文譯文，**不得**加入任何說明或註解。`;

    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: englishText || "" }
        ]
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    addStep(requestId, "繁中 (strict) done.");
    return r.data?.choices?.[0]?.message?.content?.trim() || "";
  } catch (err) {
    logAxiosError(`[${requestId}] GPT EN→繁中 (strict)`, err);
    throw new Error("Traditional Chinese translation failed");
  }
}

// ===== PROCESSOR =====
let cumulativeMinutes = 0;

async function processJob({ email, inputPath, fileMeta, requestId }){
  const started = Date.now();
  setJob(requestId, { status:"processing", metrics:{ started } });
  addStep(requestId, `Accepted: ${fileMeta.originalname} (${(fileMeta.size/1024/1024).toFixed(2)} MB)`);

  const model = "whisper-1";
  let succeeded = false;
  let errorMessage = "";
  let minutes = 0;
  let language = "";
  const fileType = fileMeta.mimetype || "";
  const fileName = fileMeta.originalname || "upload";
  const fileSizeMB = Math.max(0.01, Math.round(((fileMeta.size||0)/(1024*1024))*100)/100);

  // 1) Prepare MP3 under limit (and split if needed)
  let prepared = null;
  let parts = [];
  try {
    prepared = await prepareMp3UnderLimit(inputPath, requestId);
    parts = await splitIfNeeded(prepared.path, prepared.kbps, requestId);
  } catch (e) {
    errorMessage = "Transcode failed: " + (e?.message || e);
    addStep(requestId, "❌ " + errorMessage);
  }

  try {
    // Total minutes based on final audio
    minutes = await getAudioMinutes(parts[0] || prepared.path || inputPath);
    if (parts.length > 1) {
      let totalSec = 0;
      for (const p of parts){
        const sec = await new Promise((resolve, reject)=>{
          ffmpeg.ffprobe(p, (err, meta)=>{
            if (err) return reject(err);
            resolve(meta?.format?.duration || 0);
          });
        });
        totalSec += sec;
      }
      minutes = Math.max(1, Math.ceil(totalSec/60));
    }
    cumulativeMinutes += minutes;
    addStep(requestId, `Minutes: ${minutes} (cumulative ${cumulativeMinutes}).`);

    // 2) Transcribe + English (chunk-aware)
    let originalAll = "";
    let englishAll  = "";
    for (let i=0;i<parts.length;i++){
      const part = parts[i];
      if (parts.length > 1) addStep(requestId, `Part ${i+1}/${parts.length} …`);
      const verbose = await openaiTranscribeVerbose(part, requestId);
      if (!language) language = verbose.language || "";
      const originalText = verbose.text || "";
      const englishText  = (await openaiTranslateToEnglish(part, requestId)).text || originalText;
      originalAll += (originalAll ? "\n\n" : "") + originalText;
      englishAll  += (englishAll  ? "\n\n" : "") + englishText;
    }

    // 3) Strict Traditional Chinese
    const zhTraditional = await strictZhTwTranslate(englishAll || originalAll, requestId);

    // 4) Email
    const mailBody =
`Your transcription is ready.

— Minutes: ${minutes}
— Cumulative minutes: ${cumulativeMinutes}

== English ==
${englishAll || originalAll}

== 中文（繁體） ==
${zhTraditional}

== Original language ==
${originalAll}

(Service account: ${SA_EMAIL})
(RequestId: ${requestId})
(Encoded: ${prepared?.kbps || "?"} kbps, ${(prepared?.bytes||0/1024/1024).toFixed(2)} MB${parts.length>1?`, ${parts.length} segment(s)`:''})`;

    addStep(requestId, "Sending email …");
    await mailer.sendMail({
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

  // 5) Sheet row
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
      Date.now() - started,
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
    addStep(requestId, "Sheet updated.");
  } catch (e) {
    addStep(requestId, "⚠️ Sheet append failed: " + (e?.message || e));
  }

  // 6) Cleanup
  try { fs.unlinkSync(inputPath); } catch {}
  try {
    if (prepared?.path && fs.existsSync(prepared.path)) fs.unlinkSync(prepared.path);
    const dir = path.dirname(inputPath);
    fs.readdirSync(dir).forEach(n=>{
      if (n.startsWith(path.basename(inputPath)) && (n.endsWith(".mp3") || n.endsWith(".wav")))
        try { fs.unlinkSync(path.join(dir,n)); } catch {}
    });
  } catch {}

  setJob(requestId, {
    status: succeeded ? "done" : "error",
    error: succeeded ? null : errorMessage,
    metrics: { ...jobs.get(requestId)?.metrics, finished: Date.now() }
  });
  addStep(requestId, succeeded ? "✅ Done" : "❌ Finished with error");
}

// ===== ROUTES =====
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const email = (req.body.email || "").trim();
    if (!email) return res.status(400).json({ error: "Email is required" });
    if (!req.file) return res.status(400).json({ error: "File is required" });

    const requestId = crypto.randomUUID();
    setJob(requestId, { status:"accepted", steps:[], error:null, metrics:{} });
    addStep(requestId, "Upload accepted.");

    res.status(202).json({ success:true, accepted:true, requestId });

    setImmediate(()=>processJob({ email, inputPath: req.file.path, fileMeta: req.file, requestId })
      .catch(e=>{
        addStep(requestId, "❌ Background crash: " + (e?.message || e));
        setJob(requestId, { status:"error", error: e?.message || String(e) });
      })
    );
  } catch (err) {
    console.error("❌ accept error:", err?.message || err);
    res.status(500).json({ error: "Processing failed at accept stage" });
  }
});

app.get("/", (_req, res)=>res.send("✅ Whisper backend running"));
const port = process.env.PORT || 3000;
app.listen(port, ()=>console.log(`🚀 Server listening on port ${port}`));
