import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { fetchPlanChangeImpact } from "@/lib/billingData";

/**
 * GET /api/billing/plan-change-impact?target=<slug> — concrete impact of
 * switching plans (token/loyalty/rollover/price deltas + nearest milestone).
 * Ported from LowHigh's plan-change-impact handler. Returns null when the target
 * is unknown or the user has no eligible subscription.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const target = req.nextUrl.searchParams.get("target");
  if (!target) return NextResponse.json({ error: "Missing target plan slug" }, { status: 400 });

  const impact = await fetchPlanChangeImpact(auth.userId, target);
  return NextResponse.json(impact);
}
