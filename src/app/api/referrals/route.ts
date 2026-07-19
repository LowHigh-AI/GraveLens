import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { getServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/referrals — the signed-in user's referral code (lazily created) plus
 * their conversion list and counts. Self-hosted against the shared Supabase
 * project (service role), mirroring LowHigh's api/referrals.js — the referral
 * RPCs + referral_rewards table are shared account infrastructure.
 *
 * The shareable URL is built client-side from the GraveLens origin (so a
 * referred visitor lands in GraveLens), so this route returns only the code.
 */
export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const supabase = getServiceClient();
  if (!supabase) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const { data: codeData, error: codeError } = await supabase.rpc("generate_referral_code", {
    p_user_id: auth.userId,
  });
  if (codeError) {
    console.error("[referrals] generate_referral_code failed:", codeError.message);
    return NextResponse.json({ error: "Failed to load referral code" }, { status: 500 });
  }
  const code =
    typeof codeData === "string"
      ? codeData
      : (codeData as { generate_referral_code?: string }[] | null)?.[0]?.generate_referral_code;
  if (!code) return NextResponse.json({ error: "Failed to load referral code" }, { status: 500 });

  const { data: rewards, error: rewardsError } = await supabase
    .from("referral_rewards")
    .select("referred_first_name, tier_level, goal_slug, status, paid_at, attributed_at")
    .eq("referrer_user_id", auth.userId)
    .order("attributed_at", { ascending: false });
  if (rewardsError) console.warn("[referrals] could not load conversions:", rewardsError.message);

  const conversions = (rewards ?? []).map((r) => ({
    firstName: r.referred_first_name as string | null,
    tierLevel: r.tier_level as number | null,
    goalSlug: r.goal_slug as string | null,
    status: r.status as string,
    paidAt: r.paid_at as string | null,
    attributedAt: r.attributed_at as string | null,
  }));

  const stats = conversions.reduce(
    (acc, c) => {
      if (c.status === "paid") acc.paid += 1;
      else if (c.status === "pending") acc.pending += 1;
      return acc;
    },
    { paid: 0, pending: 0 }
  );

  return NextResponse.json({ code, stats, conversions });
}
