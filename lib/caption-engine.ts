import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import type { Pipeline } from "@huggingface/transformers";

export type CaptionSegment = { start:number; end:number; text:string };
let whisper: Pipeline | null = null;

export async function transcribeVideoLocally(file:File, ffmpeg:FFmpeg, onStatus:(s:string)=>void):Promise<CaptionSegment[]> {
  const input = "caption-input." + (file.name.split(".").pop() || "mp4").replace(/[^a-z0-9]/gi,"");
  await ffmpeg.writeFile(input, await fetchFile(file));
  await ffmpeg.exec(["-i",input,"-vn","-ac","1","-ar","16000","-c:a","pcm_s16le","caption-audio.wav"]);
  const audio = await ffmpeg.readFile("caption-audio.wav");
  onStatus("Loading Whisper model (first run downloads it)…");
  if (!whisper) {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    whisper = await pipeline("automatic-speech-recognition","Xenova/whisper-base",{device:"wasm"}) as Pipeline;
  }
  onStatus("Transcribing audio locally in your browser…");
  const audioUrl = URL.createObjectURL(new Blob([audio],{type:"audio/wav"}));
  try {
    const result:any = await (whisper as any)(audioUrl,{chunk_length_s:30,stride_length_s:5,return_timestamps:true});
    const segments:CaptionSegment[]=(result.chunks||[]).map((chunk:any)=>({
      start:Number(chunk.timestamp?.[0]??0), end:Number(chunk.timestamp?.[1]??0), text:String(chunk.text||"").trim()
    })).filter((s:CaptionSegment)=>s.text&&s.end>s.start);
    if (!segments.length && result.text) return [{start:0,end:Math.max(1,Math.min(file.size/1000000,8)),text:String(result.text).trim()}];
    return segments;
  } finally { URL.revokeObjectURL(audioUrl); }
}

export function captionsToSrt(captions:CaptionSegment[],clipStart:number,clipEnd:number):string {
  const stamp=(seconds:number)=>{const ms=Math.round((seconds%1)*1000),n=Math.floor(seconds);return `${String(Math.floor(n/3600)).padStart(2,"0")}:${String(Math.floor(n/60)%60).padStart(2,"0")}:${String(n%60).padStart(2,"0")},${String(ms).padStart(3,"0")}`;};
  return captions.filter(c=>c.end>clipStart&&c.start<clipEnd).map((c,i)=>`${i+1}\n${stamp(Math.max(0,c.start-clipStart))} --> ${stamp(Math.min(clipEnd-clipStart,c.end-clipStart))}\n${c.text}\n`).join("\n");
}
