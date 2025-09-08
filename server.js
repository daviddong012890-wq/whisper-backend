// server.js — smooth "fictional" progress version
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
import { Document, Packer, Paragraph } from "docx";

// ---------- notify PHP (worker-consume.php) ----------
const CONSUME_URL = process.env.CONSUME_URL || "";
const WORKER_SHARED_KEY = process.env.WORKER_SHARED_KEY || "";

async function consume(payload) {
  if (!CONSUME_URL) return;
  try {
    await axios.post(CONSUME_URL, payload, {
      headers: WORKER_SHARED_KEY ? { "X-Worker-Key": WORKER_SHARED_KEY } : {},
      timeout: 10000
    });
    console.log("→ consume() POST ok");
  } catch (e) {
    console.error("consume() error:", e?.response?.status || "", e?.message || e);
  }
}

// ---------- app / setup ----------
const app = express();
app.use(cors({ origin: "*" }));
app.options("*", cors());
const upload = multer({ dest: "/tmp" });
ffmpeg.setFfmpegPath(ffmpegStatic);

// ---------- env checks ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GMAIL_USER     = process.env.GMAIL_USER;   // help@voixl.com
const GMAIL_PASS     = process.env.GMAIL_PASS;   // app password
const SHEET_ID       = process.env.SHEET_ID;
const GOOGLE_KEYFILE = process.env.GOOGLE_APPLICATIONS_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS;
const LOCAL_TZ       = process.env.LOCAL_TZ || "America/Los_Angeles";

// UI progress tuning (optional env)
const UI_BASE_MS = Number(process.env.UI_BASE_MS || 25000);            // base budget
const UI_PER_MB_MS = Number(process.env.UI_PER_MB_MS || 1200);         // add budget per MB
const UI_CAP_BEFORE_DONE = Number(process.env.UI_CAP_BEFORE_DONE || 97); // % cap until real done
const UI_SLOW_MS_PER_PERCENT = Number(process.env.UI_SLOW_MS_PER_PERCENT || 4000); // how fast to crawl after budget

// mail "from" address (defaults to GMAIL_USER)
const FROM_EMAIL = process.env.FROM_EMAIL || GMAIL_USER;
const FROM_NAME  = process.env.FROM_NAME  || "逐字稿產生器";

function fatal(m){ console.error("❌ " + m); process.exit(1); }
if (!OPENAI_API_KEY) fatal("Missing OPENAI_API_KEY");
if (!GMAIL_USER || !GMAIL_PASS) fatal("Missing GMAIL_USER or GMAIL_PASS");
if (!SHEET_ID) fatal("Missing SHEET_ID");
if (!GOOGLE_KEYFILE) fatal("Missing GOOGLE_APPLICATIONS_CREDENTIALS");
if (!fs.existsSync(GOOGLE_KEYFILE)) fatal(`Key not found at ${GOOGLE_KEYFILE}`);
try { JSON.parse(fs.readFileSync(GOOGLE_KEYFILE,"utf8")); } catch(e){ fatal("Bad service-account JSON: " + e.message); }

// ---------- helpers ----------
function logAxiosError(prefix, err) {
  const status = err?.response?.status;
  const code   = err?.code;
  const msg = err?.response?.data?.error?.message || err?.message || String(err);
  console.error(`${prefix}${status ? " ["+status+"]" : ""}${code ? " ("+code+")" : ""}: ${msg}`);
}

const auth = new google.auth.GoogleAuth({
  keyFile: GOOGLE_KEYFILE,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});
const sheets = google.sheets({ version: "v4", auth });

// ---------- MAILER (explicit Gmail SMTP) ----------
const mailer = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: { user: GMAIL_USER, pass: GMAIL_PASS }
});

// ---------- in-memory job tracker (for /status) ----------
const jobs = new Map();

// ensure a job structure exists; also houses UI smoothing plan
function ensureJob(id) {
  return jobs.get(id) || {
    status: "queued",
    steps: [],
    error: null,
    metrics: {},
    // UI smoothing state:
    ui: {
      startMs: Date.now(),
      budgetMs: 60000,
      lastPct: 0,
      capBeforeDone: UI_CAP_BEFORE_DONE,
      // for over-budget crawl:
      slowMsPerPercent: UI_SLOW_MS_PER_PERCENT,
      // optional static copy; can be updated freely:
      description: "Queued…"
    }
  };
}
function addStep(id, text) {
  const cur = ensureJob(id);
  cur.steps.push({ at: new Date().toISOString(), text });
  cur.ui.description = text; // keep UI line fresh
  jobs.set(id, cur);
  console.log(`[${id}] ${text}`);
}
function setJob(id, patch) {
  const cur = ensureJob(id);
  jobs.set(id, { ...cur, ...patch });
}

