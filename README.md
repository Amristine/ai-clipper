# ClipForge — AI Clipper

Browser-first AI Shorts generator. This starter project lets a user upload a video, send it directly to Gemini for highlight timestamp analysis, then render selected clips in the browser with FFmpeg.wasm.

## Stack
- Next.js 15 + React + TypeScript
- Tailwind-free custom CSS UI (dark creator studio)
- Gemini Files API + Gemini video understanding (BYOK)
- FFmpeg.wasm for local browser rendering

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Current MVP
- Upload video file and preview it
- Configure target clip duration and clip count
- Gemini BYOK video analysis from the browser
- AI-generated clip title, timestamp, score and reason
- Local FFmpeg.wasm clip export
- Responsive dashboard UI

## Important limitations
- Video analysis sends the selected video directly to Google Gemini. It does not go through an app-owned backend. Check the provider's data retention and pricing policies before use.
- Rendering is browser-local, but FFmpeg.wasm is slower and more memory-intensive than native FFmpeg. Large videos may fail on some devices.
- YouTube/Instagram/TikTok URL downloading is not implemented. A URL cannot reliably be turned into a local video file in-browser due to CORS, authentication and platform restrictions. Use a video file you have rights to upload.
- Local Whisper transcription is integrated for timestamped subtitle segments; users can export SRT sidecar files. Captions are not yet burned into the MP4 video itself.\n- Smart vertical crop uses MediaPipe face detection on one sampled frame per clip. It centers the crop around the first detected face; full clip-long face tracking is not yet implemented.
- OpenAI/OpenRouter options are UI placeholders; Gemini video analysis is currently implemented.
- Crop currently uses center crop; intelligent face tracking is planned.
- This is an early starter, not yet a production-ready editor. Test with short clips first.

## Privacy & API keys
The API key is held in React component state for the current session and is not persisted by this app. It is still exposed to the browser runtime and should only be used with a restricted/test key where possible. Never embed your own secret API key in this application.

## Roadmap
1. Word-level transcription and caption presets
2. User-editable clip start/end points
3. Smart subject/face crop
4. Direct video URL ingestion where authorized and technically supported
5. OpenAI-compatible transcript analysis provider adapter
6. ZIP export and batch queue
7. IndexedDB project persistence
