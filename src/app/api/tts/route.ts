import { NextRequest, NextResponse, after } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { admitAiCall } from "@/lib/tokenGate";
import { requireRateLimit } from "@/lib/rateLimit";
import { logUsage } from "@/lib/lowhigh";

const ALLOWED_VOICES = new Set(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const admit = await admitAiCall(auth.userId, "tts");
  if (admit.response) return admit.response;
  if (admit.release) after(admit.release);

  const rl = await requireRateLimit(auth.userId, "tts");
  if (rl) return rl;

  try {
    // tool/component name the FRONTEND action that invoked this route (the
    // "Hear their story" flow ends here), falling back to this route's own labels.
    const { text, voice, promptId, tool, component } = await req.json();

    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "text required" }, { status: 400 });
    }

    const safeVoice = ALLOWED_VOICES.has(voice) ? voice : "alloy";

    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 503 });
    }

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        input: text.slice(0, 4096), // OpenAI max input length
        voice: safeVoice,
        response_format: "mp3",
      }),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => "unknown error");
      console.error("[tts] OpenAI error:", response.status, err);
      return NextResponse.json({ error: "TTS generation failed" }, { status: 502 });
    }

    // tts-1 is char/flat-rate, not token-based — log as one billable query.
    // ai_models must price tts-1 via cost_per_query (see gravelens_03_ai_models).
    const billedChars = Math.min(text.length, 4096);
    after(() =>
      logUsage(auth.userId, {
        endpoint: "/api/tts",
        provider: "openai",
        modelId: "openai/tts-1",
        model: "tts-1",
        requestType: "tts",
        queries: 1,
        promptId: typeof promptId === "string" && promptId ? promptId : crypto.randomUUID(),
        tool: typeof tool === "string" && tool ? tool : "Audio",
        component: typeof component === "string" && component ? component : "Read Aloud",
        metadata: { chars: billedChars },
      })
    );

    return new Response(response.body, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[tts]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
