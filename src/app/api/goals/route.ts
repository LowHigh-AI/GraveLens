import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { getServiceClient } from "@/lib/supabase/service";
import { fetchGraveLensGoals } from "@/lib/goalsServer";

/**
 * GET /api/goals — the signed-in user's GraveLens-visible rewards/goals with
 * per-user status, read from the SHARED goals table (filtered to
 * visible_in_apps @> '{gravelens}'). Eligible automatic goals (the welcome
 * bonus) auto-claim inline. Source of truth for the Balance & Rewards page.
 */
export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const supabase = getServiceClient();
  if (!supabase) {
    console.error("[goals] service client not configured (missing env)");
    return NextResponse.json({ goals: [] });
  }

  try {
    const goals = await fetchGraveLensGoals(supabase, auth.userId);
    return NextResponse.json({ goals });
  } catch (err) {
    console.error("[goals] fetchGraveLensGoals threw", err);
    return NextResponse.json({ goals: [], error: "goals_failed" }, { status: 500 });
  }
}

