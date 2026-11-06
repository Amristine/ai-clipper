import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setNativeExportProgress } from "./progress-store";
import { buildClipFilterGraph, parseSilenceLog, remapAssToCutTimeline, type ClipRange } from "@/lib/clip-processing";

export const runtime = "nodejs";
export const maxDuration = 300;

function ffmpegPath() {
  return process.env.FFMPEG_PATH || (process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
}
function run(binary: string, args: string[], onProgress?: (outTimeMs:number)=>void) {
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let output = "";
    let progressLine = "";
    child.stdout.on("data", chunk => {
      const data = chunk.toString();
      output += data;
      if (output.length > 16000) output = output.slice(-16000);
      if (onProgress) {
        progressLine += data;
        const lines = progressLine.split(/\r?\n/);
        progressLine = lines.pop() || "";
        for (const line of lines) {
          const match = line.match(/^out_time_ms=(\d+)/);
          if (match) onProgress(Number(match[1]));
        }
      }
    });
    child.stderr.on("data", chunk => {
      output += chunk.toString();
      if (output.length > 16000) output = output.slice(-16000);
    });
    child.on("error", reject);
    child.on("close", code => resolve({ code: code ?? -1, output }));
  });
}
type Encoder = { name: string; label: string; args: string[] };
function hardwareEncoders(platform: NodeJS.Platform): Encoder[] {
  // Try broadly compatible H.264 hardware encoders first. FFmpeg may list an
  // encoder even when the driver/device cannot initialize, so every attempt
  // is validated by actually encoding and errors fall through to the next.
  const encoders: Encoder[] = [
    { name: "h264_nvenc", label: "NVIDIA NVENC", args: ["-preset", "p6", "-cq", "16"] },
    { name: "h264_amf", label: "AMD AMF", args: ["-quality", "quality", "-rc", "cqp", "-qp_i", "16", "-qp_p", "16"] },
    { name: "h264_qsv", label: "Intel Quick Sync", args: ["-preset", "medium", "-global_quality", "16"] },
  ];
  if (platform === "darwin") {
    encoders.push({ name: "h264_videotoolbox", label: "Apple VideoToolbox", args: ["-b:v", "12M"] });
  }
  return encoders;
}

