import "server-only";
import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Stripe client + customer resolution for GraveLens (server-only).
 *
 * GraveLens self-hosts the Stripe Billing Portal so "Manage subscription" works
 * without depending on a LowHigh deployment. It uses the SAME Stripe account and
 * the SAME shared Supabase project as LowHigh, so the customer lookup mirrors
 * LowHigh's api/_utils/stripeClient.js `ensureStripeCustomer` exactly — it
 * resolves the identical customer (keyed by metadata.supabase_user_id), never a
 * duplicate.
 */

let _client: Stripe | null = null;

export function getStripe(): Stripe {
  if (_client) return _client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  // Pinned to the version bundled with the installed SDK (stripe@22).
  _client = new Stripe(key, { apiVersion: "2026-06-24.dahlia" });
  return _client;
}

/**
 * Look up (or create) the Stripe customer ID for a Supabase user.
 *   1. Existing id stored on user_subscriptions.stripe_customer_id
 *   2. Stripe customer carrying metadata.supabase_user_id (cross-app idempotency)
 *   3. Otherwise create a new customer tagged with that metadata.
 */
export async function ensureStripeCustomer({
  supabase,
  userId,
  email,
}: {
  supabase: SupabaseClient;
  userId: string;
  email?: string | null;
}): Promise<string> {
  const stripe = getStripe();

  const { data: existing } = await supabase
    .from("user_subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();

  const existingId = (existing as { stripe_customer_id?: string } | null)?.stripe_customer_id;
  if (existingId) return existingId;

  const search = await stripe.customers
    .search({ query: `metadata['supabase_user_id']:'${userId}'`, limit: 1 })
    .catch(() => null);
  if (search?.data?.[0]) return search.data[0].id;

  const customer = await stripe.customers.create({
    email: email || undefined,
    metadata: { supabase_user_id: userId },
  });
  return customer.id;
}

/**
 * Resolve a plan slug + billing period to its Stripe price ID via env vars
 * (shared with LowHigh's pricing):
 *   STRIPE_PRICE_STARTER_MONTHLY / _ANNUAL, _PLUS_, _PREMIUM_
 */
export function getStripePriceIdForPlan(
  planSlug: string,
  billingPeriod: "monthly" | "annual" = "monthly"
): string | null {
  const period = billingPeriod === "annual" ? "ANNUAL" : "MONTHLY";
  const slug = String(planSlug || "").toUpperCase();
  return process.env[`STRIPE_PRICE_${slug}_${period}`] || null;
}
