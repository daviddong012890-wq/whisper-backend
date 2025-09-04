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

// Optionally parse JSON only to validate the key file (we no longer show SA email)
try { JSON.parse(fs.readFileSync(GOOGLE_KEYFILE,"utf8")); }
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

// ===== JOB TRACKING (simple status endpoint) =====
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

// ===== SHEET HEADER =====
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

// ===== PER-EMAIL CUMULATIVE (from durable history) =====
async function getPastMinutesForEmail(email){
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A2:J",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = resp.data.values || [];
    const target = (email||"").toLowerCase();
    let sum = 0;
    for (const r of rows){
      const em = (r[1] || "").toLowerCase();
      const succeeded = String(r[9] ?? "").toLowerCase() === "true";
      if (em === target && succeeded){
        const m = Number(r[2]);
        if (!Number.isNaN(m)) sum += m;
      }
    }
    return sum;
  } catch (e) {
    console.error("⚠️ getPastMinutesForEmail:", e.message || e);
    return 0;
  }
}

// ===== AUDIO PIPELINE =====
const OPENAI_AUDIO_MAX = 25 * 1024 * 1024; // ~25 MB hard API limit

function statBytes(p){ try { return fs.statSync(p).size; } catch { return 0; } }

// precise seconds for a single media file
function getSeconds(filePath){
  return new Promise((resolve, reject)=>{
    ffmpeg.ffprobe(filePath, (err, meta)=>{
      if (err) return reject(err);
      const sec = Number(meta?.format?.duration) || 0;
      resolve(sec);
    });
  });
}
// sum seconds over an array of paths; round to integer seconds
async function sumSeconds(paths){
  let total = 0;
  for (const p of paths) total += await getSeconds(p);
  return Math.round(total);
}
// minutes to write to sheet (ceil, min 1)
function secsToSheetMinutes(sec){
  return Math.max(1, Math.ceil((sec||0)/60));
}
function fmtZhSec(sec){
  const s = Math.max(0, Math.round(sec||0));
  const m = Math.floor(s/60);
  const r = s % 60;
  return `${m} 分 ${r} 秒`;
}

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
  const fallback = inMediaPath + `.24k.mp3`;
  await wavToMp3Filtered(tmpWav, fallback, 24);
  try { fs.unlinkSync(tmpWav); } catch {}
  return { path: fallback, kbps: 24, bytes: statBytes(fallback) };
}

async function splitIfNeeded(mp3Path, requestId){
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
    return r.data;
  } catch (err) {
    logAxiosError(`[${requestId}] Whisper transcribe`, err);
    throw new Error("Transcription failed");
  }
}

// ===== OpenAI: 原文 → 繁中（嚴格、去英文化） =====
async function zhTwFromOriginalFaithful(originalText, requestId){
  try {
    addStep(requestId, "Calling GPT 原文→繁中 (faithful, no English) …");
    const systemPrompt =
`你是國際會議的專業口筆譯員。請把使用者提供的「原文」完整翻譯成「繁體中文（台灣慣用）」並嚴格遵守：
1) 忠實轉譯：不可增刪、不可臆測，不加入任何評論；僅做必要語法與詞序調整以使中文通順。
2) 句序與段落：依原文順序與段落輸出；保留所有重複、口號與語氣詞。
3) 中英夾雜：凡是非中文的片段（英語詞句、人名地名、短語等）一律翻成中文。不得保留英文單字。
   - 例：「Hello, it’s a good day today.」→「你好，今天是個好日子。」
   - 人名採常見譯名或音譯（如 David → 大衛；Barack Obama → 歐巴馬／巴拉克・歐巴馬）。
   - 常見機構縮寫若無通行中譯可保留（例：NASA、AI），其餘請翻譯或加常見中譯（例：United States of America → 美利堅合眾國）。
4) 固定譯法（若出現）：Yes, we can. → 是的，我們可以。／ Yes, we did. → 是的，我們做到了。／ God bless you. → 上帝保佑你們。
5) 標點使用中文全形標點。數字、日期可依中文慣例書寫。
6) **只輸出中文譯文**，不可夾帶任何英文或說明。`;

    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: originalText || "" }
        ]
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    addStep(requestId, "繁中 (faithful) done.");
    return r.data?.choices?.[0]?.message?.content?.trim() || "";
  } catch (err) {
    logAxiosError(`[${requestId}] GPT 原文→繁中`, err);
    throw new Error("Traditional Chinese translation failed");
  }
}

