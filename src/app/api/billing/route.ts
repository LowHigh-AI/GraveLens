import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { fetchBillingForUser } from "@/lib/billingData";

/**
 * GET /api/billing — the signed-in user's subscription, token balance, and
 * recent transactions, read directly from the shared Supabase project (no
 * cross-origin LowHigh hop). Shape matches lowhighClient's BillingData.
 */
export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const billing = await fetchBillingForUser(auth.userId);
  return NextResponse.json(billing);
}
