import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { fetchPlanRecommendation } from "@/lib/billingData";

/**
 * GET /api/billing/plan-recommendation — tier-driven upsell payload for the
 * Change Plan page. Ported from LowHigh's plan-recommendation handler; reads the
 * shared Supabase with the service-role key. Returns null for admin/free users
 * (the page hides the recommendation module).
 */
export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const recommendation = await fetchPlanRecommendation(auth.userId);
  return NextResponse.json(recommendation);
}
