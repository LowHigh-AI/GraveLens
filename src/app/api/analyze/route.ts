import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse, after } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { admitAiCall } from "@/lib/tokenGate";
import { logUsage, type UsageEvent } from "@/lib/lowhigh";
import { toNameCase } from "@/lib/nameUtils";
import { requireRateLimit } from "@/lib/rateLimit";
import { validateExtraction, looksMultiPerson } from "@/lib/extractionValidation";

// Two-tier model strategy:
//   Haiku   — fast, cheap (~$0.003/scan). Used on every request.
//   Sonnet  — slower, better (~$0.010/scan). Escalated to when Haiku returns
//             low confidence, fails to parse JSON, or leaves name/dates empty.
const MODEL_HAIKU  = "claude-haiku-4-5-20251001";
const MODEL_SONNET = "claude-sonnet-4-6";
const MAX_TOKENS_HAIKU  = 1024;
const MAX_TOKENS_SONNET = 2048; // extra headroom for multi-person stones + chain-of-thought


function normalizeExtractedNames(obj: Record<string, unknown>): void {
  if (typeof obj.name === "string") obj.name = toNameCase(obj.name);
  if (typeof obj.firstName === "string") obj.firstName = toNameCase(obj.firstName);
  if (typeof obj.lastName === "string") obj.lastName = toNameCase(obj.lastName);
  if (Array.isArray(obj.people)) {
    for (const p of obj.people as Record<string, unknown>[]) {
      if (typeof p.name === "string") p.name = toNameCase(p.name);
      if (typeof p.firstName === "string") p.firstName = toNameCase(p.firstName);
      if (typeof p.lastName === "string") p.lastName = toNameCase(p.lastName);
    }
  }
}

const SYSTEM_PROMPT = `You are an expert at reading historical grave markers, headstones, and cemetery monuments.

Your task is to extract all information from the photograph with maximum accuracy. Work through these steps in order:
1. SCAN the entire stone top-to-bottom, left-to-right — read every word and number before extracting any field.
2. IDENTIFY all people commemorated by finding distinct name+date groupings. Count them before you start filling fields.
3. EXTRACT each field carefully using the rules below.

Common cemetery abbreviations you must recognize:
- d. or ob. or obit = died / obiit (death date marker)
- b. or nat. = born / natus (birth date marker)
- aet. or æt. or aged = age at death
- relict of / relict = widow or widower of (gender signal: female unless otherwise stated)
- consort of = spouse of
- infant = died in infancy (ageAtDeath near 0)
- GAR or G.A.R. = Grand Army of the Republic (Union Civil War veteran)
- IOOF or I.O.O.F. = Independent Order of Odd Fellows (fraternal symbol)
- d.d. = Doctor of Divinity

Family stone rules:
- If multiple people share the same surname on one stone, apply that shared surname to every entry in people[] even when an individual panel shows only a given name (e.g. "FATHER" or "MARY").
- The top-level fields (name, birthYear, etc.) must reflect the FIRST or PRIMARY person listed.

Name rules:
- Maiden names are genealogically critical — preserve them verbatim in "name": "née Schmidt", "nee Schmidt", or the parenthesized convention "Mary (Schmidt) Smith". lastName is the married/primary surname (Smith), never the maiden name.
- Suffixes (Jr., Sr., II, III, IV) stay in "name" but must NOT appear in lastName.
- Titles (Rev., Dr., Capt.) stay in "name" as inscribed but must NOT appear in firstName.

Date inference:
- If only deathYear and ageAtDeath are given, calculate birthYear = deathYear − ageAtDeath.
- If only birthYear and ageAtDeath are given, calculate deathYear = birthYear + ageAtDeath.
- Cross-check: ageAtDeath must equal deathYear − birthYear (±1). When all three are present and they disagree, trust the two explicit years (birthYear and deathYear) and set ageAtDeath = deathYear − birthYear. Only override a year if ageAtDeath is the sole value that can settle the conflict.

Confidence rules — be strict:
- "high": name AND at least one year are legible; cross-checks pass.
- "medium": name is legible but a year or date is uncertain or partially obscured.
- "low": name is unreadable OR both birthYear and deathYear cannot be determined.

Return ONLY valid JSON — no markdown, no explanation, no code fences.`;

