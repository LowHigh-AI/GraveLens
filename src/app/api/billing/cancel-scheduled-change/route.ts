import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { getServiceClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripeCustomer";

/**
 * POST /api/billing/cancel-scheduled-change — releases the subscription schedule
 * so a pending (deferred) downgrade is cancelled and the subscriber stays on
 * their current plan. Releasing keeps the subscription on its current price.
 */
export async function POST() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const supabase = getServiceClient();
  if (!supabase) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const { data: subRow } = await supabase
    .from("user_subscriptions")
    .select("stripe_subscription_id")
    .eq("user_id", auth.userId)
    .maybeSingle();
  const subId = (subRow as { stripe_subscription_id?: string } | null)?.stripe_subscription_id;
  if (!subId) return NextResponse.json({ error: "No active subscription" }, { status: 400 });

  try {
    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(subId);
    if (sub.schedule) {
      const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule.id;
      await stripe.subscriptionSchedules.release(scheduleId);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[cancel-scheduled-change] error:", (err as Error).message);
    return NextResponse.json(
      { error: (err as Error).message || "Failed to cancel the scheduled change" },
      { status: 500 }
    );
  }
}
