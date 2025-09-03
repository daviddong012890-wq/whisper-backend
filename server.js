import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import fs from "fs";
import FormData from "form-data";
import sgMail from "@sendgrid/mail";

const app = express();
const upload = multer({ dest: "uploads/" });
const PORT = process.env.PORT || 3000;

// ---------- utils ----------
async function openaiWhisper({ filePath, responseFormat = "srt" }) {
  const fd = new FormData();
  fd.append("file", fs.createReadStream(filePath));
  fd.append("model", "whisper-1");
  fd.append("response_format", responseFormat);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: fd
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Whisper error (${res.status}): ${err}`);
  }
  return await res.text();
}

async function translateToZhHant(plainText) {
  const body = {
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a precise translator. Translate user content into Traditional Chinese (繁體中文). Keep names and numbers accurate."
      },
      {
        role: "user",
        content: plainText
      }
    ],
    temperature: 0.2
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GPT error (${res.status}): ${err}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

// ---------- routes ----------

// (1) original endpoint you already used — returns SRT
app.post("/transcribe", upload.single("file"), async (req, res) => {
  try {
    const filePath = req.file.path;
    const srtText = await openaiWhisper({ filePath, responseFormat: "srt" });
    res.type("text/plain").send(srtText);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// (2) full workflow endpoint: file + email  ->  SRT + EN transcript + ZH-Hant translation + email out
app.post("/process", upload.single("file"), async (req, res) => {
  const email = req.body?.email;

  if (!email) {
    return res.status(400).json({ error: { message: "Missing email field" } });
  }
  if (!req.file) {
    return res.status(400).json({ error: { message: "Missing file field" } });
  }

  const filePath = req.file.path;

  try {
    // A) get SRT
    const srtText = await openaiWhisper({ filePath, responseFormat: "srt" });

    // B) get plain transcript (no timestamps)
    const plainTranscript = await openaiWhisper({
      filePath,
      responseFormat: "text"
    });

    // C) translate into Traditional Chinese
    const chinese = await translateToZhHant(plainTranscript);

    // D) email it using SendGrid
    if (!process.env.SENDGRID_API_KEY || !process.env.FROM_EMAIL) {
      throw new Error(
        "Missing SENDGRID_API_KEY or FROM_EMAIL environment variable"
      );
    }
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);

    const textBody =
      `Here are your results.\n\n` +
      `--- English (plain transcript) ---\n${plainTranscript}\n\n` +
      `--- Traditional Chinese (繁體中文) ---\n${chinese}\n\n` +
      `We also attached the .srt subtitle file.`;

    const msg = {
      to: email,
      from: process.env.FROM_EMAIL,
      subject: "Your transcript + Chinese translation",
      text: textBody,
      attachments: [
        {
          content: Buffer.from(srtText, "utf8").toString("base64"),
          filename: "subtitles.srt",
          type: "text/plain",
          disposition: "attachment"
        }
      ]
    };

    await sgMail.send(msg);

    // Respond with a short preview
    res.json({
      ok: true,
      emailSentTo: email,
      preview: {
        english: plainTranscript.slice(0, 500),
        chinese: chinese.slice(0, 500)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: err.message } });
  } finally {
    // cleanup upload
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
