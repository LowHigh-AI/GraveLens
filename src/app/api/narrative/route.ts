import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse, after } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { admitAiCall } from "@/lib/tokenGate";
import { requireRateLimit } from "@/lib/rateLimit";
import { logUsage } from "@/lib/lowhigh";
import { createClient } from "@/lib/supabase/server";
import { getAiContentCache, saveAiContentCache, aiContentCacheKey } from "@/lib/researchCache";

// Uses Haiku — this is a creative writing task, not vision analysis.
// Haiku produces excellent narrative prose at ~$0.003/call.
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = `You are a historical narrator for a genealogy app. Your role is to write
evocative, historically accurate prose that helps people connect with the lives of those
whose graves they have photographed.

Rules:
- Write in third-person perspective about the era and context, not directly about the individual
- Focus on what is historically verifiable about their time and place
- Never fabricate specifics not evidenced by the marker (do not invent an occupation, family, or cause of death)
- Be thoughtful and respectful — this is about someone's ancestor
- Keep the narrative to 2–3 paragraphs
- Do not use filler phrases like "little is known" or "we can only imagine"
- Return ONLY valid JSON — no markdown, no explanation, no code fences`;

function buildPrompt(params: {
  name: string;
  birthYear: number | null;
  deathYear: number | null;
  birthDate: string;
  deathDate: string;
  ageAtDeath: number | null;
  city?: string;
  state?: string;
  country?: string;
  inscription: string;
  epitaph: string;
  symbols: string[];
  birthEra?: string;
  deathEra?: string;
  lifeExpectancyAtDeath?: number;
  militaryConflict?: string;
  militaryTheater?: string;
  militaryRole?: string;
}): string {
  const lines: string[] = [];

  lines.push(`Name: ${params.name || "Unknown"}`);

  if (params.birthDate || params.deathDate) {
    lines.push(
      `Life dates: ${[params.birthDate, params.deathDate].filter(Boolean).join(" – ")}`
    );
  }

  if (params.ageAtDeath) lines.push(`Age at death: ${params.ageAtDeath}`);

  if (params.city || params.state) {
    lines.push(
      `Location: ${[params.city, params.state, params.country].filter(Boolean).join(", ")}`
    );
  }

  if (params.birthEra) lines.push(`Born in era: ${params.birthEra}`);
  if (params.deathEra && params.deathEra !== params.birthEra)
    lines.push(`Died in era: ${params.deathEra}`);

  if (
    params.lifeExpectancyAtDeath &&
    params.ageAtDeath &&
    Math.abs(params.ageAtDeath - params.lifeExpectancyAtDeath) >= 5
  ) {
    const diff = params.ageAtDeath - params.lifeExpectancyAtDeath;
    lines.push(
      `Life expectancy context: average lifespan in their birth era was ~${params.lifeExpectancyAtDeath} years; they lived ${diff > 0 ? diff + " years longer" : Math.abs(diff) + " years shorter"} than average`
    );
  }

  if (params.militaryConflict) {
    lines.push(`Military service: ${params.militaryConflict}`);
    if (params.militaryTheater) lines.push(`Theater: ${params.militaryTheater}`);
    if (params.militaryRole) lines.push(`Role: ${params.militaryRole}`);
  }

  if (params.symbols.length > 0) {
    lines.push(`Symbols on marker: ${params.symbols.join("; ")}`);
  }

  if (params.inscription) {
    lines.push(`Full inscription: ${params.inscription}`);
  }

  if (params.epitaph) {
    lines.push(`Epitaph: "${params.epitaph}"`);
  }

  return (
    lines.join("\n") +
    `

Based on the above, return JSON with exactly these fields:

{
  "narrative": "2–3 paragraph historical narrative about what life was like for someone of this era, place, and background. Ground the story in the specific era, region, and any marker evidence (military service, fraternal symbols, religious affiliation). Write with empathy and historical depth.",
  "epitaphSource": "If the epitaph is a quotation from a known source (Bible verse, hymn, poem, literary work), identify it here. Otherwise empty string.",
  "epitaphMeaning": "A sentence or two explaining what the epitaph meant to families of that era and why it was chosen. Empty string if no epitaph."
}`
  );
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.name !== "string") {
      return NextResponse.json({ error: "Invalid or missing 'name' input" }, { status: 400 });
    }

    // Cap free-text fields that feed into the prompt to bound token spend
    // (mirrors the inscription cap in /api/story).
    if (typeof body.name === "string") body.name = body.name.slice(0, 200);
    if (typeof body.inscription === "string") body.inscription = body.inscription.slice(0, 2000);
    if (typeof body.epitaph === "string") body.epitaph = body.epitaph.slice(0, 1000);
    if (typeof body.city === "string") body.city = body.city.slice(0, 120);
    if (typeof body.state === "string") body.state = body.state.slice(0, 120);
    if (Array.isArray(body.symbols)) body.symbols = body.symbols.slice(0, 20);

    // ── Shared cache: identical inputs reuse a prior Claude result (no spend) ──
    // promptId is volatile (per-request id) and must not affect the cache key.
    const supabase = await createClient();
    const { promptId: _promptId, ...keyInput } = body;
    const cacheKey = aiContentCacheKey(keyInput);
    const cached = await getAiContentCache(supabase, "narrative", cacheKey).catch(() => null);
    if (cached) {
      return NextResponse.json({ ...cached, fromCache: true });
    }

    // Cache miss — gate tokens/rate, then generate.
    const admit = await admitAiCall(auth.userId, "narrative");
    if (admit.response) return admit.response;
    if (admit.release) after(admit.release);

    const rl = await requireRateLimit(auth.userId, "narrative");
    if (rl) return rl;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Configuration error", details: "API key missing." },
        { status: 500 }
      );
    }

    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: buildPrompt(body),
        },
      ],
    });

    const content = message.content[0];
    if (content.type !== "text") {
      throw new Error("Unexpected response type");
    }

    const rawJson = content.text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    let result: Record<string, unknown>;
    try {
      result = JSON.parse(rawJson);
    } catch (parseErr) {
      console.error("[narrative] JSON parse failed on text:", content.text, parseErr);
      return NextResponse.json(
        { error: "Claude returned malformed JSON", details: rawJson },
        { status: 502 }
      );
    }

    // Persist the generated content for reuse by any future identical request.
    after(() => saveAiContentCache(supabase, "narrative", cacheKey, result).catch(() => {}));

    after(() =>
      logUsage(auth.userId, {
        endpoint: "/api/narrative",
        provider: "anthropic",
        modelId: `anthropic/${MODEL}`,
        model: MODEL,
        requestType: "narrative",
        inputTokens: message.usage?.input_tokens ?? null,
        outputTokens: message.usage?.output_tokens ?? null,
        promptId: typeof body.promptId === "string" && body.promptId ? body.promptId : crypto.randomUUID(),
        tool: "Narrative",
        component: "Generate Narrative",
      })
    );

    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error("Narrative generation error:", error);
    return NextResponse.json(
      { error: "Narrative generation failed" },
      { status: 500 }
    );
  }
}
