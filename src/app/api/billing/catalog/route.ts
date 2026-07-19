import { NextResponse } from "next/server";
import { fetchCatalog } from "@/lib/billingData";

/**
 * GET /api/billing/catalog — public pricing catalog (active plans, top-up
 * packages, tier discounts). No auth: same as LowHigh's public `plans` endpoint.
 * Shape matches billingService's PlansCatalog.
 */
export async function GET() {
  const catalog = await fetchCatalog();
  return NextResponse.json(catalog, {
    headers: {
      // Public, cross-user pricing that changes rarely — safe to cache at the
      // browser + CDN and serve stale while revalidating.
      "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
