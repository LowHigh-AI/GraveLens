import "server-only";

import { getServiceClient } from "@/lib/supabase/service";

/**
 * GraveLens AI usage logging (server-side).
 *
 * GraveLens shares LowHigh's Supabase project, billing, and token ledger. Usage
 * is written DIRECTLY to the shared `api_usage_log` table on every AI call — no
 * bridge endpoint, no NEXT_PUBLIC_LOWHIGH_API_BASE round-trip. Cost math mirrors
 * LowHigh's single source of truth (api/_utils/usageTracking.js): price the call
 * from the shared `ai_models` table and store both `estimated_cost` and
 * `lowhigh_tokens` (1,000,000 LowHigh tokens = $1 of underlying API cost).
 *
 * Logging is best-effort and must never affect the user-facing response — call
 * it via `after()` so it runs after the response is flushed, and it swallows all
 * errors (under-billing on a dropped log is acceptable; breaking the request is not).
 */

const APP_SLUG = "gravelens";

export interface UsageEvent {
  /** Route path, e.g. "/api/analyze" */
  endpoint: string;
  /** "anthropic" | "openai" */
  provider: string;
  /** ai_models.id form, e.g. "anthropic/claude-sonnet-4-6" */
  modelId?: string;
  /** Raw model/service name, e.g. "claude-sonnet-4-6" | "tts-1" */
  model: string;
  /** Action discriminator, e.g. "analyze" | "story" | "expand" */
  requestType?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** For flat/char-rate calls (TTS): number of billable units (1 per call). */
  queries?: number | null;
  /** Frontend-generated UUID grouping all AI calls in one user action. */
  promptId?: string | null;
  /** Mid-level grouping, e.g. "Scan", "Story", "Audio". */
  tool?: string | null;
  /** Human-readable UI label, e.g. "Analyze Marker", "Read Aloud". */
  component?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface ModelPricing {
  id: string;
  name: string | null;
  input_cost_per_1m: number | null;
  output_cost_per_1m: number | null;
  cost_per_query: number | null;
}

// Conservative fallback pricing so a model missing from `ai_models` still meters
// (an unpriced model must never bill as free — that's a metering bypass). Tuned
// high on purpose; the real fix is to add the model's price to ai_models.
const FALLBACK_PRICING: ModelPricing = {
  id: "",
  name: null,
  input_cost_per_1m: 5.0,
  output_cost_per_1m: 15.0,
  cost_per_query: 0.05,
};

// ── Pricing cache ─────────────────────────────────────────────────────────────
// Lives for the duration of a warm serverless instance (5-min TTL as safety net).
let _pricingCache: Record<string, ModelPricing> | null = null;
let _pricingCacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

type ServiceClient = NonNullable<ReturnType<typeof getServiceClient>>;

async function getPricing(supabase: ServiceClient): Promise<Record<string, ModelPricing>> {
  const now = Date.now();
  if (_pricingCache && now - _pricingCacheAt < CACHE_TTL_MS) return _pricingCache;

  try {
    const { data, error } = await supabase
      .from("ai_models")
      .select("id, name, input_cost_per_1m, output_cost_per_1m, cost_per_query");

    if (error) {
      console.warn("[lowhigh] Failed to fetch ai_models pricing:", error.message);
      return _pricingCache ?? {};
    }

    const map: Record<string, ModelPricing> = {};
    for (const row of (data ?? []) as ModelPricing[]) {
      // Index by both DB id (e.g. "anthropic/claude-sonnet-4-6") and raw model name.
      map[row.id] = row;
      if (row.name) map[row.name.toLowerCase()] = row;
    }
    _pricingCache = map;
    _pricingCacheAt = now;
    return map;
  } catch (e) {
    console.warn("[lowhigh] Pricing fetch exception:", (e as Error).message);
    return _pricingCache ?? {};
  }
}

// Handles both token-based (AI models) and query-based (TTS, search) pricing.
function calculateCost(
  pricing: ModelPricing | null,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
  queries: number | null | undefined
): number | null {
  if (!pricing) return null;

  // Query-based pricing (flat-rate services, e.g. tts-1 via cost_per_query).
  if (queries != null && pricing.cost_per_query != null) {
    return queries * Number(pricing.cost_per_query);
  }

  // Token-based pricing (AI models).
  const inputCost =
    pricing.input_cost_per_1m != null ? (inputTokens || 0) * (pricing.input_cost_per_1m / 1_000_000) : null;
  const outputCost =
    pricing.output_cost_per_1m != null ? (outputTokens || 0) * (pricing.output_cost_per_1m / 1_000_000) : null;
  if (inputCost == null && outputCost == null) return null;
  return (inputCost || 0) + (outputCost || 0);
}

const numOrNull = (v: number | null | undefined): number | null =>
  v == null || Number.isNaN(Number(v)) ? null : Number(v);

/**
 * Write a GraveLens AI usage event straight to Supabase `api_usage_log`. Pass the
 * authenticated user's id (from requireAuth). Swallows all errors and no-ops if
 * the service client or user id is missing. `app_slug` is always 'gravelens'.
 */
export async function logUsage(userId: string | null, ev: UsageEvent): Promise<void> {
  if (!userId) return;
  const supabase = getServiceClient();
  if (!supabase) {
    console.warn("[lowhigh] getServiceClient() returned null — missing Supabase env vars");
    return;
  }

  try {
    const pricing = await getPricing(supabase);
    const modelPricing = pricing[ev.modelId ?? ""] ?? pricing[ev.model?.toLowerCase() ?? ""] ?? null;
    let estimatedCost = calculateCost(modelPricing, ev.inputTokens, ev.outputTokens, ev.queries);
    // Safety net: if the model isn't priced in ai_models, charge a conservative
    // fallback rather than nothing, so unpriced models can't be used for free.
    if (estimatedCost == null) {
      estimatedCost = calculateCost(FALLBACK_PRICING, ev.inputTokens, ev.outputTokens, ev.queries);
      if (estimatedCost != null) {
        console.warn(`[lowhigh] no ai_models price for "${ev.modelId ?? ev.model}" — charged fallback rate`);
      }
    }
    // 1,000,000 LowHigh tokens = $1 of underlying API cost.
    const lowhighTokens = estimatedCost != null ? Math.round(estimatedCost * 1_000_000) : null;
    // Only set model_id when it exists in ai_models — avoids FK constraint violations.
    const knownModelId = ev.modelId && pricing[ev.modelId] ? ev.modelId : null;

    const { error } = await supabase.from("api_usage_log").insert({
      user_id: userId,
      team_id: null,
      is_team_usage: false,
      app_slug: APP_SLUG,
      endpoint: ev.endpoint ?? null,
      provider: ev.provider ?? null,
      model_id: knownModelId,
      model: ev.model ?? null,
      request_type: ev.requestType ?? null,
      input_tokens: numOrNull(ev.inputTokens),
      output_tokens: numOrNull(ev.outputTokens),
      queries: numOrNull(ev.queries),
      estimated_cost: estimatedCost,
      lowhigh_tokens: lowhighTokens,
      metadata: ev.metadata ?? null,
      prompt_id: ev.promptId ?? null,
      tool: ev.tool ?? null,
      component: ev.component ?? null,
    });
    if (error) console.warn("[lowhigh] usage insert failed:", error.message);

    // Meter: charge the actual cost against the shared token balance so usage
    // reduces available_tokens (GraveLens usage is never team usage). Any
    // admission reservation is refunded separately by the gate's release handle
    // (see admitAiCall), so this always settles the real cost with p_reserved=0.
    const actual = lowhighTokens ?? 0;
    if (actual > 0) {
      const { error: settleErr } = await supabase.rpc("settle_token_usage", {
        p_user_id: userId,
        p_reserved: 0,
        p_actual: actual,
      });
      if (settleErr) console.warn("[lowhigh] settle_token_usage failed:", settleErr.message);
    }
  } catch (e) {
    console.warn("[lowhigh] usage log failed:", (e as Error).message);
  }
}

/**
 * Anthropic SDK usage → { inputTokens, outputTokens }. Tolerant of missing
 * fields (returns nulls) so a logging call never throws on shape drift.
 */
export function readAnthropicUsage(
  message: { usage?: { input_tokens?: number; output_tokens?: number } } | null | undefined
): { inputTokens: number | null; outputTokens: number | null } {
  const u = message?.usage;
  return {
    inputTokens: typeof u?.input_tokens === "number" ? u.input_tokens : null,
    outputTokens: typeof u?.output_tokens === "number" ? u.output_tokens : null,
  };
}
