export type ClipRange = { start: number; end: number };

/** Converts FFmpeg silencedetect logs into clip-relative ranges to keep.
 * Long pauses (>= 450 ms) lose their middle while retaining a short natural
 * breath at both edges so words do not sound abruptly chopped.
 */
export function parseSilenceLog(log: string, duration: number, edgePad = 0.08): ClipRange[] {
  const silences: ClipRange[] = [];
  let activeStart: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (startMatch) activeStart = Math.max(0, Number(startMatch[1]));
    const endMatch = line.match(/silence_end:\s*([\d.]+)/);
    if (endMatch && activeStart !== null) {
      silences.push({ start: activeStart, end: Math.max(activeStart, Number(endMatch[1])) });
      activeStart = null;
    }
  }
  if (activeStart !== null) silences.push({ start: activeStart, end: duration });
  if (!silences.length) return [{ start: 0, end: duration }];

  const keep: ClipRange[] = [];
  let cursor = 0;
  for (const silence of silences.sort((a, b) => a.start - b.start)) {
    const cutStart = Math.min(duration, Math.max(cursor, silence.start + edgePad));
    const cutEnd = Math.min(duration, Math.max(cutStart, silence.end - edgePad));
    if (cutStart - cursor > 0.06) keep.push({ start: cursor, end: cutStart });
    cursor = Math.max(cursor, cutEnd);
  }
  if (duration - cursor > 0.06) keep.push({ start: cursor, end: duration });
  return keep.length ? keep : [{ start: 0, end: duration }];
}

const ffTime = (seconds: number) => Math.max(0, seconds).toFixed(3);
const assTimeToSeconds = (value: string) => {
  const match = value.match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 100 : 0;
};
const secondsToAssTime = (seconds: number) => {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60, c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
};

/** Moves existing clip-relative ASS caption events onto the silence-trimmed timeline. */
export function remapAssToCutTimeline(ass: string, ranges: ClipRange[]): string {
  const output: string[] = [];
  let outputOffset = 0;
  for (const line of ass.split(/\r?\n/)) {
    if (!line.startsWith("Dialogue:")) { output.push(line); continue; }
    const fields = line.slice("Dialogue:".length).trimStart().split(",", 10);
    if (fields.length < 10) continue;
    const eventStart = assTimeToSeconds(fields[1]);
    const eventEnd = assTimeToSeconds(fields[2]);
    let offset = 0;
    for (const range of ranges) {
      const from = Math.max(eventStart, range.start);
      const to = Math.min(eventEnd, range.end);
      if (to > from) {
        const copy = [...fields];
        copy[1] = secondsToAssTime(outputOffset + from - range.start);
        copy[2] = secondsToAssTime(outputOffset + to - range.start);
        output.push("Dialogue: " + copy.join(","));
      }
      offset += range.end - range.start;
    }
    outputOffset = 0;
  }
  // The running offset is based on all preceding kept ranges, not on the
  // original dialogue event, so perform the remap with a clean pass.
  const header = output.filter(line => !line.startsWith("Dialogue:"));
  const dialogues: string[] = [];
  let timelineOffset = 0;
  const originalLines = ass.split(/\r?\n/).filter(line => line.startsWith("Dialogue:"));
  for (const line of originalLines) {
    const fields = line.slice("Dialogue:".length).trimStart().split(",", 10);
    if (fields.length < 10) continue;
    const eventStart = assTimeToSeconds(fields[1]);
    const eventEnd = assTimeToSeconds(fields[2]);
    timelineOffset = 0;
    for (const range of ranges) {
      const from = Math.max(eventStart, range.start);
      const to = Math.min(eventEnd, range.end);
      if (to > from) {
        const copy = [...fields];
        copy[1] = secondsToAssTime(timelineOffset + from - range.start);
        copy[2] = secondsToAssTime(timelineOffset + to - range.start);
        dialogues.push("Dialogue: " + copy.join(","));
      }
      timelineOffset += range.end - range.start;
    }
  }
  const eventIndex = header.findIndex(line => line.startsWith("Format: Layer,"));
  const safeHeader = header.filter(line => !line.startsWith("Dialogue:"));
  if (eventIndex >= 0) safeHeader.splice(eventIndex + 1, 0, ...dialogues);
  else safeHeader.push(...dialogues);
  return safeHeader.join("\n");
}

/** Creates one synchronized video+audio graph, then applies captions after cuts. */
export function buildClipFilterGraph(
  ranges: ClipRange[],
  videoFilter: string,
  sourceOffset: number,
  subtitlePath?: string
): string {
  const parts: string[] = [];
  ranges.forEach((range, index) => {
    const start = ffTime(sourceOffset + range.start);
    const end = ffTime(sourceOffset + range.end);
    parts.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,${videoFilter}[v${index}]`);
    parts.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]`);
  });
  if (ranges.length === 1) {
    parts.push("[v0]null[vcat]");
    parts.push("[a0]anull[acat]");
  } else {
    const inputs = ranges.map((_, i) => `[v${i}][a${i}]`).join("");
    parts.push(`${inputs}concat=n=${ranges.length}:v=1:a=1[vcat][acat]`);
  }
  if (subtitlePath) {
    const escaped = subtitlePath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
    parts.push(`[vcat]subtitles='${escaped}'[vout]`);
  } else {
    parts.push("[vcat]null[vout]");
  }
  return parts.join(";");
}
