import type { CaptionSegment } from "@/lib/caption-engine";
import { extractVideoFrames } from "@/lib/video-frames";

export type ClipSuggestion = {
  start: number;
  end: number;
  title: string;
  score: number;
  reason: string;
};

export type CloudProvider = "openrouter" | "nvidia";

type AnalyzeOptions = {
  provider: CloudProvider;
  apiKey: string;
  model: string;
  file: File;
  transcript: CaptionSegment[];
  duration: number;
  clipCount: number;
  clipLength: number;
  onProgress?: (message: string) => void;
};

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("\n");
  }
  return "";
}

function extractJson(text: string): any {
  const cleaned = text.replace(/^﻿/, "").replace(/^s*```(?:json)?/i, "").replace(/```s*$/, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("The selected model did not return JSON clip suggestions. Try another model.");
  try {
    return JSON.parse(cleaned.slice(first, last + 1));
  } catch {
    throw new Error("The model returned invalid clip JSON. Try again or choose another model.");
  }
}

function timestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parts = value.trim().split(":").map(Number);
    if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
    if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return NaN;
}

export async function analyzeWithCloudProvider(options: AnalyzeOptions): Promise<ClipSuggestion[]> {
  const { provider, apiKey, model, file, transcript, duration, clipCount, clipLength, onProgress } = options;
  if (!apiKey.trim()) throw new Error("Paste your API key in AI settings first.");
  if (!model.trim()) throw new Error("Enter a model ID in AI settings.");

  onProgress?.("Sampling video frames locally…");
  const frames = await extractVideoFrames(file, 6, 512, onProgress);
  const transcriptText = transcript.map(segment =>
    `[${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.text.replace(/\s+/g, " ").trim()}`
  ).join("\n");

  const prompt = `You are a professional short-form podcast/interview editor. Analyse this timestamped transcript and the sampled video frames from a ${duration.toFixed(1)}-second video.

Find up to ${clipCount} of the strongest standalone short clips. Target about ${clipLength} seconds per clip, but preserve a complete and understandable thought even when that requires going longer or shorter.

STRICT EDITING RULES:
1. Prefer complete QUESTION-AND-ANSWER exchanges: include the whole question (or enough of it to understand the context) and the guest's strongest complete answer.
2. Start shortly before the question or hook begins. End after the answer reaches a natural conclusion. Never cut off a sentence, question, or answer.
3. Select interesting, useful, surprising, funny, emotional, opinionated, or highly relatable moments. Avoid generic filler and repeated points.
4. Avoid long silent gaps. Timestamps should be tight around speech, but preserve natural breathing room.
5. Do not overlap clips. Return the strongest clips in descending quality order.
6. The transcript timestamps are seconds from the beginning of the original video. Use them as the source of truth for start/end values. Do not invent timestamps. Sampled frames are visual context only.
7. Use the video frames to understand who is speaking, scene changes, and whether the selected moment has useful visual context. Do not infer spoken words from a still frame.

Return ONLY valid JSON with this exact shape:
{"clips":[{"start":12.4,"end":48.2,"title":"A concise engaging title","score":94,"reason":"A complete question followed by a useful answer"}]}

TRANSCRIPT:
${transcriptText}

The six attached images are evenly sampled frames from the source video. Their order follows the video timeline.`;

  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const frame of frames) {
    content.push({ type: "text", text: "Sampled video frame at " + frame.timestamp.toFixed(2) + " seconds:" });
    content.push({ type: "image_url", image_url: { url: frame.dataUrl } });
  }

  const endpoint = provider === "openrouter"
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://integrate.api.nvidia.com/v1/chat/completions";

  onProgress?.("Analysing transcript and visual frames with " + (provider === "openrouter" ? "OpenRouter" : "NVIDIA NIM") + "…");
  const headers: Record<string, string> = {
    "Authorization": "Bearer " + apiKey.trim(),
    "Content-Type": "application/json"
  };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = typeof window !== "undefined" ? window.location.origin : "https://clipforge.local";
    headers["X-Title"] = "ClipForge AI";
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model.trim(),
      messages: [{ role: "user", content }],
      temperature: 0.25,
      max_tokens: 3500,
      stream: false
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || "Unknown provider error";
    if (response.status === 401 || response.status === 403) throw new Error("API key rejected by " + provider + ". Check that you pasted the correct key.");
    if (response.status === 402) throw new Error("The selected model requires credits or has no free quota remaining.");
    if (response.status === 429) throw new Error("Rate limit reached. Wait a little or try another model/provider.");
    throw new Error((provider === "openrouter" ? "OpenRouter" : "NVIDIA NIM") + " error (" + response.status + "): " + detail);
  }

  const answer = messageText(data?.choices?.[0]?.message?.content);
  if (!answer.trim()) throw new Error("The AI provider returned an empty response. Try another model.");
  const parsed = extractJson(answer);
  const rawClips = Array.isArray(parsed) ? parsed : parsed.clips;
  if (!Array.isArray(rawClips)) throw new Error("The model response did not contain a clips array.");

  const clips = rawClips.map((clip: any, index: number) => {
    const start = timestamp(clip.start ?? clip.start_time);
    const end = timestamp(clip.end ?? clip.end_time);
    return {
      start: Math.max(0, start),
      end: Math.min(duration, end),
      title: String(clip.title || "Highlight " + (index + 1)).trim().slice(0, 100),
      score: Math.max(0, Math.min(100, Number(clip.score) || 80)),
      reason: String(clip.reason || "Selected by " + provider).trim().slice(0, 240)
    } satisfies ClipSuggestion;
  }).filter((clip: ClipSuggestion) =>
    Number.isFinite(clip.start) && Number.isFinite(clip.end) &&
    clip.start < clip.end && clip.end <= duration && clip.end - clip.start >= 5
  ).slice(0, clipCount);

  if (!clips.length) throw new Error("The model returned no valid clip timestamps. Try a different model or increase clip duration.");
  return clips;
}

export async function testCloudProvider(provider: CloudProvider, apiKey: string, model: string): Promise<void> {
  if (!apiKey.trim()) throw new Error("Enter your API key first.");
  if (!model.trim()) throw new Error("Enter a model ID first.");
  const endpoint = provider === "openrouter"
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://integrate.api.nvidia.com/v1/chat/completions";
  const headers: Record<string, string> = {
    "Authorization": "Bearer " + apiKey.trim(),
    "Content-Type": "application/json"
  };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = typeof window !== "undefined" ? window.location.origin : "https://clipforge.local";
    headers["X-Title"] = "ClipForge AI";
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model.trim(),
      messages: [{ role: "user", content: "Reply with exactly: ClipForge connection successful." }],
      temperature: 0,
      max_tokens: 24,
      stream: false
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || "Unknown provider error";
    throw new Error("Connection failed (" + response.status + "): " + detail);
  }
  if (!data?.choices?.[0]?.message?.content) throw new Error("The provider responded, but returned no message.");
}
