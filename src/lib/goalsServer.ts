import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getRank } from "@/lib/achievements";
import type { GoalStatus, GraveLensGoal } from "@/lib/goalsTypes";

/**
 * GraveLens reads/claims the SHARED rewards system (server-only).
 *
 * The `goals` table, `user_goal_completions`, and `claim_goal()` already exist
 * in production (they power LowHigh's Balance & Rewards). GraveLens reads the
 * subset flagged `visible_in_apps @> '{gravelens}'` with the service role and
 * claims via the same `claim_goal()` RPC — nothing is recreated. Ported from the
 * GraveLens-relevant slice of LowHigh's api/goals.js + api/_utils/goalsEligibility.js.
 */

interface GoalRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  token_amount: number;
  frequency: string;
  redemption: string;
  requirement_type: string;
  requirement_params: Record<string, unknown> | null;
  sort_order: number;
}

/** Per-request context the eligibility checks read from (fetched once). */
interface EligibilityCtx {
  earnedRank: number;
  tierLevel: number;
  tierActive: boolean;
  openedGraveLens: boolean;
}

const isRankSlug = (slug: string) => slug.startsWith("gravelens_rank_");
const minRankOf = (g: GoalRow): number | null => {
  const n = Number(g.requirement_params?.min_rank);
  return Number.isFinite(n) && n > 0 ? n : null;
};

async function loadContext(supabase: SupabaseClient, userId: string): Promise<EligibilityCtx> {
  const [profileRes, subRes, openRes] = await Promise.allSettled([
    supabase.from("gravelens_user_profiles").select("explorer_xp").eq("user_id", userId).maybeSingle(),
    supabase
      .from("user_subscriptions")
      .select("status, subscription_plans(tier_level)")
      .eq("user_id", userId)
      .maybeSingle(),
    supabase
      .from("user_app_opens")
      .select("user_id")
      .eq("user_id", userId)
      .eq("app_slug", "gravelens")
      .limit(1),
  ]);

  const xp = Number(
    (profileRes.status === "fulfilled" ? (profileRes.value.data as { explorer_xp?: number } | null) : null)
      ?.explorer_xp ?? 0
  );
  const subRow =
    subRes.status === "fulfilled"
      ? (subRes.value.data as { status?: string; subscription_plans?: { tier_level?: number } } | null)
      : null;
  const openRows = openRes.status === "fulfilled" ? (openRes.value.data as unknown[] | null) : null;

  return {
    earnedRank: getRank(xp).level,
    tierLevel: Number(subRow?.subscription_plans?.tier_level ?? 0),
    tierActive: ["active", "trialing", "lifetime"].includes(subRow?.status ?? ""),
    openedGraveLens: Array.isArray(openRows) && openRows.length > 0,
  };
}

/** Whether the user currently meets a goal's requirement (GraveLens slice). */
function isEligible(goal: GoalRow, ctx: EligibilityCtx): boolean {
  if (isRankSlug(goal.slug)) {
    const min = minRankOf(goal);
    return min != null && ctx.earnedRank >= min;
  }
  if (goal.slug === "gravelens_welcome") return ctx.openedGraveLens;

  switch (goal.requirement_type) {
    case "signup":
      return true;
    case "subscribe_tier_min": {
      const minTier = Number(goal.requirement_params?.min_tier_level ?? 1);
      return ctx.tierActive && ctx.tierLevel >= minTier;
    }
    case "app_opened":
      return ctx.openedGraveLens;
    // referral_conversion is system-credited (complete_referral); never user-claimable.
    default:
      return false;
  }
}

