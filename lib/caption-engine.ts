import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

export type CaptionSegment = { start:number; end:number; text:string };
let whisper: any = null;

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
    whisper = await pipeline("automatic-speech-recognition","Xenova/whisper-base",{device:"wasm"}) as any;
  }
  onStatus("Transcribing audio locally in your browser…");
  const audioUrl = URL.createObjectURL(new Blob([audio as BlobPart],{type:"audio/wav"}));
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


/** Create ASS subtitles with karaoke-style word highlighting. Times are clip-relative. */
export function captionsToAss(captions:CaptionSegment[],clipStart:number,clipEnd:number):string {
  const time=(s:number)=>{const cs=Math.max(0,Math.round(s*100)),h=Math.floor(cs/360000),m=Math.floor(cs/6000)%60,sec=Math.floor(cs/100)%60,centi=cs%100;return `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}.${String(centi).padStart(2,"0")}`;};
  const escape=(s:string)=>s.replace(/\\/g,"\\\\").replace(/{/g,"\\{").replace(/}/g,"\\}").replace(/\n/g," ");
  const events=captions.filter(c=>c.end>clipStart&&c.start<clipEnd).map(c=>{
    const start=Math.max(clipStart,c.start)-clipStart,end=Math.min(clipEnd,c.end)-clipStart;
    const words=escape(c.text).split(/\s+/).filter(Boolean);if(!words.length||end<=start)return "";
    const weights=words.map(w=>Math.max(1,w.replace(/[.,!?]/g,"").length)),total=weights.reduce((a,b)=>a+b,0);
    let used=0;const karaoke=words.map((w,i)=>{const d=i===words.length-1?Math.max(1,Math.round((end-start)*100)-used):Math.max(1,Math.round((end-start)*100*weights[i]/total));used+=d;return `{\\k${d}}${w}`;}).join(" ");
    return `Dialogue: 0,${time(start)},${time(end)},Karaoke,,0,0,0,,${karaoke}`;
  }).filter(Boolean).join("\n");
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Karaoke,Arial,68,&H00FFFFFF,&H0000D7FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,70,70,170,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events}\n`;
}