// ===== PROCESSOR =====
async function processJob({ email, inputPath, fileMeta, requestId }){
  const started = Date.now();
  setJob(requestId, { status:"processing", metrics:{ started } });
  addStep(requestId, `Accepted: ${fileMeta.originalname} (${(fileMeta.size/1024/1024).toFixed(2)} MB)`);

  const model = "whisper-1";
  let succeeded = false;
  let errorMessage = "";
  let language = "";
  const fileType = fileMeta.mimetype || "";
  const fileName = fileMeta.originalname || "upload";
  const fileSizeMB = Math.max(0.01, Math.round(((fileMeta.size||0)/(1024*1024))*100)/100);

  // 1) Prepare & (if needed) split for 25MB limit
  let prepared = null;
  let parts = [];
  try {
    prepared = await prepareMp3UnderLimit(inputPath, requestId);
    parts = await splitIfNeeded(prepared.path, requestId);
  } catch (e) {
    errorMessage = "Transcode failed: " + (e?.message || e);
    addStep(requestId, "❌ " + errorMessage);
  }

  try {
    // precise seconds for this job (sum over parts or single)
    const jobSeconds = await sumSeconds(parts.length ? parts : [prepared.path || inputPath]);
    const minutesForSheet = secsToSheetMinutes(jobSeconds);
    addStep(requestId, `Duration this job: ${fmtZhSec(jobSeconds)} (sheet minutes = ${minutesForSheet}).`);

    // Cumulative per email from Sheet (minutes) → seconds for email display
    const pastMinutes = await getPastMinutesForEmail(email);
    const cumulativeMinutesForSheet = pastMinutes + minutesForSheet;
    const cumulativeSecondsForEmail = (pastMinutes * 60) + jobSeconds;
    addStep(requestId, `Cumulative (sheet): ${cumulativeMinutesForSheet} min; email shows ${fmtZhSec(cumulativeSecondsForEmail)}.`);

    // Transcribe original (chunk-aware)
    let originalAll = "";
    for (let i=0;i<parts.length;i++){
      const part = parts[i];
      if (parts.length > 1) addStep(requestId, `Part ${i+1}/${parts.length} …`);
      const verbose = await openaiTranscribeVerbose(part, requestId);
      if (!language) language = verbose.language || "";
      const originalText = verbose.text || "";
      originalAll += (originalAll ? "\n\n" : "") + originalText;
    }

    // Translate ORIGINAL → 繁中
    const zhTraditional = await zhTwFromOriginalFaithful(originalAll, requestId);

    // ===== 中文郵件（只含「繁中譯文」與「原文」） =====
    const mailBody =
`您的轉寫已完成。

— 本次長度：${fmtZhSec(jobSeconds)}
— 累計長度：${fmtZhSec(cumulativeSecondsForEmail)}

＝＝ 中文（繁體） ＝＝
${zhTraditional}

＝＝ 原文 ＝＝
${originalAll}

（請求編號：${requestId}）
（編碼參數：${prepared?.kbps || "?"} kbps，${(prepared?.bytes||0/1024/1024).toFixed(2)} MB${parts.length>1?`，共 ${parts.length} 個分段`:''}）`;

    addStep(requestId, "Sending email …");
    await mailer.sendMail({
      from: `"逐字稿產生器" <${GMAIL_USER}>`, // ← sender name updated
      to: email,
      subject: "您的轉寫結果（原文與繁體中文）",
      text: mailBody,
    });
    addStep(requestId, "Email sent.");
    succeeded = true;

    // Append row (per-email cumulative minutes for sheet)
    try {
      await ensureHeader();
      const row = [
        new Date().toISOString(),
        email,
        minutesForSheet,
        cumulativeMinutesForSheet,
        fileName,
        fileSizeMB || 0,
        language || "",
        requestId,
        Date.now() - started,
        true,
        "",
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

  } catch (err) {
    const eMsg = err?.message || "Processing error";
    addStep(requestId, "❌ " + eMsg);
    try {
      await ensureHeader();
      const row = [
        new Date().toISOString(),
        email,
        0,
        await getPastMinutesForEmail(email),
        fileName,
        fileSizeMB || 0,
        "",
        requestId,
        Date.now() - started, // fixed
        false,
        eMsg,
        "whisper-1",
        fileType
      ];
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: "Sheet1!A:M",
        valueInputOption: "RAW",
        requestBody: { values: [row] },
      });
    } catch {}
  }

  // Cleanup temp files
  try { fs.unlinkSync(inputPath); } catch {}
  try {
    if (fs.existsSync(inputPath + ".clean.wav")) fs.unlinkSync(inputPath + ".clean.wav");
    const dir = path.dirname(inputPath);
    fs.readdirSync(dir).forEach(n=>{
      if (n.startsWith(path.basename(inputPath)) && (n.endsWith(".mp3") || n.endsWith(".wav")))
        try { fs.unlinkSync(path.join(dir,n)); } catch {}
    });
  } catch {}

  setJob(requestId, {
    status: "done",
    error: null,
    metrics: { ...jobs.get(requestId)?.metrics, finished: Date.now() }
  });
  addStep(requestId, "✅ Done");
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
