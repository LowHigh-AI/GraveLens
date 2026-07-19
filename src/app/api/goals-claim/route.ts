import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { getServiceClient } from "@/lib/supabase/service";
import { claimGraveLensGoal } from "@/lib/goalsServer";

/**
 * POST /api/goals-claim — body { slug }. Claims one GraveLens-visible goal via
 * the shared claim_goal() RPC after verifying eligibility server-side.
 * Idempotent: a re-claim of a one-time goal returns an "Already claimed" error.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
  if (!slug) return NextResponse.json({ ok: false, error: "slug is required" }, { status: 400 });

  const supabase = getServiceClient();
  if (!supabase) return NextResponse.json({ ok: false, error: "Server not configured" }, { status: 500 });

  const result = await claimGraveLensGoal(supabase, auth.userId, slug);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
