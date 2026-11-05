# ClipForge — AI Clipper

ClipForge is a locally installed Next.js app for turning videos into short clips. Clone/download the repository, install dependencies, and run it on your own computer. It does **not** require a ClipForge-hosted backend.

## Quick start (Windows)

1. Install **Node.js 20 LTS or newer** from https://nodejs.org/
2. Download/clone this repository.
3. Open the project folder and double-click `install.bat` (or run `npm install`).
4. Double-click `run.bat` (or run `npm run dev`).
5. Open http://localhost:3000 in Chrome or Edge.

The first run downloads FFmpeg WebAssembly and the Whisper model. These are cached by the browser for later runs. The user can click **Download FFmpeg + Whisper** in the app to preload them.

## Run manually (Windows, macOS, Linux)

```bash
npm install
npm run dev
```

Then visit http://localhost:3000. For a production build:

```bash
npm run build
npm run start
```

## Native FFmpeg export (GPU encoding when supported)

ClipForge also offers a **Native FFmpeg · GPU/CPU** export button. This invokes FFmpeg through the locally running Next.js Node server, so video processing remains on the user's machine.

### Windows setup

1. Install FFmpeg from a Windows build that includes NVIDIA NVENC support (for example, a current Gyan FFmpeg build): https://www.gyan.dev/ffmpeg/builds/
2. Add the FFmpeg `bin` folder to your Windows PATH, or set `FFMPEG_PATH` to the full path of `ffmpeg.exe`.
3. Open a new terminal and check:
   ```powershell
   ffmpeg -hide_banner -encoders | findstr nvenc
   ```
   Look for `h264_nvenc`.
4. Start ClipForge using `npm run dev` or `run.bat`, then choose **Native FFmpeg · GPU/CPU** on a clip.

The native exporter attempts H.264 NVENC when the local FFmpeg build exposes it and the GPU/driver initialization works. If the encode fails, it retries with CPU `libx264`. You can check the app status after export to see which encoder was used.

**Requirements:** NVIDIA GPU with NVENC support, compatible NVIDIA drivers, and FFmpeg compiled with NVENC. Having an NVIDIA GPU alone does not enable NVENC in a FFmpeg build. FFmpeg documents NVENC build and runtime requirements here: https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/ffmpeg-with-nvidia-gpu/

Native encoding requires the local Node server. It is not available when the static frontend is hosted on a remote server. The endpoint writes temporary video files under the OS temp directory and removes them after processing.

## Local CPU/GPU usage

- **Whisper transcription:** Runs locally using Transformers.js. ClipForge tries WebGPU (GPU) first, then automatically falls back to WASM (CPU) if WebGPU is unavailable or fails to initialize.
- **Video conversion, clipping, cropping and subtitle burn-in:** Browser FFmpeg.wasm export is CPU-based. Choose **Native FFmpeg · GPU/CPU** to use the local machine's supported native hardware encoder (NVIDIA/AMD/Intel/Apple) or automatic CPU fallback.
- **MediaPipe face detection:** Runs locally in the browser and can use browser-supported acceleration.
- **AI highlight analysis:** Currently sends the video to Google Gemini using the user's own API key. This part is cloud inference, not local CPU/GPU. You can skip Gemini only if you manually add/select clip timestamps (manual timestamp UI is on the roadmap).

For WebGPU inference, use an up-to-date Chrome or Edge with hardware acceleration enabled and current GPU drivers. WebGPU availability depends on browser, OS, GPU and driver. Check Chrome's `chrome://gpu` page. If WebGPU is unavailable, Whisper uses CPU/WASM.

## Hardware and storage

- Processing speed depends on CPU, GPU, RAM, video resolution and browser limits.
- Model weights are downloaded from Hugging Face on first use and cached by the browser; the browser cache may be cleared by the user or browser.
- Large videos may run out of browser memory. Try shorter videos or lower-resolution inputs.
- This version does not install models into a permanent Windows folder; model caching is managed by the browser.

## Current MVP

- Upload video and preview
- Gemini video understanding (BYOK)
- Suggested highlight clips with titles, scores and reasons
- Local FFmpeg.wasm clip export
- Local Whisper transcription and captions
- SRT sidecar and karaoke-style ASS captions
- Smart vertical crop with MediaPipe face detection

## Important limitations and privacy

- Gemini video analysis sends the selected video directly to Google's API. Review Google's data retention/pricing policies. ClipForge does not proxy the upload through its own server.
- API keys are kept in React component state for the current session and are not persisted. They are still exposed to the browser runtime; use your own restricted/test key.
- WebGPU is not supported on every device/browser and can fail for some model/runtime combinations. ClipForge attempts CPU/WASM fallback.
- FFmpeg.wasm is slower and more memory-intensive than native FFmpeg, particularly for large files.
- YouTube/Instagram/TikTok URL downloading is not implemented. Use local files you have permission to process.
- OpenAI/OpenRouter options are UI placeholders; Gemini analysis is currently implemented.

## License

Check the licenses of FFmpeg, Transformers.js, model weights, and any other bundled or downloaded dependencies before redistributing builds.
