import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { getServiceClient } from "@/lib/supabase/service";
import { recordOpenAndClaimWelcome } from "@/lib/welcomeBonus";

/**
 * POST /api/app-open — record that the signed-in user opened GraveLens and
 * (idempotently) claim the one-time welcome bonus. Self-hosted against the
 * shared Supabase project; ported from LowHigh's api/app-open.js.
 * Body: { appSlug: "gravelens" }
 */
const ALLOWED_APP_SLUGS = new Set(["gravelens"]);

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const appSlug = typeof body?.appSlug === "string" ? body.appSlug.trim() : "";
  if (!ALLOWED_APP_SLUGS.has(appSlug)) {
    return NextResponse.json({ error: "Unknown appSlug" }, { status: 400 });
  }

  const supabase = getServiceClient();
  if (!supabase) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const welcome = await recordOpenAndClaimWelcome(supabase, auth.userId, appSlug);
  return NextResponse.json({ opened: true, welcome });
}
