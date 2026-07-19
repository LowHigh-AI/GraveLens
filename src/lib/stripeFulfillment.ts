import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripeCustomer";

/**
 * Stripe fulfillment for GraveLens's self-hosted billing webhook.
 *
 * Ported from LowHigh's api/billing/stripe-webhook.js. GraveLens only initiates
 * subscription + top-up checkouts, so only those branches (plus subscription
 * lifecycle + invoice renewals) are handled here. GIFTS are intentionally NOT
 * processed — that's a LowHigh-owned feature with email/claim flow GraveLens
 * doesn't have; a gift event is logged and acknowledged, never mis-applied.
 *
 * All writes go through the shared Supabase project (service role) and the same
 * RPCs LowHigh uses, so the token ledger stays single-source. Idempotency is via
 * the shared `stripe_processed_events` table.
 */

type Sb = SupabaseClient;

const tsFromUnix = (unix: number | null | undefined): string | null =>
  typeof unix === "number" ? new Date(unix * 1000).toISOString() : null;

/**
 * Resolve the current period window. Recent Stripe API versions expose
 * current_period_* on the subscription item rather than the subscription, so
 * try the item first and fall back to the top-level fields.
 */
function periodWindow(sub: Stripe.Subscription): { start: string | null; end: string | null } {
  const item = sub.items?.data?.[0] as unknown as {
    current_period_start?: number;
    current_period_end?: number;
  } | undefined;
  const top = sub as unknown as { current_period_start?: number; current_period_end?: number };
  return {
    start: tsFromUnix(item?.current_period_start ?? top.current_period_start),
    end: tsFromUnix(item?.current_period_end ?? top.current_period_end),
  };
}

export async function alreadyProcessed(supabase: Sb, eventId: string): Promise<boolean> {
  const { data } = await supabase
    .from("stripe_processed_events")
    .select("event_id")
    .eq("event_id", eventId)
    .maybeSingle();
  return !!data;
}

export async function markProcessed(supabase: Sb, eventId: string, eventType: string): Promise<void> {
  await supabase.from("stripe_processed_events").insert({ event_id: eventId, event_type: eventType });
}

// The active PRICE id is authoritative and is checked first: after an in-place
// upgrade/downgrade/period-switch through the billing portal, the subscription's
// metadata (plan_slug / billing_period) is left stale from creation time, but
// the line-item price always reflects the CURRENT plan. Matching the price also
// tells us the billing period (which column it lives in). Metadata is only a
// fallback for the rare case where the price columns aren't populated.
async function resolvePlanFromSubscription(
  supabase: Sb,
  sub: Stripe.Subscription
): Promise<{ id: string; billing_period: "monthly" | "annual" } | null> {
  const priceId = sub.items?.data?.[0]?.price?.id;
  if (priceId) {
    const { data: byMonthly } = await supabase
      .from("subscription_plans")
      .select("id, slug, tier_level")
      .eq("stripe_price_id_monthly", priceId)
      .maybeSingle();
    if (byMonthly) return { ...(byMonthly as { id: string }), billing_period: "monthly" };

    const { data: byAnnual } = await supabase
      .from("subscription_plans")
      .select("id, slug, tier_level")
      .eq("stripe_price_id_annual", priceId)
      .maybeSingle();
    if (byAnnual) return { ...(byAnnual as { id: string }), billing_period: "annual" };
  }

  const metaSlug = sub.metadata?.plan_slug;
  if (metaSlug) {
    const { data } = await supabase
      .from("subscription_plans")
      .select("id, slug, tier_level")
      .eq("slug", metaSlug)
      .maybeSingle();
    if (data) {
      const bp = sub.metadata?.billing_period === "annual" ? "annual" : "monthly";
      return { ...(data as { id: string }), billing_period: bp };
    }
  }
  return null;
}

