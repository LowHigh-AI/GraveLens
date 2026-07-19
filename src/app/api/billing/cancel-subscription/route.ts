import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { getServiceClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripeCustomer";

/**
 * POST /api/billing/cancel-subscription — cancels the subscription at the end of
 * the current period (Stripe `cancel_at_period_end: true`), keeping access until
 * then. Pass { resume: true } to reverse it and keep the subscription active.
 *
 * We update user_subscriptions directly (in addition to Stripe) so the UI
 * reflects the change immediately, without waiting on the webhook round-trip.
 * The webhook's customer.subscription.updated handler re-syncs the same value.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const supabase = getServiceClient();
  if (!supabase) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const resume = body?.resume === true;

  const { data: subRow } = await supabase
    .from("user_subscriptions")
    .select("stripe_subscription_id")
    .eq("user_id", auth.userId)
    .maybeSingle();
  const subId = (subRow as { stripe_subscription_id?: string } | null)?.stripe_subscription_id;
  if (!subId) return NextResponse.json({ error: "No active subscription" }, { status: 400 });

  try {
    const stripe = getStripe();
    const sub = await stripe.subscriptions.update(subId, { cancel_at_period_end: !resume });

    await supabase
      .from("user_subscriptions")
      .update({
        cancel_at_period_end: !resume,
        canceled_at: !resume && sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", auth.userId);

    return NextResponse.json({ ok: true, cancelAtPeriodEnd: !resume });
  } catch (err) {
    console.error("[cancel-subscription] error:", (err as Error).message);
    return NextResponse.json(
      { error: (err as Error).message || "Failed to update the subscription" },
      { status: 500 }
    );
  }
}