async function callClaimGoal(
  supabase: SupabaseClient,
  userId: string,
  goal: GoalRow
): Promise<number | null> {
  const { data, error } = await supabase.rpc("claim_reward", {
    p_user_id: userId,
    p_reward_id: goal.id,
    p_tokens: goal.token_amount,
    p_frequency: goal.frequency,
    p_description: goal.title,
  });
  if (error) {
    if (error.code !== "23505") console.error("[goals] claim_goal failed for", goal.slug, error.message);
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as { new_available_tokens?: number } | null;
  return Number(row?.new_available_tokens ?? 0);
}

/** The full GraveLens goal list with per-user status (auto-claims eligible automatic goals). */
export async function fetchGraveLensGoals(
  supabase: SupabaseClient,
  userId: string
): Promise<GraveLensGoal[]> {
  const { data: goalRows, error: goalsError } = await supabase
    .from("rewards")
    .select(
      "id, slug, title, description, category, token_amount, frequency, redemption, requirement_type, requirement_params, sort_order"
    )
    .contains("visible_in_apps", ["gravelens"])
    .order("sort_order", { ascending: true });

  if (goalsError) {
    // Surface the real cause (e.g. missing visible_in_apps column / wrong DB)
    // instead of silently returning an empty rewards list.
    console.error("[goals] goals query failed", {
      message: goalsError.message,
      code: goalsError.code,
      details: goalsError.details,
      hint: goalsError.hint,
    });
  }

  const goals = (goalRows as GoalRow[] | null) ?? [];
  if (goals.length === 0) return [];

  const { data: completionRows, error: completionsError } = await supabase
    .from("reward_claims")
    .select("reward_id, claimed_at")
    .eq("user_id", userId);
  if (completionsError) {
    console.warn("[goals] completions query failed", completionsError.message);
  }
  const claimedAt = new Map<string, string>();
  for (const c of (completionRows as { reward_id: string; claimed_at: string }[] | null) ?? []) {
    // one_time goals have at most one row; keep it.
    if (!claimedAt.has(c.reward_id)) claimedAt.set(c.reward_id, c.claimed_at);
  }

  const ctx = await loadContext(supabase, userId);
  const out: GraveLensGoal[] = [];

  for (const goal of goals) {
    let status: GoalStatus;
    let claimed: string | null = claimedAt.get(goal.id) ?? null;

    if (claimed) {
      status = "claimed";
    } else if (goal.requirement_type === "referral_conversion") {
      status = "coming_soon"; // system-credited; shown as in-progress
    } else if (isEligible(goal, ctx)) {
      if (goal.redemption === "automatic") {
        // Auto-claim now (e.g. the welcome bonus); idempotent via the unique index.
        const credited = await callClaimGoal(supabase, userId, goal);
        if (credited != null) {
          status = "claimed";
          claimed = new Date().toISOString();
        } else {
          status = "claimable"; // claim raced/failed — let the user retry
        }
      } else {
        status = "claimable";
      }
    } else {
      status = "locked";
    }

    out.push({
      slug: goal.slug,
      title: goal.title,
      description: goal.description,
      category: goal.category,
      tokenReward: Number(goal.token_amount),
      frequency: goal.frequency,
      redemption: goal.redemption,
      requirementType: goal.requirement_type,
      status,
      claimedAt: claimed,
      minRank: minRankOf(goal),
    });
  }

  return out;
}

export interface ClaimResult {
  ok: boolean;
  error?: string;
  newAvailableTokens?: number;
  claimed?: { slug: string; tokenReward: number; claimedAt: string };
}

/** Claim a single GraveLens-visible goal by slug after verifying eligibility. */
export async function claimGraveLensGoal(
  supabase: SupabaseClient,
  userId: string,
  slug: string
): Promise<ClaimResult> {
  const { data: goalRow } = await supabase
    .from("rewards")
    .select(
      "id, slug, title, description, category, token_amount, frequency, redemption, requirement_type, requirement_params, sort_order"
    )
    .eq("slug", slug)
    .contains("visible_in_apps", ["gravelens"])
    .maybeSingle();

  const goal = goalRow as GoalRow | null;
  if (!goal) return { ok: false, error: "Goal not found" };
  if (goal.requirement_type === "referral_conversion") {
    return { ok: false, error: "This reward is credited automatically." };
  }

  const ctx = await loadContext(supabase, userId);
  if (!isEligible(goal, ctx)) return { ok: false, error: "You have not met this goal yet." };

  const { data, error } = await supabase.rpc("claim_reward", {
    p_user_id: userId,
    p_reward_id: goal.id,
    p_tokens: goal.token_amount,
    p_frequency: goal.frequency,
    p_description: goal.title,
  });

  if (error) {
    if (error.code === "23505") return { ok: false, error: "Already claimed." };
    console.error("[goals] claim failed for", slug, error.message);
    return { ok: false, error: "Failed to claim." };
  }

  const row = (Array.isArray(data) ? data[0] : data) as { new_available_tokens?: number } | null;
  return {
    ok: true,
    newAvailableTokens: Number(row?.new_available_tokens ?? 0),
    claimed: {
      slug: goal.slug,
      tokenReward: Number(goal.token_amount),
      claimedAt: new Date().toISOString(),
    },
  };
}
