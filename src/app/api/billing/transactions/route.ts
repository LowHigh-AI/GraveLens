import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { fetchTransactionHistory } from "@/lib/billingData";

/**
 * GET /api/billing/transactions?scope=credits|usage|all&before=<ISO> — a page of
 * the signed-in user's token ledger for the Transaction History page.
 *
 * Kept separate from GET /api/billing (which is hit on every app load and must
 * stay a small, fast snapshot). Service-role read, scoped to the caller's id.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const sp = req.nextUrl.searchParams;
  const scopeParam = sp.get("scope");
  const scope: "credits" | "usage" | "all" =
    scopeParam === "usage" || scopeParam === "all" ? scopeParam : "credits";
  const before = sp.get("before");

  const page = await fetchTransactionHistory(auth.userId, { before, scope });
  return NextResponse.json(page);
}
