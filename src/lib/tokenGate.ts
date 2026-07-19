import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase/service";

/**
 * Subscription-based overuse protection for GraveLens AI routes.
 *
 * GraveLens shares LowHigh's token ledger. Before each AI call we check the
 * user's available balance (v_token_balances) directly via the service-role key
 * on the shared project — no cross-origin hop on the critical path. Ported from
 * LowHigh's api/_utils/billingUtils.js `checkTokenGate`: admin bypass, block on
 * missing/empty balance, fail OPEN on any query error (never block on a billing
 * fault).
 *
 * Enforcement is behind a flag so logging (Phase 3) can be validated before the
 * gate goes live. Set GRAVELENS_ENFORCE_TOKEN_GATE="true" to enforce; anything
 * else (incl. unset) runs in observe-only mode (logs would-be blocks, allows).
 */

const ENFORCE = process.env.GRAVELENS_ENFORCE_TOKEN_GATE === "true";

/**
 * Conservative per-route estimates in LowHigh tokens (1,000,000 = $1 of API
 * cost). Used only to block users at/near zero — exact billing happens
 * post-call via the meter. TUNE against real ai_models pricing once known
 * (see Phase 0 query B3 / the gravelens_03_ai_models migration).
 */
export const TOKEN_ESTIMATES = {
  analyze: 50_000, // Sonnet-escalation worst case (image in + 2048 out)
  story: 8_000,
  narrative: 10_000,
  cultural: 12_000, // expand mode is the larger; summary is cheaper
  tts: 65_000, // tts-1 flat, up to 4096 chars
} as const;

export type GateRoute = keyof typeof TOKEN_ESTIMATES;

async function isAdminBypassed(
  supabase: SupabaseClient,
  userId: string
): Promise<boolean> {
  try {
    const { data } = await supabase
      .from("lowhigh_admins")
      .select("user_id")
      .eq("user_id", userId)
      .eq("is_active", true)
      .eq("bypass_billing", true)
      .maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}

interface GateResult {
  allowed: boolean;
  reason?: "no_balance" | "insufficient_tokens";
  availableTokens: number;
  requiredTokens: number;
}

/** Core check. Returns the decision without forming a response. */
export async function checkTokens(userId: string, required: number): Promise<GateResult> {
  const supabase = getServiceClient();
  if (!supabase) return { allowed: true, availableTokens: 0, requiredTokens: required };

  if (await isAdminBypassed(supabase, userId)) {
    return { allowed: true, availableTokens: Infinity, requiredTokens: required };
  }

  try {
    const { data } = await supabase
      .from("v_token_balances")
      .select("available_tokens")
      .eq("user_id", userId)
      .maybeSingle();

    if (!data) {
      return { allowed: false, reason: "no_balance", availableTokens: 0, requiredTokens: required };
    }
    const available = Number((data as { available_tokens?: number }).available_tokens ?? 0);
    if (available < required) {
      return {
        allowed: false,
        reason: available <= 0 ? "no_balance" : "insufficient_tokens",
        availableTokens: available,
        requiredTokens: required,
      };
    }
    return { allowed: true, availableTokens: available, requiredTokens: required };
  } catch {
    // Never block on a billing query failure.
    return { allowed: true, availableTokens: 0, requiredTokens: required };
  }
}

/** Result of admitting an AI call. */
export interface Admission {
  /** A 402 to return immediately (enforcement on + insufficient), or null to proceed. */
  response: NextResponse | null;
  /**
   * When a reservation was actually held, a best-effort refund to schedule via
   * `after(...)`. Always run it — it refunds the reserved estimate after the
   * response; the meter (`logUsage` → settle) separately charges the real cost,
   * so the net effect is: success → charge actual, failure → charge nothing.
   * Null when nothing was reserved (admin, observe-only, no config).
   */
  release: (() => Promise<void>) | null;
}

/**
 * Admit an AI route. When enforcing, ATOMICALLY RESERVES the route estimate
 * (reserve_tokens) — the row-level lock serializes concurrent calls so a burst
 * can't all pass a stale read, closing the check-then-act race. Returns a 402
 * when the balance can't cover the estimate. In observe-only mode it never
 * reserves or blocks (logs the would-be block).
 *
 * Usage in a route (schedule the release right after admitting, so it runs on
 * every exit path — success, early return, or throw):
 *   const admit = await admitAiCall(userId, "narrative");
 *   if (admit.response) return admit.response;
 *   if (admit.release) after(admit.release);
 */
export async function admitAiCall(userId: string, route: GateRoute): Promise<Admission> {
  const required = TOKEN_ESTIMATES[route];
  const supabase = getServiceClient();
  if (!supabase) return { response: null, release: null }; // fail open — no billing config

  if (await isAdminBypassed(supabase, userId)) return { response: null, release: null };

  if (ENFORCE) {
    try {
      const { data, error } = await supabase.rpc("reserve_tokens", { p_user_id: userId, p_amount: required });
      if (error) return { response: null, release: null }; // fail open on a billing fault
      const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; available_after?: number } | null;
      if (row?.ok) {
        return { response: null, release: () => releaseTokens(userId, required) };
      }
      const available = Number(row?.available_after ?? 0);
      return {
        response: NextResponse.json(
          {
            error: "insufficient_tokens",
            reason: available <= 0 ? "no_balance" : "insufficient_tokens",
            availableTokens: available,
            requiredTokens: required,
          },
          { status: 402 }
        ),
        release: null,
      };
    } catch {
      return { response: null, release: null }; // fail open — never block on a billing fault
    }
  }

  // Observe-only: check without reserving, log the would-be block, allow.
  const result = await checkTokens(userId, required);
  if (!result.allowed) {
    console.warn(
      `[tokenGate] (observe-only) would block ${route} for ${userId.slice(0, 8)} — ` +
        `reason=${result.reason} available=${result.availableTokens} required=${required}`
    );
  }
  return { response: null, release: null };
}

/** Refund a held reservation (best-effort). */
async function releaseTokens(userId: string, amount: number): Promise<void> {
  const supabase = getServiceClient();
  if (!supabase) return;
  try {
    await supabase.rpc("release_tokens", { p_user_id: userId, p_amount: amount });
  } catch {
    /* best-effort */
  }
}