async function upsertSubscription(
  supabase: Sb,
  userId: string,
  sub: Stripe.Subscription,
  { forcePaid = false }: { forcePaid?: boolean } = {}
): Promise<void> {
  const plan = await resolvePlanFromSubscription(supabase, sub);
  if (!plan) {
    console.warn("[webhook] could not resolve plan for stripe sub", sub.id);
    return;
  }

  const statusMap: Record<string, string> = {
    active: "active",
    trialing: "trialing",
    past_due: "past_due",
    unpaid: "unpaid",
    paused: "paused",
    canceled: "canceled",
    incomplete: "past_due",
    incomplete_expired: "canceled",
  };
  const status = statusMap[sub.status] || "past_due";
  const stripeCustomerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null;
  // Prefer the period derived from the active price (authoritative after a
  // portal-driven period switch); fall back to metadata only if unavailable.
  const billingPeriod =
    plan.billing_period || (sub.metadata?.billing_period === "annual" ? "annual" : "monthly");
  const period = periodWindow(sub);

  await supabase.from("user_subscriptions").upsert(
    {
      user_id: userId,
      plan_id: plan.id,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: sub.id,
      status,
      billing_period: billingPeriod,
      current_period_start: period.start,
      current_period_end: period.end,
      trial_end: tsFromUnix(sub.trial_end),
      cancel_at_period_end: !!sub.cancel_at_period_end,
      canceled_at: tsFromUnix(sub.canceled_at),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  const { error: histErr } = await supabase.rpc("record_subscription_state", {
    p_user_id: userId,
    p_plan_id: plan.id,
    p_stripe_subscription_id: sub.id,
    p_status: status,
    p_billing_period: billingPeriod,
    p_force_paid: forcePaid,
  });
  if (histErr) console.warn("[webhook] record_subscription_state failed:", histErr.message);
}

/** Returns false when the event was deliberately not handled (so it is NOT
 * marked processed in the shared dedup table, leaving it for another endpoint). */
async function handleCheckoutCompleted(
  supabase: Sb,
  session: Stripe.Checkout.Session
): Promise<boolean> {
  const userId = session.client_reference_id || session.metadata?.supabase_user_id;
  if (!userId) {
    console.warn("[webhook] checkout.session.completed without user id");
    return true;
  }

  const kind = session.metadata?.kind;

  // GraveLens does not fulfill gifts — leave UNprocessed (don't mark) so a
  // LowHigh-hosted webhook can still handle it; never mis-apply as a topup.
  if (kind === "gift") {
    console.warn("[webhook] gift checkout received; GraveLens does not handle gifts, leaving unprocessed");
    return false;
  }

  if (session.mode === "payment" || kind === "topup") {
    const tokens = parseInt(session.metadata?.tokens || "0", 10);
    const chargeAmountUsd = parseFloat(session.metadata?.charge_amount_usd || "0");
    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? null;
    if (tokens > 0) {
      const { error } = await supabase.rpc("apply_topup", {
        p_user_id: userId,
        p_tokens: tokens,
        p_charge_amount_usd: chargeAmountUsd,
        p_stripe_payment_intent_id: paymentIntentId,
      });
      if (error) {
        console.error("[webhook] apply_topup error:", error.message);
        throw new Error(error.message);
      }
    }
    return true;
  }

  // Subscription branch.
  const subId =
    typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;
  if (!subId) return true;

  const sub = await getStripe().subscriptions.retrieve(subId);
  await upsertSubscription(supabase, userId, sub);
  const period = periodWindow(sub);
  await supabase.rpc("apply_monthly_token_reset", {
    p_user_id: userId,
    p_period_start: period.start,
    p_period_end: period.end,
  });
  return true;
}

async function handleInvoicePaymentSucceeded(supabase: Sb, invoice: Stripe.Invoice): Promise<void> {
  if (
    invoice.billing_reason !== "subscription_cycle" &&
    invoice.billing_reason !== "subscription_create"
  ) {
    return;
  }
  const inv = invoice as unknown as { subscription?: string | { id: string } | null };
  const subId = typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id ?? null;
  if (!subId) return;

  const sub = await getStripe().subscriptions.retrieve(subId);
  const userId = sub.metadata?.supabase_user_id;
  if (!userId) return;

  await upsertSubscription(supabase, userId, sub, { forcePaid: true });
  const period = periodWindow(sub);
  await supabase.rpc("apply_monthly_token_reset", {
    p_user_id: userId,
    p_period_start: period.start,
    p_period_end: period.end,
  });

  if (invoice.billing_reason === "subscription_create") {
    const { error: refErr } = await supabase.rpc("complete_referral", { p_referred_user_id: userId });
    if (refErr) console.warn("[webhook] complete_referral failed:", refErr.message);
  }
}

async function handleSubscriptionUpdated(supabase: Sb, sub: Stripe.Subscription): Promise<void> {
  let userId: string | undefined = sub.metadata?.supabase_user_id;
  if (!userId) {
    const { data } = await supabase
      .from("user_subscriptions")
      .select("user_id")
      .eq("stripe_subscription_id", sub.id)
      .maybeSingle();
    userId = (data as { user_id?: string } | null)?.user_id;
  }
  if (!userId) return;

  await upsertSubscription(supabase, userId, sub);

  // A mid-cycle plan change fires here. On an upgrade, grant the prorated
  // allowance difference for the rest of the current period so the token balance
  // matches what the user now pays. No-op for downgrades, period-only switches,
  // non-plan updates, and repeat deliveries (guarded in the RPC).
  const period = periodWindow(sub);
  const { error: upgErr } = await supabase.rpc("apply_upgrade_proration", {
    p_user_id: userId,
    p_period_start: period.start,
    p_period_end: period.end,
  });
  if (upgErr) console.warn("[webhook] apply_upgrade_proration failed:", upgErr.message);
}

async function handleSubscriptionDeleted(supabase: Sb, sub: Stripe.Subscription): Promise<void> {
  const { data: subRow } = await supabase
    .from("user_subscriptions")
    .select("user_id, plan_id, billing_period")
    .eq("stripe_subscription_id", sub.id)
    .maybeSingle();
  const row = subRow as { user_id?: string; plan_id?: string; billing_period?: string } | null;
  const userId = row?.user_id || sub.metadata?.supabase_user_id;
  if (!userId) return;

  const period = periodWindow(sub);
  await supabase
    .from("user_subscriptions")
    .update({
      status: "canceled",
      cancel_at_period_end: false,
      canceled_at: tsFromUnix(sub.canceled_at) || new Date().toISOString(),
      current_period_end: period.end,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (row?.plan_id) {
    const { error: histErr } = await supabase.rpc("record_subscription_state", {
      p_user_id: userId,
      p_plan_id: row.plan_id,
      p_stripe_subscription_id: sub.id,
      p_status: "canceled",
      p_billing_period: row.billing_period,
      p_force_paid: false,
    });
    if (histErr) console.warn("[webhook] record_subscription_state on cancel failed:", histErr.message);
  }
}

/**
 * Dispatch a verified Stripe event to its handler. Throws on handler failure.
 * Returns false only when the event was deliberately left unprocessed (so the
 * caller skips marking it in the shared dedup table).
 */
export async function processEvent(supabase: Sb, event: Stripe.Event): Promise<boolean> {
  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutCompleted(supabase, event.data.object as Stripe.Checkout.Session);
    case "invoice.payment_succeeded":
      await handleInvoicePaymentSucceeded(supabase, event.data.object as Stripe.Invoice);
      return true;
    case "customer.subscription.created":
    case "customer.subscription.updated":
      await handleSubscriptionUpdated(supabase, event.data.object as Stripe.Subscription);
      return true;
    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(supabase, event.data.object as Stripe.Subscription);
      return true;
    default:
      return true; // Unhandled types are acknowledged + marked.
  }
}
