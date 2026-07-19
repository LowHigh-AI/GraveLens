import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { getServiceClient } from "@/lib/supabase/service";
import { ensureStripeCustomer, getStripe } from "@/lib/stripeCustomer";

/**
 * POST /api/billing/portal — create a Stripe Billing Portal session for the
 * signed-in user and return its URL. GraveLens self-hosts this (using the shared
 * Stripe account) so "Manage subscription" works without a LowHigh deployment.
 *
 * The return_url is derived server-side from the request origin (never from the
 * client body) to avoid an open redirect through Stripe.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const supabase = getServiceClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  let customerId: string;
  try {
    const { data } = await supabase.auth.admin.getUserById(auth.userId);
    customerId = await ensureStripeCustomer({
      supabase,
      userId: auth.userId,
      email: data.user?.email ?? null,
    });
  } catch (err) {
    console.error("[billing/portal] customer error:", (err as Error).message);
    return NextResponse.json({ error: "Failed to prepare customer record" }, { status: 500 });
  }

  try {
    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${req.nextUrl.origin}/billing`,
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[billing/portal] stripe error:", (err as Error).message);
    return NextResponse.json(
      { error: (err as Error).message || "Failed to create portal session" },
      { status: 500 }
    );
  }
}
