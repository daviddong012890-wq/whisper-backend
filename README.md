# whisper-backend

A tiny backend for your Google Sites uploader:
- accepts audio/video upload + email
- extracts/cleans audio with ffmpeg
- compresses to MP3 (mono, 16 kHz) with adaptive bitrate so each API upload ≤ 25 MB
- transcribes with Whisper (OpenAI), translates to English, then to Traditional Chinese
- emails the results (Gmail SMTP)
- writes analytics to Google Sheets (service account)
- exposes `/status?id=...` so you can see progress
- safe logging (no secrets in logs)

## Endpoints
- `POST /upload` (multipart/form-data): fields `file` and `email`
- `GET /status?id=<requestId>`: returns job status & step log

## Env vars (Render → Environment)
- `OPENAI_API_KEY` – your OpenAI key
- `GMAIL_USER` – Gmail address to send from
- `GMAIL_PASS` – App Password (not your login password)
- `SHEET_ID` – Google Sheet ID (e.g. `1lbesW-...`)
- `GOOGLE_APPLICATION_CREDENTIALS` – path to service-account JSON on Render, e.g. `/etc/secrets/gcp-sa.json`

## Render notes
- Add your service-account JSON as a **Secret File** at `/etc/secrets/gcp-sa.json`
- Share your Sheet with the service account **as Editor**
- Deploy. Logs will show stage-by-stage with a `requestId`.

## Why ≤ 25 MB?
OpenAI’s Audio endpoints effectively cap per-file uploads around 25 MB.  
This backend:
1) denoises/normalizes audio,  
2) encodes MP3 at 64 → 48 → 32 → 24 kbps until the file ≤ 25 MB,  
3) **If somehow still > 25 MB**, we **slice into segments** and stitch the text.
