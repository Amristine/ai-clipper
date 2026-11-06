import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

export type CaptionSegment = { start:number; end:number; text:string };
let whisper: any = null;

export async function loadWhisperModel(onProgress?:(progress:number,status:string)=>void):Promise<any> {
  if(whisper){onProgress?.(100,"Whisper model is already loaded");return whisper;}
  const {pipeline,env}=await import("@huggingface/transformers");
  env.allowLocalModels=false;
  env.useBrowserCache=true;
  const progress=(p:any)=> {
    if(p?.status==="progress"&&typeof p.progress==="number")
      onProgress?.(p.progress,(p.file||"Whisper files")+" · "+Math.round(p.progress)+"%");
    else if(p?.status) onProgress?.(0,"Whisper: "+p.status);
  };
  // Prefer the user's GPU through WebGPU. If WebGPU is unsupported or the
  // model/runtime fails to initialize, fall back to CPU/WASM automatically.
  if(typeof navigator!=="undefined" && "gpu" in navigator) {
    try {
      onProgress?.(0,"Initializing Whisper on GPU (WebGPU)…");
      whisper=await pipeline("automatic-speech-recognition","Xenova/whisper-base",{device:"webgpu",progress_callback:progress}) as any;
      onProgress?.(100,"Whisper ready · GPU (WebGPU)");
      return whisper;
    } catch(error) {
      console.warn("Whisper WebGPU initialization failed; falling back to CPU/WASM.",error);
      onProgress?.(0,"GPU unavailable; switching to CPU/WASM…");
    }
  }
  whisper=await pipeline("automatic-speech-recognition","Xenova/whisper-base",{device:"wasm",progress_callback:progress}) as any;
  onProgress?.(100,"Whisper ready · CPU (WASM)");
  return whisper;
}

export async function transcribeVideoLocally(file:File, ffmpeg:FFmpeg, onStatus:(s:string)=>void):Promise<CaptionSegment[]> {
  const input = "caption-input." + (file.name.split(".").pop() || "mp4").replace(/[^a-z0-9]/gi,"");
  await ffmpeg.writeFile(input, await fetchFile(file));
  await ffmpeg.exec(["-i",input,"-vn","-ac","1","-ar","16000","-c:a","pcm_s16le","caption-audio.wav"]);
  const audio = await ffmpeg.readFile("caption-audio.wav");
  onStatus("Loading Whisper model (first run downloads it)…");
  await loadWhisperModel((progress,status)=>onStatus(status));
  onStatus("Transcribing audio locally in your browser…");
  const audioUrl = URL.createObjectURL(new Blob([audio as BlobPart],{type:"audio/wav"}));
  try {
    let result:any = await (whisper as any)(audioUrl,{chunk_length_s:20,stride_length_s:3,return_timestamps:"word"});
    let segments:CaptionSegment[]=(result.chunks||[]).map((chunk:any)=>({
      start:Number(chunk.timestamp?.[0]??0), end:Number(chunk.timestamp?.[1]??0), text:String(chunk.text||"").trim()
    })).filter((s:CaptionSegment)=>s.text&&Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>s.start);
    // Fall back to Whisper segment timestamps when the model cannot align individual words.
    if(!segments.length){
      result=await (whisper as any)(audioUrl,{chunk_length_s:30,stride_length_s:5,return_timestamps:true});
      segments=(result.chunks||[]).map((chunk:any)=>({
        start:Number(chunk.timestamp?.[0]??0), end:Number(chunk.timestamp?.[1]??0), text:String(chunk.text||"").trim()
      })).filter((s:CaptionSegment)=>s.text&&Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>s.start);
    }
    if(!segments.length&&result.text){
      const audioSeconds=Math.max(1,(audio.byteLength-44)/32000);
      return [{start:0,end:audioSeconds,text:String(result.text).trim()}];
    }
    return segments;
  } finally { URL.revokeObjectURL(audioUrl); }
}

function groupCaptionSegments(segments:CaptionSegment[],maxWords=4,maxDuration=2.2,maxGap=0.32):CaptionSegment[]{
  const grouped:CaptionSegment[]=[];let current:CaptionSegment|null=null;
  for(const segment of segments){
    const text=segment.text.trim();if(!text||segment.end<=segment.start)continue;
    if(!current){current={start:segment.start,end:segment.end,text};continue;}
    const currentWords=current.text.trim().split(/\s+/).length;
    const nextWords=text.split(/\s+/).length;
    const previousText=current.text.trim();
    const completedSentence=previousText.endsWith(".")||previousText.endsWith("!")||previousText.endsWith("?");
    const gap=segment.start-current.end;
    if(!completedSentence&&gap<=maxGap&&currentWords+nextWords<=maxWords&&segment.end-current.start<=maxDuration){
      current={...current,end:Math.max(current.end,segment.end),text:(current.text+" "+text).replace(/\s+/g," ").trim()};
    }else{
      grouped.push(current);current={start:segment.start,end:segment.end,text};
    }
  }
  if(current)grouped.push(current);
  return grouped;
}

export function captionsToSrt(captions:CaptionSegment[],clipStart:number,clipEnd:number):string {
  const stamp=(seconds:number)=>{const ms=Math.round((seconds%1)*1000),n=Math.floor(seconds);return `${String(Math.floor(n/3600)).padStart(2,"0")}:${String(Math.floor(n/60)%60).padStart(2,"0")}:${String(n%60).padStart(2,"0")},${String(ms).padStart(3,"0")}`;};
  return groupCaptionSegments(captions).filter(c=>c.end>clipStart&&c.start<clipEnd).map((c,i)=>`${i+1}\n${stamp(Math.max(0,c.start-clipStart))} --> ${stamp(Math.min(clipEnd-clipStart,c.end-clipStart))}\n${c.text}\n`).join("\n");
}

/** Create bold, italic, all-caps social-video captions. Times are clip-relative. */
export function captionsToAss(captions:CaptionSegment[],clipStart:number,clipEnd:number):string {
  const time=(s:number)=>{const cs=Math.max(0,Math.round(s*100)),h=Math.floor(cs/360000),m=Math.floor(cs/6000)%60,sec=Math.floor(cs/100)%60,centi=cs%100;return `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}.${String(centi).padStart(2,"0")}`;};
  const escape=(s:string)=>s.replace(/\\/g,"\\\\").replace(/{/g,"\\{").replace(/}/g,"\\}").replace(/\n/g," ");
  const wrap=(value:string)=>{
    const words=value.toLocaleUpperCase().split(/\s+/).filter(Boolean);
    const lines:string[]=[];let line="";
    for(const word of words){
      const next=line?line+" "+word:word;
      if(next.length>25&&line&&lines.length<1){lines.push(line);line=word;}
      else line=next;
    }
    if(line)lines.push(line);
    return lines.slice(0,2).join("\\N");
  };
  const events=groupCaptionSegments(captions).filter(c=>c.end>clipStart&&c.start<clipEnd).map(c=>{
    const start=Math.max(clipStart,c.start)-clipStart,end=Math.min(clipEnd,c.end)-clipStart;
    if(end<=start)return "";
    const text=wrap(escape(c.text));
    return `Dialogue: 0,${time(start)},${time(end)},Caption,,0,0,0,,${text}`;
  }).filter(Boolean).join("\n");
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial,76,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,-1,0,0,100,100,0,0,1,5,2,2,75,75,540,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;
}
