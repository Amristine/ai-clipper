import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const runtime = "nodejs";
export const maxDuration = 300;

function ffmpegPath() {
  return process.env.FFMPEG_PATH || (process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
}
function run(binary: string, args: string[]) {
  return new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); if (stderr.length > 12000) stderr = stderr.slice(-12000); });
    child.on("error", reject);
    child.on("close", code => resolve({ code: code ?? -1, stderr }));
  });
}
function escapeFilterPath(p: string) {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export async function POST(req: NextRequest) {
  const workDir = await mkdtemp(path.join(tmpdir(), "clipforge-native-"));
  try {
    const form = await req.formData();
    const video = form.get("video");
    if (!(video instanceof File)) return NextResponse.json({ error: "Missing video file" }, { status: 400 });
    const start = Number(form.get("start"));
    const end = Number(form.get("end"));
    const ratio = String(form.get("ratio") || "9:16");
    const cropX = Math.max(0, Math.min(1, Number(form.get("cropX") || 0.5)));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start)
      return NextResponse.json({ error: "Invalid clip timestamps" }, { status: 400 });

    const inputPath = path.join(workDir, "source-video");
    const outputPath = path.join(workDir, "clipforge-output.mp4");
    await writeFile(inputPath, Buffer.from(await video.arrayBuffer()));

    let filter = ratio === "9:16"
      ? "crop=ih*9/16:ih:min(max(iw*" + cropX.toFixed(3) + "-ih*9/32\\,0)\\,iw-ih*9/16):0,scale=1080:1920"
      : ratio === "1:1" ? "crop=min(iw\\,ih):min(iw\\,ih),scale=1080:1080" : "scale=1920:-2";

    const ass = form.get("ass");
    if (typeof ass === "string" && ass.trim()) {
      const assPath = path.join(workDir, "captions.ass");
      await writeFile(assPath, ass, "utf8");
      filter += ",subtitles='" + escapeFilterPath(assPath) + "'";
    }

    const binary = ffmpegPath();
    const encoders = await run(binary, ["-hide_banner", "-encoders"]);
    const nvencAvailable = encoders.code === 0 && /h264_nvenc/.test(encoders.stderr);
    const base = ["-hide_banner", "-y", "-ss", String(start), "-i", inputPath, "-t", String(end - start), "-vf", filter];
    const tail = ["-c:a", "aac", "-movflags", "+faststart", outputPath];
    let encoder = "libx264";
    let result = { code: -1, stderr: "" };

    if (nvencAvailable) {
      encoder = "h264_nvenc";
      result = await run(binary, [...base, "-c:v", encoder, "-preset", "p4", "-cq", "23", ...tail]);
    }
    if (!nvencAvailable || result.code !== 0) {
      encoder = "libx264";
      result = await run(binary, [...base, "-c:v", encoder, "-preset", "veryfast", "-crf", "23", ...tail]);
    }
    if (result.code !== 0) {
      return NextResponse.json({
        error: "Native FFmpeg export failed. Install FFmpeg and ensure it is in PATH or set FFMPEG_PATH.",
        details: result.stderr.slice(-4000)
      }, { status: 500 });
    }

    const bytes = await readFile(outputPath);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": 'attachment; filename="clipforge-native.mp4"',
        "X-ClipForge-Encoder": encoder
      }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