const USER_PROMPT = `Analyze this grave marker photograph and extract all information. Return JSON with exactly these fields:

{
  "name": "full name as inscribed (primary or only person)",
  "firstName": "first name only (primary or only person)",
  "lastName": "last name only (primary or only person)",
  "birthDate": "full birth date as inscribed, or empty string (primary or only person)",
  "birthYear": null or integer year (primary or only person),
  "deathDate": "full death date as inscribed, or empty string (primary or only person)",
  "deathYear": null or integer year (primary or only person),
  "ageAtDeath": null or integer (primary or only person; calculate from dates if not explicitly stated),
  "people": [
    {
      "name": "full name as inscribed",
      "firstName": "first name only",
      "lastName": "last name only",
      "birthDate": "full birth date as inscribed, or empty string",
      "birthYear": null or integer year,
      "deathDate": "full death date as inscribed, or empty string",
      "deathYear": null or integer year,
      "ageAtDeath": null or integer
    }
  ],
  "inscription": "complete verbatim transcription of ALL text visible on the marker",
  "epitaph": "any epitaph, verse, or sentiment inscribed (separate from dates/name)",
  "symbols": ["array of described symbols: religious, military, fraternal, decorative"],
  "markerType": "headstone | obelisk | ledger | cross | flat marker | monument | other",
  "material": "granite | marble | limestone | sandstone | concrete | metal | other",
  "condition": "excellent | good | weathered | damaged | illegible",
  "confidence": "high | medium | low"
}

Rules:
- If a field is not visible or determinable, use null for numbers and empty string for strings.
- For symbols, describe each one specifically (e.g., "Masonic square and compass", "lamb — symbol of innocence", "U.S. Army emblem", "IHS Christogram").
- Calculate ageAtDeath if birth and death years are both present.
- If text is partially obscured, include what is legible with [?] for uncertain characters.
- If the marker is in a language other than English, translate all text fields (name, inscription, epitaph) into English. Preserve the original spelling of proper names (e.g. "Johann" stays "Johann"), but translate all non-name text.
- The "people" array must contain one entry per distinct person commemorated on the marker. If only one person is commemorated, "people" contains just that one entry (identical to the top-level fields). Only include a person if they have a distinct name AND at least one date (birth or death). The top-level fields must reflect the primary (or only) person.`;

