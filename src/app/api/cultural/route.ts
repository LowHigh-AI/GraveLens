import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse, after } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { admitAiCall } from "@/lib/tokenGate";
import { requireRateLimit } from "@/lib/rateLimit";
import { logUsage } from "@/lib/lowhigh";
import { createClient } from "@/lib/supabase/server";
import { getAiContentCache, saveAiContentCache, aiContentCacheKey } from "@/lib/researchCache";

// Haiku is ideal here — rich descriptive prose at low cost.
const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are a historical lifestyle researcher for a genealogy app. Your role
is to paint vivid, accurate pictures of daily life in different eras and places — helping
modern people truly feel what it was like to be alive when their ancestors were.

Rules:
- Be specific: name actual technologies, songs, films, events, prices, brands, places
- Geography matters enormously — rural Iowa and urban Chicago in 1900 were different worlds
- Focus on the arc of change: what shifted dramatically across the person's lifetime
- Write about the era and place, never fabricate specifics about the individual
- Make the past tangible and human — the goal is emotional connection, not encyclopaedia entries
- Return ONLY valid JSON — no markdown fences, no preamble, no explanation`;

// ── Category definitions (shared with client) ─────────────────────────────

export const CATEGORY_DEFS = [
  { id: "popculture",    label: "Pop Culture",        icon: "🎵" },
  { id: "transport",     label: "Getting Around",     icon: "🚂" },
  { id: "homelife",      label: "Home & Daily Life",  icon: "🏡" },
  { id: "health",        label: "Health & Medicine",  icon: "🩺" },
  { id: "communication", label: "News & Communication", icon: "📻" },
];

// ── Prompt builders ───────────────────────────────────────────────────────

function personContext(params: {
  name: string;
  birthYear: number | null;
  deathYear: number | null;
  ageAtDeath: number | null;
  city?: string;
  state?: string;
}): string {
  const lines: string[] = [];
  lines.push(`Name: ${params.name || "Unknown"}`);
  if (params.birthYear) lines.push(`Born: ${params.birthYear}`);
  if (params.deathYear) lines.push(`Died: ${params.deathYear}`);
  if (params.ageAtDeath) lines.push(`Age at death: ${params.ageAtDeath}`);
  if (params.city || params.state) {
    lines.push(`Location: ${[params.city, params.state].filter(Boolean).join(", ")}`);
  }
  return lines.join("\n");
}

function summaryPrompt(params: Parameters<typeof personContext>[0]): string {
  return `${personContext(params)}

For each of the 5 categories below, write exactly 2 vivid sentences capturing the most
striking aspect of this person's lifetime experience in that domain. Lead with the most
surprising or tangible detail. Emphasise the arc of change — what they were born into
versus what they witnessed before they died.

Categories:
- "popculture":    Music, film, radio, theatre, and entertainment they would have experienced
- "transport":     How people moved around in their region; how the size of their world changed
- "homelife":      Daily home technology, food, housing; what changed from birth to death
- "health":        Medical care available, common diseases, health milestones of their era
- "communication": How news travelled; telegraph/telephone/radio adoption; how connected they were

Return ONLY this JSON (no other text):
{
  "categories": [
    { "id": "popculture",    "summary": "..." },
    { "id": "transport",     "summary": "..." },
    { "id": "homelife",      "summary": "..." },
    { "id": "health",        "summary": "..." },
    { "id": "communication", "summary": "..." }
  ]
}`;
}

function expandPrompt(
  params: Parameters<typeof personContext>[0],
  categoryId: string,
  categoryLabel: string
): string {
  return `${personContext(params)}
Category: ${categoryLabel}

Write 4 paragraphs walking through this person's lifetime experience with ${categoryLabel},
moving chronologically from their early years to the end of their life.

Be richly specific — name actual songs, technologies, what things cost, real events, local
places. Use their geography (${params.state ?? "their region"}) to ground it locally where
you can. Show how dramatically things changed across a single lifetime.

