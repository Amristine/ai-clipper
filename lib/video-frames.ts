export type SampledVideoFrame = { timestamp: number; dataUrl: string };

/** Sample evenly spaced frames in the browser without uploading the source video to ClipForge. */
export async function extractVideoFrames(
  file: File,
  requestedCount = 6,
  maxWidth = 512,
  onProgress?: (message: string) => void
): Promise<SampledVideoFrame[]> {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.src = objectUrl;

  const waitFor = (eventName: "loadedmetadata" | "seeked", timeoutMs = 15000) =>
    new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error("Timed out while reading video frames."));
      }, timeoutMs);
      const cleanup = () => {
        window.clearTimeout(timer);
        video.removeEventListener(eventName, done);
        video.removeEventListener("error", failed);
      };
      const done = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error("The video could not be decoded for frame sampling.")); };
      video.addEventListener(eventName, done, { once: true });
      video.addEventListener("error", failed, { once: true });
    });

  try {
    await waitFor("loadedmetadata");
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!duration || !video.videoWidth || !video.videoHeight) throw new Error("The uploaded video has no readable duration or dimensions.");

    const count = Math.max(1, Math.min(8, requestedCount));
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = Math.max(2, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(2, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Could not create a canvas for video frame sampling.");

    const frames: SampledVideoFrame[] = [];
    for (let index = 0; index < count; index++) {
      const timestamp = duration * ((index + 0.5) / count);
      onProgress?.("Sampling visual context · frame " + (index + 1) + "/" + count);
      const seeked = waitFor("seeked");
      video.currentTime = Math.min(Math.max(0, duration - 0.05), timestamp);
      await seeked;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({ timestamp, dataUrl: canvas.toDataURL("image/jpeg", 0.58) });
    }
    return frames;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}
