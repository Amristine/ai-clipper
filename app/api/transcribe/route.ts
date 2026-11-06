import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const apiKey = request.headers.get("x-groq-api-key")?.trim();
    if (!apiKey) {
      return NextResponse.json({ error: "Add your Groq API key in AI settings." }, { status: 401 });
    }

    const form = await request.formData();
    const audio = form.get("audio");
    if (!audio || typeof audio === "string" || typeof audio.arrayBuffer !== "function") {
      return NextResponse.json({ error: "No audio file was received." }, { status: 400 });
    }
    if (audio.size <= 0) {
      return NextResponse.json({ error: "The extracted audio chunk is empty." }, { status: 400 });
    }
    // Keep requests safely below the 4.5 MB serverless request-body ceiling.
    if (audio.size > 4 * 1024 * 1024) {
      return NextResponse.json({ error: "Audio chunk is too large. Please retry; ClipForge will split it into smaller chunks." }, { status: 413 });
    }

    const groqForm = new FormData();
    groqForm.append("file", audio, audio.name || "clipforge-audio.flac");
    groqForm.append("model", "whisper-large-v3-turbo");
    groqForm.append("response_format", "verbose_json");
    groqForm.append("timestamp_granularities[]", "word");
    groqForm.append("timestamp_granularities[]", "segment");
    groqForm.append("temperature", "0");

    const upstream = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey },
      body: groqForm,
      cache: "no-store",
    });

    const raw = await upstream.text();
    let result: any;
    try {
      result = JSON.parse(raw);
    } catch {
      result = { error: raw || "Groq returned an unreadable response." };
    }

    if (!upstream.ok) {
      const message = result?.error?.message || result?.error || "Groq transcription failed.";
      const messageText = String(message);
      const headerDelay = Number(upstream.headers.get("retry-after"));
      const messageDelay = messageText.match(/try again in\\s*([0-9.]+)\\s*s/i);
      const retryAfterSeconds = upstream.status === 429
        ? (Number.isFinite(headerDelay) && headerDelay > 0
            ? headerDelay
            : messageDelay
              ? Number(messageDelay[1])
              : 5)
        : undefined;
      return NextResponse.json(
        { error: messageText, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
        {
          status: upstream.status,
          headers: retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : undefined,
        }
      );
    }

    return NextResponse.json({
      text: result.text || "",
      words: Array.isArray(result.words) ? result.words : [],
      segments: Array.isArray(result.segments) ? result.segments : [],
      language: result.language || null,
      duration: result.duration || null,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Unable to process audio for AI transcription." },
      { status: 500 }
    );
  }
}
