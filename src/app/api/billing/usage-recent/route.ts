import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { fetchRecentUsage } from "@/lib/billingData";

/**
 * GET /api/billing/usage-recent?limit=8 — the signed-in user's recent AI spend,
 * one row per user action (grouped by prompt_id from api_usage_log). Powers the
 * "Recent usage" ledger on /rewards.
 *
 * Kept separate from GET /api/billing (the small every-load snapshot) and
 * fetched lazily on first panel open. Service-role read, scoped to the caller.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const raw = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(raw) ? Math.min(50, Math.max(1, Math.trunc(raw))) : 8;

  const actions = await fetchRecentUsage(auth.userId, { limit });
  return NextResponse.json({ actions });
}