export async function POST(req: NextRequest) {
  const workDir = await mkdtemp(path.join(tmpdir(), "clipforge-native-"));
  try {
    const form = await req.formData();
    const video = form.get("video");
    if (!(video instanceof File)) return NextResponse.json({ error: "Missing video file" }, { status: 400 });
    const jobId = String(form.get("jobId") || "");
    const start = Number(form.get("start"));
    const end = Number(form.get("end"));
    const ratio = String(form.get("ratio") || "9:16");
    const removeSilence = String(form.get("removeSilence") ?? "true") !== "false";
    const cropX = Math.max(0, Math.min(1, Number(form.get("cropX") || 0.5)));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start)
      return NextResponse.json({ error: "Invalid clip timestamps" }, { status: 400 });

    const inputPath = path.join(workDir, "source-video");
    const outputPath = path.join(workDir, "clipforge-output.mp4");
    setNativeExportProgress(jobId,{progress:2,phase:"Saving input video locally"});
    await writeFile(inputPath, Buffer.from(await video.arrayBuffer()));

    const filter = ratio === "9:16"
      ? "crop=ih*9/16:ih:min(max(iw*" + cropX.toFixed(3) + "-ih*9/32\\,0)\\,iw-ih*9/16):0,scale=1080:1920"
      : ratio === "1:1" ? "crop=min(iw\\,ih):min(iw\\,ih),scale=1080:1080" : "scale=1920:-2";

    const binary = ffmpegPath();
    const clipDuration = end - start;
    let keepRanges: ClipRange[] = [{ start: 0, end: clipDuration }];
    if (removeSilence) {
      setNativeExportProgress(jobId,{progress:3,phase:"Detecting long pauses in speech"});
      const detection = await run(binary, ["-hide_banner", "-ss", String(start), "-i", inputPath, "-t", String(clipDuration), "-vn", "-af", "silencedetect=noise=-35dB:d=0.45", "-f", "null", "-"]);
      if (detection.code === 0) keepRanges = parseSilenceLog(detection.output, clipDuration);
    }

    const ass = form.get("ass");
    let subtitlePath: string | undefined;
    if (typeof ass === "string" && ass.trim()) {
      subtitlePath = path.join(workDir, "captions.ass");
      await writeFile(subtitlePath, remapAssToCutTimeline(ass, keepRanges), "utf8");
    }
    const filterGraph = buildClipFilterGraph(keepRanges, filter, 0, subtitlePath);    
    const outputDuration = keepRanges.reduce((sum, range) => sum + range.end - range.start, 0);
    const encoderList = await run(binary, ["-hide_banner", "-encoders"]);
    if (encoderList.code !== 0) {
      return NextResponse.json({ error: "FFmpeg could not start. Install FFmpeg and add it to PATH or set FFMPEG_PATH.", details: encoderList.output.slice(-3000) }, { status: 500 });
    }
    const available = new Set<string>();
    for (const name of ["h264_nvenc", "h264_amf", "h264_qsv", "h264_videotoolbox"]) {
      if (new RegExp("\\b" + name + "\\b").test(encoderList.output)) available.add(name);
    }

    const inputArgs = ["-hide_banner", "-y", "-ss", String(start), "-i", inputPath, "-filter_complex", filterGraph];
    const outputArgs = ["-map", "[vout]", "-map", "[acat]", "-c:a", "aac", "-movflags", "+faststart", outputPath];
    const attempts = hardwareEncoders(process.platform).filter(e => available.has(e.name));
    const progressDuration=Math.max(0.01,outputDuration);
    let chosen = "libx264";
    let label = "CPU · libx264";
    let result: { code: number; output: string } = { code: -1, output: "" };

    for (const encoder of attempts) {
      setNativeExportProgress(jobId,{progress:3,phase:"Trying "+encoder.label+" hardware encoder",encoder:encoder.label});
      result = await run(binary, [...inputArgs, "-c:v", encoder.name, ...encoder.args, "-progress", "pipe:1", "-nostats", ...outputArgs], outTimeMs => setNativeExportProgress(jobId,{progress:Math.min(96,Math.max(3,Math.round((outTimeMs/1000000/progressDuration)*90)+3)),phase:"Encoding with "+encoder.label,encoder:encoder.label}));
      if (result.code === 0) {
        chosen = encoder.name;
        label = encoder.label;
        break;
      }
    }

    if (chosen === "libx264") {
      setNativeExportProgress(jobId,{progress:3,phase:"Hardware encoder unavailable/failed · CPU fallback",encoder:"CPU · libx264"});
      result = await run(binary, [...inputArgs, "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-progress", "pipe:1", "-nostats", ...outputArgs], outTimeMs => setNativeExportProgress(jobId,{progress:Math.min(96,Math.max(3,Math.round((outTimeMs/1000000/progressDuration)*90)+3)),phase:"Encoding with CPU · libx264",encoder:"CPU · libx264"}));
    }
    if (result.code !== 0) {
      return NextResponse.json({
        error: "Native FFmpeg export failed. Verify your FFmpeg install and GPU drivers.",
        details: result.output.slice(-4000)
      }, { status: 500 });
    }

    setNativeExportProgress(jobId,{progress:98,phase:"Preparing download",encoder:label});
    const bytes = await readFile(outputPath);
    setNativeExportProgress(jobId,{progress:100,phase:"Export complete",encoder:label});
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": 'attachment; filename="clipforge-native.mp4"',
        "X-ClipForge-Encoder": chosen,
        "X-ClipForge-Hardware": label
      }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
