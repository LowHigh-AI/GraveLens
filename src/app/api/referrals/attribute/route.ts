import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { getServiceClient } from "@/lib/supabase/service";

/**
 * POST /api/referrals/attribute — body { code }. Called once after a referred
 * user signs in, when the landing page captured a ?ref=<code>. Resolves the
 * code to a referrer via the shared attribute_referral() RPC (which rejects
 * self-referral and no-ops if already attributed). Mirrors LowHigh's
 * api/referrals-attribute.js. Unknown/self codes return { attributed: false }.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!code) return NextResponse.json({ error: "code is required" }, { status: 400 });

  const supabase = getServiceClient();
  if (!supabase) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const { data: referrerId, error } = await supabase.rpc("attribute_referral", {
    p_referred_user_id: auth.userId,
    p_code: code,
  });

  if (error) {
    console.error("[referrals-attribute] rpc failed:", error.message);
    return NextResponse.json({ error: "Failed to attribute referral" }, { status: 500 });
  }

  return NextResponse.json({ attributed: !!referrerId });
}