// Compute a smooth, time-based UI % that never goes backwards.
// - Ramps 0 → cap (e.g., 97%) across budgetMs
// - If the job takes longer, keep creeping toward cap (slow crawl)
// - When job.status === "done", return 100 (and record lastPct=100)
function computeUiProgress(job) {
  const now = Date.now();
  const ui = job.ui || { startMs: now, budgetMs: 60000, lastPct: 0, capBeforeDone: UI_CAP_BEFORE_DONE, slowMsPerPercent: UI_SLOW_MS_PER_PERCENT, description: "" };
  const { startMs, budgetMs, capBeforeDone, slowMsPerPercent } = ui;

  let pct;
  if (job.status === "done") {
    pct = 100;
  } else {
    const elapsed = Math.max(0, now - startMs);
    if (elapsed <= budgetMs) {
      pct = (elapsed / budgetMs) * capBeforeDone;
    } else {
      // Over budget: creep forward but don’t look stuck.
      const over = elapsed - budgetMs;
      const extra = over / slowMsPerPercent; // percent points gained since budget exhausted
      pct = Math.min(capBeforeDone, capBeforeDone * 0.9 + extra); // asymptote-ish
    }
  }
  // monotonic & clamped
  pct = Math.max(ui.lastPct || 0, Math.min(100, Math.round(pct)));
  ui.lastPct = pct;
  job.ui = ui;
  return pct;
}

// Friendly copy for the bar; you can customize ranges freely
function progressDescription(pct, fallback) {
  if (pct < 5)  return "Queued…";
  if (pct < 15) return "Preparing upload…";
  if (pct < 30) return "Extracting audio…";
  if (pct < 45) return "Cleaning & encoding…";
  if (pct < 60) return "Splitting if needed…";
  if (pct < 75) return "Transcribing…";
  if (pct < 90) return "Translating…";
  if (pct < 97) return "Packaging & emailing…";
  if (pct < 100) return "Finalizing…";
  return fallback || "Done";
}

app.get("/status", (req, res) => {
  const id = (req.query.id || "").toString();
  if (!id) return res.status(400).json({ error: "Missing id" });
  const j = jobs.get(id);
  if (!j) return res.status(404).json({ error: "Not found" });
  const progress = computeUiProgress(j);
  const description = progressDescription(progress, j.ui?.description || j.steps?.slice(-1)?.[0]?.text || "");
  res.json({ ...j, progress, description });
});

// ---------- time / format ----------
function fmtLocalStamp(d){
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LOCAL_TZ, year:"numeric", month:"short", day:"numeric",
    hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:true
  }).formatToParts(d);
  let Y,M,D,hh,mm,ss,ap;
  for (const p of parts){
    if (p.type==="year") Y=p.value;
    else if (p.type==="month") M=p.value;
    else if (p.type==="day") D=p.value;
    else if (p.type==="hour") hh=p.value;
    else if (p.type==="minute") mm=p.value;
    else if (p.type==="second") ss=p.value;
    else if (p.type==="dayPeriod") ap=p.value.toUpperCase();
  }
  return `${Y} ${M} ${D} ${hh}:${mm}:${ss} ${ap}`;
}
function secsToSheetMinutes(sec){
  return Math.max(1, Math.ceil((sec||0)/60));
}

// ---------- sheet header ----------
const HEADER = [
  "TimestampUTC","TimestampLocal","Email",
  "Seconds","CumulativeSeconds",
  "Minutes","CumulativeMinutes",
  "FileName","FileSizeMB","Language","RequestId",
  "ProcessingMs","Succeeded","ErrorMessage","Model","FileType"
];
async function ensureHeader(){
  try {
    const got = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: "Sheet1!A1:P1"
    });
    const cur = got.data.values?.[0] || [];
    const ok = HEADER.length === cur.length && HEADER.every((h,i)=>h===cur[i]);
    if (!ok) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: "Sheet1!A1:P1",
        valueInputOption: "RAW",
        requestBody: { values: [HEADER] }
      });
    }
  } catch(e){ console.error("⚠️ ensureHeader:", e.message || e); }
}

