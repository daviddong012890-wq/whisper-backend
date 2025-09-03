import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import fs from "fs";
import FormData from "form-data";

const app = express();

// store uploads in a temp folder on Render
const upload = multer({ dest: "uploads/" });

const PORT = process.env.PORT || 3000;

// simple health check
app.get("/", (req, res) => {
  res.send("Whisper backend is running");
});

app.post("/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded. Field name must be 'file'." });
    }

    // build a multipart/form-data request to OpenAI
    const form = new FormData();
    const fileStream = fs.createReadStream(req.file.path);
    form.append("file", fileStream, {
      filename: req.file.originalname || "audio.mp4",
      contentType: req.file.mimetype || "application/octet-stream",
    });
    form.append("model", "whisper-1");
    form.append("response_format", "srt"); // ask OpenAI to return subtitles

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        // VERY important: include form-data headers AND your API key
        ...form.getHeaders(),
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: form,
    });

    // If OpenAI returns an error, pass it through so you can see it
    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).type("text/plain").send(errText);
    }

    // Whisper returns SRT text directly
    const srtText = await response.text();
    res.type("text/plain").send(srtText);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error during transcription." });
  } finally {
    // clean up the temporary upload
    if (req.file?.path) {
      fs.unlink(req.file.path, () => {});
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
