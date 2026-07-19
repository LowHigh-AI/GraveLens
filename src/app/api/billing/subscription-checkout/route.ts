import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { getServiceClient } from "@/lib/supabase/service";
import { ensureStripeCustomer, getStripe, getStripePriceIdForPlan } from "@/lib/stripeCustomer";

/**
 * POST /api/billing/subscription-checkout — create a Stripe subscription
 * Checkout Session for the signed-in user. Ported from LowHigh's
 * create-subscription-checkout.js; fulfillment happens in /api/billing/webhook.
 * Success/cancel URLs are derived server-side (GraveLens /billing).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const supabase = getServiceClient();
  if (!supabase) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const planSlug = body?.planSlug;
  if (!planSlug || !["starter", "plus", "premium"].includes(planSlug)) {
    return NextResponse.json(
      { error: "planSlug must be one of: starter, plus, premium" },
      { status: 400 }
    );
  }
  const billingPeriod: "monthly" | "annual" = body?.billingPeriod === "annual" ? "annual" : "monthly";

  const stripePriceId = getStripePriceIdForPlan(planSlug, billingPeriod);
  if (!stripePriceId) {
    const envSuffix = billingPeriod === "annual" ? "ANNUAL" : "MONTHLY";
    return NextResponse.json(
      {
        error: `Stripe price for plan "${planSlug}" (${billingPeriod}) is not configured (set STRIPE_PRICE_${planSlug.toUpperCase()}_${envSuffix}).`,
        code: "PAYMENT_NOT_CONFIGURED",
      },
      { status: 501 }
    );
  }

  const { data: planRow } = await supabase
    .from("subscription_plans")
    .select("id, slug, is_active")
    .eq("slug", planSlug)
    .maybeSingle();
  if (!planRow || !(planRow as { is_active?: boolean }).is_active) {
    return NextResponse.json({ error: "Plan not available" }, { status: 404 });
  }

  let stripeCustomerId: string;
  try {
    const { data } = await supabase.auth.admin.getUserById(auth.userId);
    stripeCustomerId = await ensureStripeCustomer({
      supabase,
      userId: auth.userId,
      email: data.user?.email ?? null,
    });
  } catch (err) {
    console.error("[subscription-checkout] customer error:", (err as Error).message);
    return NextResponse.json({ error: "Failed to prepare customer record" }, { status: 500 });
  }

  const origin = req.nextUrl.origin;
  const metadata = {
    supabase_user_id: auth.userId,
    plan_slug: planSlug,
    billing_period: billingPeriod,
  };

  // If the user already has a live subscription, a plan change (upgrade,
  // downgrade, or monthly↔annual switch) must MODIFY that subscription so Stripe
  // prorates the difference — NOT open a second mode:'subscription' Checkout,
  // which charges the new plan's full price and leaves the old subscription
  // running (double-billing). Route existing subscribers through the Billing
  // Portal's subscription_update_confirm flow so they see the exact prorated
  // amount and confirm before we charge. The webhook's
  // customer.subscription.updated handler resyncs the plan in Supabase.
  const stripe = getStripe();
  let existingSub: Awaited<ReturnType<typeof stripe.subscriptions.list>>["data"][number] | null = null;
  try {
    const subs = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: "all",
      limit: 10,
    });
    existingSub =
      subs.data.find((s) => ["active", "trialing", "past_due"].includes(s.status)) ?? null;
  } catch (err) {
    console.error("[subscription-checkout] list subs error:", (err as Error).message);
  }

  if (existingSub) {
    const item = existingSub.items?.data?.[0];
    if (!item) {
      return NextResponse.json(
        { error: "Your subscription is missing a billable item. Please contact support." },
        { status: 500 }
      );
    }
    if (item.price?.id === stripePriceId) {
      return NextResponse.json({ error: "You're already on this plan." }, { status: 400 });
    }

    // Determine upgrade vs downgrade by tier. Downgrades are DEFERRED to the end
    // of the current billing period via a Stripe subscription schedule (no
    // immediate proration or credit). Upgrades (and same-tier interval changes)
    // apply immediately via the portal confirm flow. Stripe's portal cannot
    // itself defer cross-product (cross-tier) downgrades, so we schedule them.
    let currentTier = NaN;
    if (item.price?.id) {
      const { data: cp } = await supabase
        .from("subscription_plans")
        .select("tier_level")
        .or(`stripe_price_id_monthly.eq.${item.price.id},stripe_price_id_annual.eq.${item.price.id}`)
        .maybeSingle();
      currentTier = Number((cp as { tier_level?: number } | null)?.tier_level ?? NaN);
    }
    const { data: tp } = await supabase
      .from("subscription_plans")
      .select("tier_level, name")
      .eq("slug", planSlug)
      .maybeSingle();
    const targetTier = Number((tp as { tier_level?: number } | null)?.tier_level ?? NaN);
    const isDowngrade =
      Number.isFinite(currentTier) && Number.isFinite(targetTier) && targetTier < currentTier;

    const existingScheduleId =
      typeof existingSub.schedule === "string"
        ? existingSub.schedule
        : (existingSub.schedule as { id?: string } | null)?.id ?? null;

    if (isDowngrade) {
      try {
        // Release any schedule already attached (e.g. a prior pending downgrade)
        // so we can build a clean schedule reflecting the latest choice.
        if (existingScheduleId) {
          await stripe.subscriptionSchedules.release(existingScheduleId);
        }
        // Phase 1 keeps the current plan until period end; phase 2 switches to the
        // target plan. proration_behavior "none" means no immediate charge or
        // credit. The webhook resolves the plan from the active price, so the
        // change registers automatically when phase 2 begins.
        const schedule = await stripe.subscriptionSchedules.create({
          from_subscription: existingSub.id,
        });
        const currentPhase = schedule.phases[0];
        const phaseCurrentPrice =
          typeof currentPhase.items[0].price === "string"
            ? currentPhase.items[0].price
            : currentPhase.items[0].price?.id;
        const updated = await stripe.subscriptionSchedules.update(schedule.id, {
          end_behavior: "release",
          proration_behavior: "none",
          phases: [
            {
              items: [{ price: phaseCurrentPrice as string, quantity: 1 }],
              start_date: currentPhase.start_date,
              end_date: currentPhase.end_date,
            },
            {
              items: [{ price: stripePriceId, quantity: 1 }],
            },
          ],
        });
        const effective = updated.phases[0].end_date;
        return NextResponse.json({
          scheduled: true,
          effectiveAt: effective ? new Date(effective * 1000).toISOString() : null,
          planName: (tp as { name?: string } | null)?.name ?? null,
        });
      } catch (err) {
        console.error("[subscription-checkout] schedule downgrade error:", (err as Error).message);
        return NextResponse.json(
          { error: (err as Error).message || "Failed to schedule the plan change" },
          { status: 500 }
        );
      }
    }

    // Upgrade or same-tier interval change: apply immediately via the portal
    // confirm flow. Release any pending downgrade schedule first so the attached
    // schedule doesn't block the immediate update.
    if (existingScheduleId) {
      try {
        await stripe.subscriptionSchedules.release(existingScheduleId);
      } catch (err) {
        console.error("[subscription-checkout] schedule release error:", (err as Error).message);
      }
    }
    // Return to /plan with the new plan name so the page can confirm the
    // upgrade with a toast (subscribers belong on /plan, not the prospect page).
    const upgradedName = (tp as { name?: string } | null)?.name ?? planSlug;
    const returnUrl = `${origin}/plan?upgraded=${encodeURIComponent(upgradedName)}`;
    try {
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: returnUrl,
        flow_data: {
          type: "subscription_update_confirm",
          subscription_update_confirm: {
            subscription: existingSub.id,
            items: [{ id: item.id, price: stripePriceId, quantity: 1 }],
          },
          after_completion: {
            type: "redirect",
            redirect: { return_url: returnUrl },
          },
        },
      });
      return NextResponse.json({ url: portalSession.url });
    } catch (err) {
      console.error("[subscription-checkout] portal update error:", (err as Error).message);
      return NextResponse.json(
        { error: (err as Error).message || "Failed to start plan change" },
        { status: 500 }
      );
    }
  }

  try {
    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      client_reference_id: auth.userId,
      line_items: [{ price: stripePriceId, quantity: 1 }],
      allow_promotion_codes: true,
      // {CHECKOUT_SESSION_ID} is a Stripe template literal it substitutes on
      // redirect; the confirmation page looks the session up to show details.
      success_url: `${origin}/billing/confirmation?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/billing?status=canceled`,
      subscription_data: { metadata },
      metadata: { ...metadata, kind: "subscription" },
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[subscription-checkout] stripe error:", (err as Error).message);
    return NextResponse.json(
      { error: (err as Error).message || "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
