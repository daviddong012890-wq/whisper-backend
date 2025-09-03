# Whisper Backend

A simple Express server that accepts audio/video file uploads and uses OpenAI’s Whisper model (`whisper-1`) to return a transcription in `.srt` format.

## Endpoints

- `POST /transcribe`
  - Upload a file (field name: `file`)
  - Returns: Subtitles in `.srt` format

## Deployment

This app is designed to run on [Render](https://render.com/) with the following environment variable:

- `OPENAI_API_KEY` → your OpenAI API key
