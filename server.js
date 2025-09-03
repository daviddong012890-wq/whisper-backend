import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import FormData from "form-data";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
app.use(cors());

const upload = multer({ dest: "uploads/" });
const PORT = process.env.PORT || 10000;

// Health check
app.get("/", (req, res) => {
  res.send("Whisper backend is running.");
});

app.post("/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: 'No file uploaded. Form field name must be "file".' });
    }

    // Build multipart form for OpenAI Whisper
    const form = new FormData();
    form.append("file", fs.createReadStream(req.file.path), {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });
    form.append("model", "whisper-1");          // transcription model
    form.append("response_format", "srt");      // ask for SRT subtitles

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        // DO NOT set Content-Type—form-data sets it with boundary for you
      },
      body: form,
    });

    if (!r.ok) {
      const errText = await r.text();
      res.status(r.status).type("text/plain").send(errText);
      return;
    }

    const srtText = await r.text();
    res.type("text/plain").send(srtText);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error during transcription." });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
