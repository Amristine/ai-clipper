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
    let result:any=null;
    let segments:CaptionSegment[]=[];
    try{
      result=await (whisper as any)(audioUrl,{chunk_length_s:20,stride_length_s:3,return_timestamps:"word"});
      segments=(result.chunks||[]).map((chunk:any)=>({
        start:Number(chunk.timestamp?.[0]??0), end:Number(chunk.timestamp?.[1]??0), text:String(chunk.text||"").trim()
      })).filter((s:CaptionSegment)=>s.text&&Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>s.start);
    }catch(error){console.warn("Whisper word alignment failed; retrying segment timestamps.",error);}
    // Fall back to Whisper segment timestamps when the model cannot align individual words.
    if(!segments.length){
      result=await (whisper as any)(audioUrl,{chunk_length_s:30,stride_length_s:5,return_timestamps:true});
      segments=(result.chunks||[]).map((chunk:any)=>({
        start:Number(chunk.timestamp?.[0]??0), end:Number(chunk.timestamp?.[1]??0), text:String(chunk.text||"").trim()
      })).filter((s:CaptionSegment)=>s.text&&Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>s.start);
    }
    if(!segments.length&&result.text){
      const audioBytes=audio instanceof Uint8Array?audio.byteLength:new TextEncoder().encode(audio).byteLength;
      const audioSeconds=Math.max(1,(audioBytes-44)/32000);
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

export type CaptionStyle = "word-cut" | "marker-sweep" | "negative-keywords" | "karaoke" | "clean";
export type CaptionPosition = "top" | "middle" | "bottom";
export type CaptionSize = "small" | "medium" | "large";

/** Render selectable short-form caption presets, position and size as ASS subtitles. */
export function captionsToAss(
  captions:CaptionSegment[],
  clipStart:number,
  clipEnd:number,
  style:CaptionStyle="word-cut",
  position:CaptionPosition="bottom",
  size:CaptionSize="medium"
):string {
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
  const fontSize=size==="small"?54:size==="large"?96:76;
  const alignment=position==="top"?8:position==="middle"?5:2;
  const marginV=position==="top"?175:position==="middle"?0:190;
  const presets:Record<CaptionStyle,{primary:string;secondary:string;outline:string;back:string;border:number;outlineSize:number;shadow:number;bold:number;italic:number}> = {
    "word-cut":{primary:"&H00FFFFFF",secondary:"&H00FFFFFF",outline:"&H00000000",back:"&H80000000",border:1,outlineSize:5,shadow:2,bold:1,italic:0},
    "marker-sweep":{primary:"&H00000000",secondary:"&H00000000",outline:"&H00B78AFF",back:"&H00B78AFF",border:3,outlineSize:12,shadow:0,bold:1,italic:0},
    "negative-keywords":{primary:"&H00FFFFFF",secondary:"&H0047B7FF",outline:"&H00000000",back:"&H80000000",border:1,outlineSize:4,shadow:5,bold:1,italic:0},
    "karaoke":{primary:"&H00FFFFFF",secondary:"&H0000D7FF",outline:"&H00000000",back:"&H80000000",border:1,outlineSize:5,shadow:2,bold:1,italic:1},
    "clean":{primary:"&H00FFFFFF",secondary:"&H00FFFFFF",outline:"&H99000000",back:"&H80000000",border:1,outlineSize:2,shadow:0,bold:0,italic:0}
  };
  const preset=presets[style]||presets["word-cut"];
  const events=groupCaptionSegments(captions).filter(c=>c.end>clipStart&&c.start<clipEnd).map(c=>{
    const start=Math.max(clipStart,c.start)-clipStart,end=Math.min(clipEnd,c.end)-clipStart;
    if(end<=start)return "";
    let text=wrap(escape(c.text));
    if(style==="karaoke"){
      const sourceWords=captions.filter(word=>word.end>c.start&&word.start<c.end);
      const tokens=sourceWords.flatMap(word=>{
        const parts=word.text.trim().split(/\s+/).filter(Boolean);
        return parts.map(part=>({text:part,duration:Math.max(0.02,(word.end-word.start)/Math.max(1,parts.length))}));
      });
      const total=tokens.reduce((sum,token)=>sum+token.duration,0)||1;
      let used=0;
      text=tokens.map((token,index)=>{
        const centiseconds=index===tokens.length-1?Math.max(1,Math.round((end-start)*100)-used):Math.max(1,Math.round((end-start)*100*token.duration/total));
        used+=centiseconds;
        return `{\\kf${centiseconds}}${escape(token.text.toLocaleUpperCase())}`;
      }).join(" ");
      if(!tokens.length)text=wrap(escape(c.text));
    }
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
Style: Caption,Arial,${fontSize},${preset.primary},${preset.secondary},${preset.outline},${preset.back},${preset.bold},${preset.italic},0,0,100,100,0,0,${preset.border},${preset.outlineSize},${preset.shadow},${alignment},75,75,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;
}
/**
 * Fast cloud transcription through Groq Whisper Large V3 Turbo.
 * Audio is extracted locally into short FLAC chunks; only audio is sent to
 * the same-origin API route. Word timestamps are kept for animated captions.
 */
export async function transcribeVideoWithGroq(
  file:File,
  ffmpeg:FFmpeg,
  apiKey:string,
  duration:number,
  onStatus:(status:string)=>void
):Promise<CaptionSegment[]> {
  if(!apiKey.trim()) throw new Error("Add your Groq API key to generate AI captions.");
  if(!Number.isFinite(duration)||duration<=0) throw new Error("Wait for the video preview to finish loading, then generate captions.");
  const input="groq-source."+((file.name.split(".").pop()||"mp4").replace(/[^a-z0-9]/gi,""));
  const outputPrefix="groq-audio-";
  const ranges:Array<{start:number;end:number}>=[];
  for(let start=0;start<duration;start+=240) ranges.push({start,end:Math.min(duration,start+240)});
  const results:CaptionSegment[]=[];
  let completed=0,part=0;
  await ffmpeg.writeFile(input,await fetchFile(file));
  try{
    while(ranges.length){
      const range=ranges.shift()!;
      const name=outputPrefix+(part++)+".flac";
      const partDuration=range.end-range.start;
      onStatus("Preparing audio for AI captions · "+(completed+1)+"/"+(completed+ranges.length+1));
      await ffmpeg.exec(["-ss",String(range.start),"-i",input,"-t",String(partDuration),"-vn","-ac","1","-ar","16000","-c:a","flac",name]);
      const audio=await ffmpeg.readFile(name);
      const blob=new Blob([audio as BlobPart],{type:"audio/flac"});
      try{await ffmpeg.deleteFile(name);}catch{}
      // Stay below common serverless request-body limits. Split oversized
      // chunks and retry them rather than failing on long/noisy recordings.
      if(blob.size>4*1024*1024&&partDuration>45){
        const middle=range.start+partDuration/2;
        ranges.unshift({start:middle,end:range.end},{start:range.start,end:middle});
        continue;
      }
      const body=new FormData();
      body.append("audio",blob,"clipforge-audio-"+(completed+1)+".flac");
      onStatus("Groq AI is transcribing · "+(completed+1)+"/"+(completed+ranges.length+1));
      const response=await fetch("/api/transcribe",{method:"POST",headers:{"x-groq-api-key":apiKey},body});
      const payload=await response.json().catch(()=>({error:"Transcription service returned an invalid response."}));
      if(!response.ok) throw new Error(payload.error||"Groq transcription failed ("+response.status+").");
      const timedWords=Array.isArray(payload.words)&&payload.words.length?payload.words:payload.segments;
      if(Array.isArray(timedWords)){
        for(const item of timedWords){
          const text=String(item.word??item.text??"").trim();
          const start=Number(item.start),end=Number(item.end);
          if(text&&Number.isFinite(start)&&Number.isFinite(end)&&end>start){
            results.push({start:start+range.start,end:end+range.start,text});
          }
        }
      }
      if(!timedWords?.length&&payload.text){
        results.push({start:range.start,end:range.end,text:String(payload.text).trim()});
      }
      if(!timedWords?.length&&!payload.text) throw new Error("Groq returned no speech for audio chunk "+(completed+1)+".");
      completed++;
      onStatus("AI captions · "+completed+" audio chunk(s) complete");
    }
  }finally{
    try{await ffmpeg.deleteFile(input);}catch{}
  }
  results.sort((a,b)=>a.start-b.start);
  if(!results.length) throw new Error("No speech was detected in this video.");
  return results;
}

