import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { fetchMonthlyUsage } from "@/lib/billingData";

/**
 * GET /api/billing/usage-monthly — the signed-in user's token usage aggregated
 * by calendar month (from api_usage_log), for the Transaction History "Used"
 * view. Usage is not itemized in the ledger, so this is a monthly summary.
 */
export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const months = await fetchMonthlyUsage(auth.userId);
  return NextResponse.json({ months });
}