The person reading this is standing at this grave. Make them feel what that life actually
looked and sounded and smelled like. Make the past real and human.

Return ONLY this JSON (no other text):
{ "detail": "paragraph one\\n\\nparagraph two\\n\\nparagraph three\\n\\nparagraph four" }`;
}

// ── Route handler ─────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    // categoryLabel is intentionally NOT read from the client — it is derived
    // server-side from the allowlisted categoryId below, so a caller cannot
    // inject arbitrary text into the prompt via the label.
    // tool/component describe the FRONTEND action that invoked this route (e.g.
    // the "Hear their story" flow reuses this summary as one of its steps). They
    // are destructured out of rawPerson so they never affect the prompt or the
    // shared cache key. Falls back to this route's own labels when absent.
    const { mode, categoryId, promptId, tool, component, ...rawPerson } = body;

    // Allowlist mode and categoryId to keep callers on known code paths.
    const VALID_MODES = ["summary", "expand"] as const;
    if (!VALID_MODES.includes(mode)) {
      return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
    }
    const category = CATEGORY_DEFS.find((c) => c.id === categoryId);
    if (mode === "expand" && !category) {
      return NextResponse.json({ error: "Invalid categoryId" }, { status: 400 });
    }

    // Cap free-text fields that feed into the prompt to bound token spend
    // (mirrors the inscription cap in /api/story).
    const cap = (v: unknown, n: number) =>
      typeof v === "string" ? v.slice(0, n) : undefined;
    const person = {
      ...rawPerson,
      name: cap(rawPerson.name, 200),
      city: cap(rawPerson.city, 120),
      state: cap(rawPerson.state, 120),
    };

    // ── Shared cache: cultural context is keyed by era/location + mode, so it
    // is broadly reusable across users (promptId excluded — it is volatile). ──
    const supabase = await createClient();
    const cacheKey = aiContentCacheKey({ mode, categoryId: categoryId ?? null, person });
    const cached = await getAiContentCache(supabase, "cultural", cacheKey).catch(() => null);
    if (cached) {
      return NextResponse.json({ ...cached, fromCache: true });
    }

    // Cache miss — gate tokens/rate, then generate.
    const admit = await admitAiCall(auth.userId, "cultural");
    if (admit.response) return admit.response;
    if (admit.release) after(admit.release);

    const rl = await requireRateLimit(auth.userId, "cultural");
    if (rl) return rl;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "API key missing." }, { status: 500 });
    }

    const prompt =
      mode === "expand"
        ? expandPrompt(person, categoryId, category!.label)
        : summaryPrompt(person);

    const maxTokens = mode === "expand" ? 1500 : 900;

    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: prompt }],
    });

    const content = message.content[0];
    if (content.type !== "text") throw new Error("Unexpected response type");

    const raw = content.text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    const result = JSON.parse(raw);

    // Persist the generated content for reuse by any future identical request.
    after(() => saveAiContentCache(supabase, "cultural", cacheKey, result).catch(() => {}));

    after(() =>
      logUsage(auth.userId, {
        endpoint: "/api/cultural",
        provider: "anthropic",
        modelId: `anthropic/${MODEL}`,
        model: MODEL,
        requestType: mode,
        inputTokens: message.usage?.input_tokens ?? null,
        outputTokens: message.usage?.output_tokens ?? null,
        promptId: typeof promptId === "string" && promptId ? promptId : crypto.randomUUID(),
        tool: typeof tool === "string" && tool ? tool : "Cultural",
        component:
          typeof component === "string" && component
            ? component
            : mode === "expand"
              ? "Expand Category"
              : "Cultural Summary",
      })
    );

    return NextResponse.json(result);
  } catch (err) {
    console.error("[/api/cultural]", err);
    return NextResponse.json(
      { error: "Cultural context generation failed" },
      { status: 500 }
    );
  }
}
