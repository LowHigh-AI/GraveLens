import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WelcomeResult } from "@/lib/lowhighClient";

/**
 * Welcome-bonus claim for GraveLens (server-only).
 *
 * Ported from LowHigh's api/app-open.js + the relevant slice of
 * api/_utils/goalsEligibility.js. Records the app open (idempotent) and
 * auto-claims the one-time `<appSlug>_welcome` goal via the shared `claim_goal`
 * RPC. Writes go to the shared Supabase project (service role); the RPC enforces
 * one-time uniqueness, so repeated opens never double-grant.
 *
 * Only the requirement types a welcome goal can use are handled (`signup`,
 * `app_opened`); any other type is treated as not-eligible (never granted).
 */

interface GoalRow {
  id: string;
  slug: string;
  token_amount: number;
  frequency: string | null;
  requirement_type: string;
  requirement_params: Record<string, unknown> | null;
}

async function isEligible(supabase: SupabaseClient, userId: string, goal: GoalRow): Promise<boolean> {
  if (goal.requirement_type === "signup") return true;
  // Welcome-style goal: eligible once the named app has been opened. Keyed on
  // requirement_params.app_slug rather than requirement_type, since the goal may
  // carry a placeholder type (e.g. 'coming_soon') to satisfy the shared CHECK.
  const appSlug = goal.requirement_params?.app_slug as string | undefined;
  if (appSlug) {
    const { data, error } = await supabase
      .from("user_app_opens")
      .select("user_id")
      .eq("user_id", userId)
      .eq("app_slug", appSlug)
      .limit(1);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  }
  return false;
}

/** Record the app open (idempotent) and auto-claim the `<appSlug>_welcome` goal. */
export async function recordOpenAndClaimWelcome(
  supabase: SupabaseClient,
  userId: string,
  appSlug: string
): Promise<WelcomeResult> {
  const welcome: WelcomeResult = { claimed: false, tokenReward: 0, newAvailableTokens: null };

  // 1. Record the open (PK (user_id, app_slug) makes this idempotent).
  const { error: openErr } = await supabase
    .from("user_app_opens")
    .upsert(
      { user_id: userId, app_slug: appSlug },
      { onConflict: "user_id,app_slug", ignoreDuplicates: true }
    );
  if (openErr) console.warn("[app-open] failed to record open:", openErr.message);

  // 2. Auto-claim the welcome goal if it exists + the user is eligible.
  // The GraveLens welcome goal is is_active=false (hidden from LowHigh's
  // catalog), so don't filter on is_active here — look it up by slug only.
  const { data: goalRow } = await supabase
    .from("rewards")
    .select("id, slug, token_amount, frequency, requirement_type, requirement_params")
    .eq("slug", `${appSlug}_welcome`)
    .maybeSingle();

  const goal = goalRow as GoalRow | null;
  if (!goal) return welcome;

  welcome.tokenReward = Number(goal.token_amount);
  if (!(await isEligible(supabase, userId, goal))) return welcome;

  const { data, error } = await supabase.rpc("claim_reward", {
    p_user_id: userId,
    p_reward_id: goal.id,
    p_tokens: goal.token_amount,
    p_frequency: goal.frequency,
    p_description: `goal:${goal.slug}`,
  });

  if (error) {
    // 23505 = unique violation = already claimed (normal repeat-open path).
    if (error.code !== "23505") console.error("[app-open] claim_goal failed:", error.message);
    return welcome;
  }

  const row = (Array.isArray(data) ? data[0] : data) as { new_available_tokens?: number } | null;
  welcome.claimed = true;
  welcome.newAvailableTokens = Number(row?.new_available_tokens ?? 0);
  return welcome;
}
