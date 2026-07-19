import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuth } from "@/lib/apiAuth";
import { getServiceClient } from "@/lib/supabase/service";
import { ensureStripeCustomer, getStripe } from "@/lib/stripeCustomer";

/**
 * POST /api/billing/topup-checkout — one-time token top-up Checkout Session.
 * Ported from LowHigh's create-topup-checkout.js; fulfillment (apply_topup)
 * happens in /api/billing/webhook. Body: { packageId } or { tokens }.
 */

const MIN_PAYG_TOKENS = 100_000;
const MAX_PAYG_TOKENS = 100_000_000;
const DEFAULT_PRICE_PER_M_USD = 10.0;

/** Price per million tokens for this user, from their active plan's tier rate. */
async function resolvePricePerMillion(supabase: SupabaseClient, userId: string): Promise<number> {
  const { data } = await supabase
    .from("user_subscriptions")
    .select("status, subscription_plans(extra_token_price_per_million_usd)")
    .eq("user_id", userId)
    .maybeSingle();

  const row = data as
    | { status?: string; subscription_plans?: { extra_token_price_per_million_usd?: number } }
    | null;
  if (!row || !["active", "trialing", "lifetime"].includes(row.status ?? "")) {
    return DEFAULT_PRICE_PER_M_USD;
  }
  const rate = row.subscription_plans?.extra_token_price_per_million_usd;
  return rate != null ? Number(rate) : DEFAULT_PRICE_PER_M_USD;
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const supabase = getServiceClient();
  if (!supabase) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const { packageId, tokens: paygTokens } = body ?? {};

  let tokens: number;
  let displayName: string;

  if (packageId) {
    const { data: pkg } = await supabase
      .from("token_top_up_packages")
      .select("token_amount, name, is_active")
      .eq("id", packageId)
      .maybeSingle();
    const p = pkg as { token_amount?: number; name?: string; is_active?: boolean } | null;
    if (!p || !p.is_active) {
      return NextResponse.json({ error: "Topup package not available" }, { status: 404 });
    }
    tokens = Number(p.token_amount);
    displayName = p.name ?? "Tokens";
  } else if (paygTokens != null) {
    tokens = Math.floor(Number(paygTokens));
    if (!Number.isFinite(tokens) || tokens < MIN_PAYG_TOKENS || tokens > MAX_PAYG_TOKENS) {
      return NextResponse.json(
        {
          error: `tokens must be between ${MIN_PAYG_TOKENS.toLocaleString()} and ${MAX_PAYG_TOKENS.toLocaleString()}`,
        },
        { status: 400 }
      );
    }
    displayName = `${(tokens / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}M Tokens`;
  } else {
    return NextResponse.json({ error: "Either packageId or tokens is required" }, { status: 400 });
  }

  const pricePerMillion = await resolvePricePerMillion(supabase, auth.userId);
  const priceUsd = (tokens / 1_000_000) * pricePerMillion;
  const priceCents = Math.max(50, Math.round(priceUsd * 100)); // Stripe min charge = 50c

  let stripeCustomerId: string;
  try {
    const { data } = await supabase.auth.admin.getUserById(auth.userId);
    stripeCustomerId = await ensureStripeCustomer({
      supabase,
      userId: auth.userId,
      email: data.user?.email ?? null,
    });
  } catch (err) {
    console.error("[topup-checkout] customer error:", (err as Error).message);
    return NextResponse.json({ error: "Failed to prepare customer record" }, { status: 500 });
  }

  const origin = req.nextUrl.origin;
  const meta = {
    supabase_user_id: auth.userId,
    kind: "topup",
    tokens: String(tokens),
    charge_amount_usd: priceUsd.toFixed(4),
  };

  try {
    const session = await getStripe().checkout.sessions.create({
      mode: "payment",
      customer: stripeCustomerId,
      client_reference_id: auth.userId,
      // One-time purchases don't invoice by default; enable it so top-ups produce
      // a proper Stripe receipt/invoice (subscriptions already invoice).
      invoice_creation: { enabled: true },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: priceCents,
            product_data: {
              name: `LowHigh Tokens — ${displayName}`,
              description: `${tokens.toLocaleString()} LowHigh tokens added to your balance.`,
              metadata: { kind: "topup", tokens: String(tokens) },
            },
          },
        },
      ],
      payment_intent_data: { metadata: meta },
      // {CHECKOUT_SESSION_ID} is a Stripe template literal it substitutes on
      // redirect; the confirmation page looks the session up to show details.
      success_url: `${origin}/billing/confirmation?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/billing?status=canceled`,
      metadata: meta,
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[topup-checkout] stripe error:", (err as Error).message);
    return NextResponse.json(
      { error: (err as Error).message || "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
