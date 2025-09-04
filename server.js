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
const LOCAL_TZ       = process.env.LOCAL_TZ || "America/Los_Angeles"; // set in Render

function fatal(m){ console.error("❌ " + m); process.exit(1); }
if (!OPENAI_API_KEY) fatal("Missing OPENAI_API_KEY");
if (!GMAIL_USER || !GMAIL_PASS) fatal("Missing GMAIL_USER or GMAIL_PASS");
if (!SHEET_ID) fatal("Missing SHEET_ID");
if (!GOOGLE_KEYFILE) fatal("Missing GOOGLE_APPLICATION_CREDENTIALS");
if (!fs.existsSync(GOOGLE_KEYFILE)) fatal(`Key not found at ${GOOGLE_KEYFILE}`);
try { JSON.parse(fs.readFileSync(GOOGLE_KEYFILE,"utf8")); } catch(e){ fatal("Bad service-account JSON: " + e.message); }

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
const jobs = new Map();
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

// ===== TIME / FORMAT HELPERS =====
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
function fmtZhSec(sec){
  const s = Math.max(0, Math.round(sec||0));
  const m = Math.floor(s/60);
  const r = s % 60;
  return `${m} 分 ${r} 秒`;
}
function secsToSheetMinutes(sec){
  return Math.max(1, Math.ceil((sec||0)/60));
}

// ===== SHEET HEADER (16 columns) =====
const HEADER = [
  "TimestampUTC","TimestampLocal","Email",
  "Seconds","CumulativeSeconds",
  "Minutes","CumulativeMinutes",
  "FileName","FileSizeMB","Language","RequestId",
  "ProcessingMs","Succeeded","ErrorMessage","Model","FileType"
];

// Write/repair header exactly once
async function ensureHeader(){
  try {
    const got = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A1:P1",              // 16 columns (A..P)
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

// ===== Header-aware column helpers (handles legacy/new schemas) =====
function normEmail(x){ return String(x || "").trim().toLowerCase(); }
function truthy(x){
  const s = String(x ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}
async function getColumnMap(){
  const hdr = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Sheet1!A1:Z1",
  });
  const row = hdr.data.values?.[0] || [];
  const map = {};
  row.forEach((name, idx) => { map[String(name || "").trim()] = idx; });
  return {
    idxEmail:           map["Email"],
    idxSeconds:         map["Seconds"],
    idxMinutes:         map["Minutes"],
    idxSucceeded:       map["Succeeded"],
    legacySucceededIdx: (map["Succeeded"] ?? 9),
  };
}

// Sum prior *successful* rows for this email.
// Prefer Seconds; fall back to Minutes*60 if Seconds missing.
async function getPastSecondsForEmail(email){
  try {
    const cm = await getColumnMap();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A2:Z",
      valueRenderOption: "UNFORMATTED_VALUE",
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
      if (!Number.isNaN(sec) && sec > 0){
        totalSeconds += sec;
        continue;
      }
      const min = Number(r[cm.idxMinutes]);
      if (!Number.isNaN(min) && min > 0){
        totalSeconds += (min * 60);
      }
    }
    return totalSeconds;
  } catch (e) {
    console.error("⚠️ getPastSecondsForEmail:", e.message || e);
    return 0;
  }
}

// ===== AUDIO PIPELINE =====
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

