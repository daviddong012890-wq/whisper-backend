import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
const upload = multer({ dest: "uploads/" });
const PORT = process.env.PORT || 3000;

app.post("/transcribe", upload.single("file"), async (req, res) => {
  try {
    const fileStream = fs.createReadStream(req.file.path);

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: (() => {
        const formData = new FormData();
        formData.append("file", fileStream);
        formData.append("model", "whisper-1");
        formData.append("response_format", "srt"); // subtitle format
        return formData;
      })(),
    });

    const srtText = await response.text();
    res.type("text/plain").send(srtText);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error during transcription");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
