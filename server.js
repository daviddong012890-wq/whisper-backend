import express from "express";
import fetch from "node-fetch";
import FormData from "form-data";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import { Readable } from "stream";

const app = express();
app.use(express.json({ limit: "2mb" }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // set in Render Dashboard
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

ffmpeg.setFfmpegPath(ffmpegStatic);

function bufferToStream(buf) {
  const stream = new Readable();
  stream.push(buf);
  stream.push(null);
  return stream;
}

async function downloadToBuffer(fileUrl) {
  const res = await fetch(fileUrl);
  if (!res.ok) {
    throw new Error(`Download failed ${res.status}: ${await res.text()}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

async function toMp3Buffer(inputBuffer) {
  return new Promise((resolve, reject) => {
    const inputStream = bufferToStream(inputBuffer);
    const chunks = [];
    ffmpeg(inputStream)
      .outputFormat("mp3")
      .audioCodec("libmp3lame")
      .on("error", reject)
      .on("end", () => resolve(Buffer.concat(chunks)))
      .pipe()
      .on("data", (c) => chunks.push(c));
  });
}

async function whisperTranscribe(mp3Buffer, responseFormat = "srt") {
  const fd = new FormData();
  fd.append("file", mp3Buffer, { filename: "audio.mp3", contentType: "audio/mpeg" });
  fd.append("model", "whisper-1");
  fd.append("response_format", responseFormat);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      ...fd.getHeaders()
    },
    body: fd
  });

  if (!res.ok) {
    throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  }
  return await res.text(); // srt or plain text
}

// POST /transcribe_by_url  { url, response_format: "srt"|"text" }
app.post("/transcribe_by_url", async (req, res) => {
  try {
    const { url, response_format = "srt" } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing url" });

    const raw = await downloadToBuffer(url);     // video or audio
    const mp3 = await toMp3Buffer(raw);          // shrink to MP3
    const out = await whisperTranscribe(mp3, response_format);
    res.type("text/plain").send(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

app.get("/", (_, res) => res.send("OK"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));