async function extractToWav(inPath, outPath){
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
      .outputOptions(["-vn","-ac","1","-ar","16000","-b:a",`${kbps}k`,"-codec:a","libmp3lame"])
      .save(outMp3).on("end", resolve).on("error", reject);
  });
  return outMp3;
}
async function prepareMp3UnderLimit(inMediaPath, requestId){
  const tmpWav = inMediaPath + ".clean.wav";
  addStep(requestId, "Extracting audio → WAV …");
  await extractToWav(inMediaPath, tmpWav);

  const ladder = [64,48,32,24];
  for (const kb of ladder){
    const out = inMediaPath + `.${kb}k.mp3`;
    addStep(requestId, `Encode MP3 ${kb} kbps …`);
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

// ===== OpenAI =====
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
async function zhTwFromOriginalFaithful(originalText, requestId){
  try {
    addStep(requestId, "Calling GPT 原文→繁中 (faithful) …");
    const systemPrompt =
`你是國際會議的專業口筆譯員。請把使用者提供的「原文」完整翻譯成「繁體中文（台灣慣用）」並嚴格遵守：
1) 忠實轉譯：不可增刪、不可臆測，不加入任何評論；僅做必要語法與詞序調整以使中文通順。
2) 句序與段落：依原文順序與段落輸出；保留所有重複、口號與語氣詞。
3) 中英夾雜：凡是非中文的片段（英語、法語、西班牙語、德語、日語、韓語等任何語種的詞句、人名地名、術語）一律翻成中文。不得保留原語言（含英文）單字。
4) 標點使用中文全形標點。只輸出中文譯文，不要任何說明。
5) 適用範圍：以上規則（1–4）不論原文語言為何（只要 Whisper 能辨識的語言）皆一體適用；專有名詞採常見中譯或音譯，若無通行譯名則以自然音譯呈現，亦不得夾帶原文括註。`;
    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model:"gpt-4o-mini", temperature:0, messages:[
        { role:"system", content: systemPrompt },
        { role:"user", content: originalText || "" }
      ]},
      { headers:{ Authorization:`Bearer ${OPENAI_API_KEY}` } }
    );
    addStep(requestId, "繁中 done.");
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
  let language = "";
  const fileType = fileMeta.mimetype || "";
  const fileName = fileMeta.originalname || "upload";
  const fileSizeMB = Math.max(0.01, Math.round(((fileMeta.size||0)/(1024*1024))*100)/100);

  // 1) Prepare / split
  let prepared, parts=[];
  try {
    prepared = await prepareMp3UnderLimit(inputPath, requestId);
    parts = await splitIfNeeded(prepared.path, requestId);
  } catch (e) {
    addStep(requestId, "❌ Transcode failed: " + (e?.message || e));
  }

  try {
    // Exact seconds (this job)
    const filesForDuration = (parts && parts.length) ? parts : [prepared?.path || inputPath];
    const jobSeconds = await sumSeconds(filesForDuration);
    const minutesForSheet = secsToSheetMinutes(jobSeconds);

    // Cumulative *seconds* from history → derive cumulative minutes for sheet
    const pastSeconds = await getPastSecondsForEmail(email);
    const cumulativeSeconds = pastSeconds + jobSeconds;
    const cumulativeMinutesForSheet = secsToSheetMinutes(cumulativeSeconds);

    addStep(requestId, `Duration this job: ${fmtZhSec(jobSeconds)}; cumulative: ${fmtZhSec(cumulativeSeconds)}.`);

    // Transcribe & translate
    let originalAll = "";
    const filesForTranscription = (parts && parts.length) ? parts : [prepared?.path || inputPath];
    for (let i=0;i<filesForTranscription.length;i++){
      if (filesForTranscription.length>1) addStep(requestId, `Part ${i+1}/${filesForTranscription.length} …`);
      const verbose = await openaiTranscribeVerbose(filesForTranscription[i], requestId);
      if (!language) language = verbose.language || "";
      originalAll += (originalAll ? "\n\n" : "") + (verbose.text || "");
    }
    const zhTraditional = await zhTwFromOriginalFaithful(originalAll, requestId);

    // Cost estimate ($5 / 100 min = $0.05 / min)
    const costThis = (jobSeconds/60 * 0.05);
    const localStamp = fmtLocalStamp(new Date());

    // Build .txt attachment content (UTF-8)
    const attachmentText =
`＝＝ 中文（繁體） ＝＝
${zhTraditional}

＝＝ 原文 ＝＝
${originalAll}
`;
    const safeBase = (fileName || "transcript").replace(/[^\w.-]+/g, "_").slice(0, 50) || "transcript";
    const attachmentName = `${safeBase}-${requestId}.txt`;

    // Email (Chinese only + original) with timestamp + message + cost + attachment note
    const mailBody =
`轉寫已完成
${localStamp}

本次上傳時長：${fmtZhSec(jobSeconds)}

您的逐字稿旅程
已累積時長：${fmtZhSec(cumulativeSeconds)}

＝＝ 中文（繁體） ＝＝
${zhTraditional}

＝＝ 原文 ＝＝
${originalAll}

＝＝ 頁尾 ＝＝
感謝您使用我們的逐字稿產生器。請注意，本服務為機器自動化翻譯，其內容僅供參考，我們不保證其百分之百的正確性、完整性或即時性。逐字稿可能包含錯誤、遺漏或雜訊。您的視頻音訊均受到嚴格保護，在處理完畢後，您的原始檔案會立即被刪除，以確保您的隱私。

本服務的正式使用費用為每 100 分鐘 $5 美元，但目前特別為美國慈濟的用戶提供免費使用。若您在使用上有任何問題，歡迎隨時聯絡 David Lee 電話/簡訊：626-436-4199

如果您認為我們的系統對您有所幫助並願意支持我們，您的贊助將協助我們持續優化服務。您可透過 Zelle 轉帳至 626-436-4199，收款方為 Dottlight, Inc.

此外，若您還有其他视频音訊檔案需要轉換，歡迎隨時再次使用我們的產生器。官網 www.dottlight.com.

本次使用費用 (已為您減免)：$${costThis.toFixed(2)}

附件為本次逐字稿的 .txt 文件，方便您下載或複製到其他軟體使用。

（服務單號：${requestId}）
（編碼參數：${prepared?.kbps || "?"} kbps，${(prepared?.bytes||0/1024/1024).toFixed(2)} MB${parts && parts.length>1?`，共 ${parts.length} 個分段`:''}）`;

    addStep(requestId, "Sending email …");
    await mailer.sendMail({
      from: `"逐字稿產生器" <${GMAIL_USER}>`,
      to: email,
      subject: "您的逐字稿（原文與繁體中文）",
      text: mailBody,
      attachments: [
        {
          filename: attachmentName,
          content: attachmentText,          // UTF-8 text
          contentType: "text/plain; charset=utf-8"
        }
      ]
    });
    addStep(requestId, "Email sent.");

    // Sheet row (seconds + local timestamp) — NOTE: range A:P (16 cols)
    try {
      await ensureHeader();
      const row = [
        new Date().toISOString(),            // TimestampUTC
        localStamp,                          // TimestampLocal
        email,
        jobSeconds,                          // Seconds
        cumulativeSeconds,                   // CumulativeSeconds
        minutesForSheet,                     // Minutes (rounded-up, billing)
        cumulativeMinutesForSheet,           // CumulativeMinutes (rounded-up)
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
        requestBody: { values: [row] },
      });
      addStep(requestId, "Sheet updated.");
    } catch (e) {
      addStep(requestId, "⚠️ Sheet append failed: " + (e?.message || e));
    }

  } catch (err) {
    const eMsg = err?.message || "Processing error";
    addStep(requestId, "❌ " + eMsg);
    // failure row
    try {
      await ensureHeader();
      const localStamp = fmtLocalStamp(new Date());
      const pastSeconds = await getPastSecondsForEmail(email);
      const row = [
        new Date().toISOString(),
        localStamp,
        email,
        0,
        pastSeconds,
        0,
        secsToSheetMinutes(pastSeconds),
        fileName,
        fileSizeMB || 0,
        "",
        requestId,
        Date.now() - started,
        false,
        eMsg,
        "whisper-1",
        fileType
      ];
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: "Sheet1!A:P",
        valueInputOption: "RAW",
        requestBody: { values: [row] },
      });
    } catch {}
  }

  // Cleanup
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