function normEmail(x){ return String(x || "").trim().toLowerCase(); }
function truthy(x){
  const s = String(x ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}
async function getColumnMap(){
  const hdr = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: "Sheet1!A1:Z1"
  });
  const row = hdr.data.values?.[0] || [];
  const map = {};
  row.forEach((name, idx) => { map[String(name || "").trim()] = idx; });
  return {
    idxEmail:     map["Email"],
    idxSeconds:   map["Seconds"],
    idxMinutes:   map["Minutes"],
    idxSucceeded: map["Succeeded"],
    legacySucceededIdx: (map["Succeeded"] ?? 9)
  };
}
async function getPastSecondsForEmail(email){
  try {
    const cm = await getColumnMap();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: "Sheet1!A2:Z",
      valueRenderOption: "UNFORMATTED_VALUE"
    });
    const rows = resp.data.values || [];
    const target = normEmail(email);
    let totalSeconds = 0;
    for (const r of rows){
      if (!r) continue;
      const em = normEmail(r[cm.idxEmail]);
      if (em !== target) continue;
      const succIdx = Number.isInteger(cm.idxSucceeded) ? cm.idxSucceeded : cm.legacySucceededIdx;
      const succeeded = truthy(r[succIdx]);
      if (!succeeded) continue;
      const sec = Number(r[cm.idxSeconds]);
      if (!Number.isNaN(sec) && sec > 0){ totalSeconds += sec; continue; }
      const min = Number(r[cm.idxMinutes]);
      if (!Number.isNaN(min) && min > 0){ totalSeconds += (min * 60); }
    }
    return totalSeconds;
  } catch (e) {
    console.error("⚠️ getPastSecondsForEmail:", e.message || e);
    return 0;
  }
}

// ---------- audio pipeline ----------
const OPENAI_AUDIO_MAX = 25 * 1024 * 1024;

function statBytes(p){ try { return fs.statSync(p).size; } catch { return 0; } }