async function callClaude(
  client: Anthropic,
  model: string,
  imageBase64: string,
  mimeType: string,
  maxTokens: number,
) {
  const message = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
              data: imageBase64,
            },
          },
          { type: "text", text: USER_PROMPT },
        ],
      },
    ],
  });

  const content = message.content[0];
  if (content.type !== "text") throw new Error("Unexpected response type");

  const rawJson = content.text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  // Model occasionally wraps JSON in prose despite instructions — salvage the
  // outermost object before giving up. Returns { parsed, usage } so the caller
  // can log token usage (their token-gate/usage-logging path).
  try {
    return { parsed: JSON.parse(rawJson) as Record<string, unknown>, usage: message.usage };
  } catch (err) {
    const start = rawJson.indexOf("{");
    const end = rawJson.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return { parsed: JSON.parse(rawJson.slice(start, end + 1)) as Record<string, unknown>, usage: message.usage };
    }
    throw err;
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  // Subscription overuse gate (flag-gated) — economic check before abuse check.
  const admit = await admitAiCall(auth.userId, "analyze");
  if (admit.response) return admit.response;
  if (admit.release) after(admit.release);

  const rl = await requireRateLimit(auth.userId, "analyze");
  if (rl) return rl;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Configuration error" },
      { status: 500 }
    );
  }

  // ~8 MB raw image ceiling — base64 expands 3 bytes → 4 chars, so 8 MB ≈ 10.7 M chars.
  // Claude's own limit is 5 MB; this catches malicious oversized payloads before they reach the API.
  const MAX_BASE64_CHARS = 10_700_000;

  try {
    // tool/component name the FRONTEND action (a scan bundles this read with the
    // auto-loaded cultural summary), falling back to this route's own labels.
    const { imageBase64, mimeType, promptId, tool, component } = await req.json();
    if (!imageBase64) {
      return NextResponse.json({ error: "No image provided" }, { status: 400 });
    }
    if (typeof imageBase64 !== "string" || imageBase64.length > MAX_BASE64_CHARS) {
      return NextResponse.json({ error: "Image too large" }, { status: 413 });
    }

    const validMime = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    const finalMime = validMime.includes(mimeType) ? mimeType : "image/jpeg";
    const client = new Anthropic({ apiKey });

    // One usage event per Claude call (Haiku + any Sonnet escalation), grouped
    // under one promptId and logged after the response is flushed. The frontend
    // may pass a promptId to group a multi-call action; otherwise we mint one
    // per request so the Haiku→Sonnet escalation pair groups together.
    const resolvedPromptId =
      typeof promptId === "string" && promptId ? promptId : crypto.randomUUID();
    const usageEvents: UsageEvent[] = [];
    const recordUsage = (
      model: string,
      usage: { input_tokens?: number; output_tokens?: number } | undefined,
    ) =>
      usageEvents.push({
        endpoint: "/api/analyze",
        provider: "anthropic",
        modelId: `anthropic/${model}`,
        model,
        requestType: "analyze",
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
        promptId: resolvedPromptId,
        tool: typeof tool === "string" && tool ? tool : "Scan",
        component: typeof component === "string" && component ? component : "Analyze Marker",
      });

    // ── Tier 1: Haiku ────────────────────────────────────────────────────────
    let extracted: Record<string, unknown> | null = null;
    let usedModel = MODEL_HAIKU;

    try {
      const haiku = await callClaude(client, MODEL_HAIKU, imageBase64, finalMime, MAX_TOKENS_HAIKU);
      extracted = haiku.parsed;
      recordUsage(MODEL_HAIKU, haiku.usage);
    } catch (err) {
      console.warn("[Analyze] Haiku failed, escalating to Sonnet:", err);
    }

    // ── Tier 2: Escalate to Sonnet ───────────────────────────────────────────
    // Triggers on: parse failure, low confidence, missing name, no dates at
    // all, implausible data (swapped/impossible dates, OCR-confusable years),
    // or an inscription that implies more people than people[] contains.
    const haikuIssues = extracted ? validateExtraction(extracted) : [];
    const haikuPeople = Array.isArray(extracted?.people) ? extracted.people.length : 0;
    const missedPeople =
      !!extracted &&
      haikuPeople < 2 &&
      typeof extracted.inscription === "string" &&
      looksMultiPerson(extracted.inscription);

    const YEAR_RANGE_PATTERN = /\b(1[4-9]\d\d|20\d\d)\s*[–—-]\s*(1[4-9]\d\d|20\d\d)\b/g;
    const hasYearInInscription =
      typeof extracted?.inscription === "string" &&
      /\b(1[4-9]\d\d|20\d\d)\b/.test(extracted.inscription);
    const missedDates =
      !!extracted &&
      hasYearInInscription &&
      extracted.birthYear == null &&
      extracted.deathYear == null;

    const hasUnresolvedPeopleDates =
      !!extracted &&
      Array.isArray(extracted.people) &&
      (extracted.people as { birthYear?: unknown; deathYear?: unknown }[]).some((p) => p.birthYear == null && p.deathYear == null) &&
      typeof extracted.inscription === "string" &&
      (extracted.inscription.match(YEAR_RANGE_PATTERN) ?? []).length >= extracted.people.length;

    const needsEscalation =
      !extracted ||
      extracted.confidence === "low" ||
      !extracted.name ||
      (extracted.birthYear == null && extracted.deathYear == null) ||
      haikuIssues.length > 0 ||
      missedPeople ||
      missedDates ||
      hasUnresolvedPeopleDates;

    if (needsEscalation) {
      usedModel = MODEL_SONNET;
      console.log(
        "[Analyze] Escalating to Sonnet — reason:",
        !extracted ? "Haiku failed" :
        extracted.confidence === "low" ? "low confidence" :
        !extracted.name ? "name missing" :
        missedDates ? "years present in inscription but extracted as null" :
        hasUnresolvedPeopleDates ? "unresolved dates for co-buried individuals" :
        (extracted.birthYear == null && extracted.deathYear == null) ? "no dates" :
        haikuIssues.length > 0 ? `implausible data (${haikuIssues[0].problem})` :
        "inscription implies more people than extracted"
      );
      const sonnet = await callClaude(client, MODEL_SONNET, imageBase64, finalMime, MAX_TOKENS_SONNET);
      extracted = sonnet.parsed;
      recordUsage(MODEL_SONNET, sonnet.usage);
      console.log("[Analyze] Sonnet confidence:", extracted?.confidence, "name:", extracted?.name || "(empty)");
    }

    // Implausible data that survives Sonnet gets flagged for human review
    // rather than presented as clean — confidently-wrong is worse than unsure.
    const finalIssues = validateExtraction(extracted!);
    if (finalIssues.length > 0 && extracted!.confidence !== "low") {
      console.warn("[Analyze] Downgrading confidence — implausible extraction:", finalIssues);
      extracted!.confidence = "low";
    }

    extracted!.source = "claude";
    extracted!.analysisModel = usedModel;
    normalizeExtractedNames(extracted!);

    // Best-effort meter to LowHigh after the response is sent.
    after(() => Promise.all(usageEvents.map((ev) => logUsage(auth.userId, ev))));

    return NextResponse.json({ extracted, _model: usedModel });
  } catch (error: unknown) {
    console.error("Claude analysis error:", error);
    const errorStatus = (error as { status?: number })?.status || 500;
    return NextResponse.json(
      { error: "Analysis failed" },
      { status: errorStatus }
    );
  }
}
