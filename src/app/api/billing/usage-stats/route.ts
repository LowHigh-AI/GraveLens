import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchUsageStats } from "@/lib/billingData";

/**
 * GET /api/billing/usage-stats — per-component usage averages (public) plus the
 * caller's current-month token usage when signed in. Ported from LowHigh's
 * api/usage-stats.js. Auth is optional: averages render for prospects too.
 */
export async function GET() {
  let userId: string | null = null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    userId = user?.id ?? null;
  } catch {
    userId = null;
  }

  const stats = await fetchUsageStats(userId);
  return NextResponse.json(stats);
}
