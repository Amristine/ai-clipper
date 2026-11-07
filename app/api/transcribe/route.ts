import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const transcriptionEngine = request.headers.get("x-transcription-engine") || "groq";
    const form = await request.formData();
    const audio = form.get("audio");
    if (!audio || typeof audio === "string" || typeof audio.arrayBuffer !== "function") {
      return NextResponse.json({ error: "No audio file was received." }, { status: 400 });
    }
    if (audio.size <= 0) {
      return NextResponse.json({ error: "The extracted audio chunk is empty." }, { status: 400 });
    }
    if (audio.size > 4 * 1024 * 1024) {
      return NextResponse.json({ error: "Audio chunk is too large. Please retry; ClipForge will split it into smaller chunks." }, { status: 413 });
    }

    if (transcriptionEngine === "gemini") {
      const geminiKey = request.headers.get("x-gemini-api-key")?.trim();
      if (!geminiKey) {
        return NextResponse.json({ error: "Add your Gemini API key in AI settings to use Gemini transcription." }, { status: 401 });
      }

      const mimeType = audio.type || "audio/flac";
      const uploadStart = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
        method: "POST",
        headers: {
          "x-goog-api-key": geminiKey,
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(audio.size),
          "X-Goog-Upload-Header-Content-Type": mimeType,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file: { display_name: audio.name || "clipforge-audio" } }),
        cache: "no-store",
      });
      const uploadStartText = await uploadStart.text();
      let uploadStartData: any = {};
      try { uploadStartData = JSON.parse(uploadStartText); } catch {}
      if (!uploadStart.ok) {
        const message = uploadStartData?.error?.message || uploadStartText || "Gemini audio upload could not be initialized.";
        return NextResponse.json({ error: String(message) }, { status: uploadStart.status });
      }
      const uploadUrl = uploadStart.headers.get("x-goog-upload-url");
      if (!uploadUrl) {
        return NextResponse.json({ error: "Gemini did not return an audio upload URL." }, { status: 502 });
      }

      const uploaded = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Length": String(audio.size),
          "X-Goog-Upload-Offset": "0",
          "X-Goog-Upload-Command": "upload, finalize",
          "Content-Type": mimeType,
        },
        body: audio,
        cache: "no-store",
      });
      const uploadedText = await uploaded.text();
      let uploadedData: any = {};
      try { uploadedData = JSON.parse(uploadedText); } catch {}
      if (!uploaded.ok || !uploadedData?.file?.uri) {
        const message = uploadedData?.error?.message || uploadedText || "Gemini audio upload failed.";
        return NextResponse.json({ error: String(message) }, { status: uploaded.status || 502 });
      }

      const interaction = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: { "x-goog-api-key": geminiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gemini-3.5-transcribe",
          store: false,
          input: [{ type: "audio", uri: uploadedData.file.uri, mime_type: mimeType }],
          generation_config: {
            transcription_config: {
              mode: { type: "verbatim", timestamp_granularities: ["word"] },
            },
          },
        }),
        cache: "no-store",
      });
      const interactionText = await interaction.text();
      let interactionData: any = {};
      try { interactionData = JSON.parse(interactionText); } catch {}
      // Gemini Files are temporary, but delete each audio chunk immediately
      // after inference instead of keeping it until the automatic 48-hour expiry.
      if (uploadedData.file.name) {
        try {
          await fetch(
            "https://generativelanguage.googleapis.com/v1beta/" + uploadedData.file.name,
            { method: "DELETE", headers: { "x-goog-api-key": geminiKey }, cache: "no-store" }
          );
        } catch (cleanupError) {
          console.warn("Gemini temporary audio file cleanup failed.", cleanupError);
        }
      }
      if (!interaction.ok) {
        const message = interactionData?.error?.message || interactionText || "Gemini transcription failed.";
        return NextResponse.json({ error: String(message) }, { status: interaction.status });
      }

      const words: Array<{ text: string; start: number; end: number }> = [];
      for (const step of interactionData.steps || []) {
        for (const content of step.content || []) {
          for (const annotation of content.annotations || []) {
            if (annotation.type !== "word_info") continue;
            const start = Number.parseFloat(String(annotation.start_offset || ""));
            const end = Number.parseFloat(String(annotation.end_offset || ""));
            const text = String(annotation.text || "").trim();
            if (text && Number.isFinite(start) && Number.isFinite(end) && end > start) {
              words.push({ text, start, end });
            }
          }
        }
      }
      const outputText = interactionData.output_text || words.map(word => word.text).join(" ");
      if (!words.length && !outputText) {
        return NextResponse.json({ error: "Gemini returned no timestamped transcription. Try another transcription engine." }, { status: 502 });
      }
      return NextResponse.json({ text: outputText, words, segments: [], language: null, duration: null });
    }

    const apiKey = request.headers.get("x-groq-api-key")?.trim();
    if (!apiKey) {
      return NextResponse.json({ error: "Add your Groq API key in AI settings." }, { status: 401 });
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
      const messageDelay = messageText.match(/try again in\s*([0-9.]+)\s*s/i);
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