function getSecondsOne(filePath){
  return new Promise((resolve, reject)=>{
    ffmpeg.ffprobe(filePath, (err, meta)=>{
      if (err) return reject(err);
      resolve(Number(meta?.format?.duration) || 0);
    });
  });
}
async function sumSeconds(paths){
  let t = 0;
  for (const p of paths) t += await getSecondsOne(p);
  return Math.round(t);
}
async function extractToWav(inPath, _outPath){ // (we'll set path inside)
  const outPath = inPath + ".clean.wav";
  await new Promise((resolve, reject)=>{
    ffmpeg(inPath).noVideo()
      .audioCodec("pcm_s16le").audioChannels(1).audioFrequency(16000)
      .format("wav").save(outPath).on("end", resolve).on("error", reject);
  });
  return outPath;
}
async function wavToMp3Filtered(inWav, outMp3, kbps){
  await new Promise((resolve, reject)=>{
    ffmpeg(inWav)
      .audioFilters(["highpass=f=200","lowpass=f=3800","dynaudnorm"])
      .outputOptions(["-vn","-ac","1","-ar","16000","-b:a",`${kbps}k","-codec:a","libmp3lame"])
      .save(outMp3).on("end", resolve).on("error", reject);
  });
  return outMp3;
}
async function prepareMp3UnderLimit(inMediaPath, requestId){
  const tmpWav = await extractToWav(inMediaPath);
  addStep(requestId, "Extracting audio → WAV …");
  const ladder = [64,48,32,24];
  for (const kb of ladder){
    addStep(requestId, `Encode MP3 ${kb} kbps …`);
    const out = inMediaPath + `.${kb}k.mp3`;
    await wavToMp3Filtered(tmpWav, out, kb);
    const sz = statBytes(out);
    addStep(requestId, `MP3 ${kb} kbps = ${(sz/1024/1024).toFixed(2)} MB`);
    if (sz <= OPENAI_AUDIO_MAX){ try{fs.unlinkSync(tmpWav);}catch{} return { path: out, kbps: kb, bytes: sz }; }
    try{ fs.unlinkSync(out);}catch{}
  }
  const fallback = inMediaPath + `.24k.mp3`;
  await wavToMp3Filtered(tmpWav, fallback, 24);
  try{ fs.unlinkSync(tmpWav);}catch{}
  return { path:fallback, kbps:24, bytes: statBytes(fallback) };
}
async function splitIfNeeded(mp3Path, requestId){
  if (statBytes(mp3Path) <= OPENAI_AUDIO_MAX) return [mp3Path];
  addStep(requestId, "File still >25MB — segmenting …");
  const dir = path.dirname(mp3Path);
  const base = path.basename(mp3Path, ".mp3");
  const pattern = path.join(dir, `${base}.part-%03d.mp3`);
  await new Promise((resolve, reject)=>{
    ffmpeg(mp3Path).outputOptions(["-f","segment","-segment_time","900","-reset_timestamps","1"])
      .save(pattern).on("end", resolve).on("error", reject);
  });
  return fs.readdirSync(dir).filter(n=>n.startsWith(`${base}.part-`)&&n.endsWith(".mp3"))
    .map(n=>path.join(dir,n)).sort();
}

// ---------- OpenAI ----------
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
      maxBodyLength: Infinity
    });
    addStep(requestId, "Transcription done.");
    return r.data;
  } catch (err) {
    logAxiosError(`[${requestId}] Whisper transcribe`, err);
    throw new Error("Transcription failed");
  }
}
async function zhTwFromOriginalFaithful(originalText, requestId){
  try {
    addStep(requestId, "Translating to Traditional Chinese …");
    const systemPrompt =
`你是國際會議的專業口筆譯員。請把使用者提供的「原文」完整翻譯成「繁體中文（台灣慣用）」並嚴格遵守：
1) 忠實轉譯：不可增刪、不可臆測，不加入任何評論；僅做必要語法與詞序調整以使中文通順。
2) 句序與段落：依原文順序與段落輸出；保留所有重複、口號與語氣詞。
3) 中英夾雜：凡是非中文的片段（任何語種的詞句、人名地名、術語）盡量翻成中文。
4) 標點使用中文全形標點。只輸出中文譯文。`;
    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model:"gpt-4o-mini", temperature:0, messages:[
        { role:"system", content: systemPrompt },
        { role:"user", content: originalText || "" }
      ]},
      { headers:{ Authorization:`Bearer ${OPENAI_API_KEY}` } }
    );
    addStep(requestId, "Translation done.");
    return r.data?.choices?.[0]?.message?.content?.trim() || "";
  } catch (err) {
    logAxiosError(`[${requestId}] GPT 原文→繁中`, err);
    throw new Error("Traditional Chinese translation failed");
  }
}

// ---------- main processor ----------
async function processJob({ email, inputPath, fileMeta, requestId, jobId, token }){
  const started = Date.now();
  const fileSizeMB = Math.max(0.01, Math.round(((fileMeta.size||0)/(1024*1024))*100)/100);

  // Set up UI plan for smooth progress:
  const budgetMs = Math.max(30000, UI_BASE_MS + UI_PER_MB_MS * Math.min(fileSizeMB, 500)); // clamp 0–500MB
  setJob(requestId, {
    status:"processing",
    metrics:{ started },
    ui: {
      startMs: Date.now(),
      budgetMs,
      lastPct: 0,
      capBeforeDone: UI_CAP_BEFORE_DONE,
      slowMsPerPercent: UI_SLOW_MS_PER_PERCENT,
      description: "Preparing…"
    }
  });
  addStep(requestId, `Accepted: ${fileMeta.originalname} (${fileSizeMB.toFixed(2)} MB)`);

  const model = "whisper-1";
  let language = "";
  const fileType = fileMeta.mimetype || "";
  const fileName = fileMeta.originalname || "upload";

  let prepared, parts=[];

  try {
    // 1) prepare + maybe split
    prepared = await prepareMp3UnderLimit(inputPath, requestId);
    parts = await splitIfNeeded(prepared.path, requestId);

    // 2) duration & cumulative
    const filesForDuration = (parts && parts.length) ? parts : [prepared?.path || inputPath];
    addStep(requestId, "Measuring duration …");
    const jobSeconds = await sumSeconds(filesForDuration);
    const minutesForSheet = secsToSheetMinutes(jobSeconds);
    const pastSeconds = await getPastSecondsForEmail(email);
    const cumulativeSeconds = pastSeconds + jobSeconds;
    const cumulativeMinutesForSheet = secsToSheetMinutes(cumulativeSeconds);
    addStep(requestId, `Duration this job: ${jobSeconds}s; cumulative: ${cumulativeSeconds}s.`);

    // 3) transcribe + translate
    let originalAll = "";
    const filesForTranscription = (parts && parts.length) ? parts : [prepared?.path || inputPath];
    for (let i=0;i<filesForTranscription.length;i++){
      if (filesForTranscription.length>1) addStep(requestId, `Part ${i+1}/${filesForTranscription.length} …`);
      const verbose = await openaiTranscribeVerbose(filesForTranscription[i], requestId);
      if (!language) language = verbose.language || "";
      originalAll += (originalAll ? "\n\n" : "") + (verbose.text || "");
    }
    const zhTraditional = await zhTwFromOriginalFaithful(originalAll, requestId);

    // email attachments: TXT + DOCX only
    const localStamp = fmtLocalStamp(new Date());
    const attachmentText = `＝＝ 中文（繁體） ＝＝
${zhTraditional}

＝＝ 原文 ＝＝
${originalAll}
`;
    const safeBase = (fileName || "transcript").replace(/[^\w.-]+/g, "_").slice(0, 50) || "transcript";
    const txtName  = `${safeBase}-${requestId}.txt`;
    const docxName = `${safeBase}-${requestId}.docx`;

    const doc = new Document({
      sections: [{
        children: [
          new Paragraph("＝＝ 中文（繁體） ＝＝"),
          ...String(zhTraditional || "").split("\n").map(line => new Paragraph(line)),
          new Paragraph(""),
          new Paragraph("＝＝ 原文 ＝＝"),
          ...String(originalAll || "").split("\n").map(line => new Paragraph(line))
        ]
      }]
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
        { filename: txtName,  content: attachmentText, contentType: "text/plain; charset=utf-8" },
        { filename: docxName, content: docxBuffer,    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
      ]
    });
    addStep(requestId, "Email sent.");

    // 4) sheet append
    try {
      await ensureHeader();
      const row = [
        new Date().toISOString(),
        localStamp,
        email,
        jobSeconds,
        cumulativeSeconds,
        minutesForSheet,
        cumulativeMinutesForSheet,
        fileName,
        fileSizeMB,
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
        range: "Sheet1!A:P",
        valueInputOption: "RAW",
        requestBody: { values: [row] }
      });
      addStep(requestId, "Sheet updated.");
    } catch (e) {
      addStep(requestId, "⚠️ Sheet append failed: " + (e?.message || e));
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
      finished_at: new Date().toISOString()
    });

  } catch (err) {
    const eMsg = err?.message || "Processing error";
    addStep(requestId, "❌ " + eMsg);
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
      error: eMsg
    });
  }

  // cleanup
  try { fs.unlinkSync(inputPath); } catch {}
  try {
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

// ---------- routes ----------
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const email = (req.body.email || "").trim();
    const jobId = (req.body.job_id || "").toString();
    const token = (req.body.token  || "").toString();
    if (!email) return res.status(400).json({ error: "Email is required" });
    if (!req.file) return res.status(400).json({ error: "File is required" });

    const requestId = crypto.randomUUID();

    // initialize job with a smoothing plan seeded by file size
    const fileSizeMB = Math.max(0.01, Math.round(((req.file.size||0)/(1024*1024))*100)/100);
    const budgetMs = Math.max(30000, UI_BASE_MS + UI_PER_MB_MS * Math.min(fileSizeMB, 500));
    jobs.set(requestId, {
      status:"accepted",
      steps:[],
      error:null,
      metrics:{},
      ui: {
        startMs: Date.now(),
        budgetMs,
        lastPct: 0,
        capBeforeDone: UI_CAP_BEFORE_DONE,
        slowMsPerPercent: UI_SLOW_MS_PER_PERCENT,
        description: "Upload accepted…"
      }
    });

    addStep(requestId, "Upload accepted.");
    res.status(202).json({ success:true, accepted:true, requestId });

    setImmediate(()=>processJob({ email, inputPath: req.file.path, fileMeta: req.file, requestId, jobId, token })
      .catch(e=>{
        addStep(requestId, "❌ Background crash: " + (e?.message || e));
        setJob(requestId, { status:"done", error: e?.message || String(e) });
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
