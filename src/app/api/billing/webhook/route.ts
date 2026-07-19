import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripeCustomer";
import { alreadyProcessed, markProcessed, processEvent } from "@/lib/stripeFulfillment";

/**
 * POST /api/billing/webhook — Stripe webhook receiver (GraveLens-hosted).
 *
 * Verifies the signature against STRIPE_WEBHOOK_SECRET using the RAW body,
 * deduplicates by event id (shared stripe_processed_events table), and applies
 * fulfillment. Register this URL (https://gravelens.com/api/billing/webhook)
 * and its signing secret in the Stripe Dashboard.
 *
 * No auth: Stripe authenticates via the signature, not a session.
 */
export async function POST(req: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[webhook] STRIPE_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "Missing Stripe signature" }, { status: 400 });

  const rawBody = await req.text(); // raw body required for signature verification

  let event;
  try {
    event = await getStripe().webhooks.constructEventAsync(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("[webhook] signature verification failed:", (err as Error).message);
    return NextResponse.json({ error: `Webhook signature error: ${(err as Error).message}` }, { status: 400 });
  }

  const supabase = getServiceClient();
  if (!supabase) {
    console.error("[webhook] service client unavailable");
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  if (await alreadyProcessed(supabase, event.id)) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  let handled: boolean;
  try {
    handled = await processEvent(supabase, event);
  } catch (err) {
    // Don't mark processed — let Stripe retry.
    console.error(`[webhook] handler error for ${event.type}:`, (err as Error).message);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  // Skip marking events we deliberately didn't handle (e.g. gifts), so another
  // endpoint can still process them.
  if (handled) await markProcessed(supabase, event.id, event.type);
  return NextResponse.json({ received: true });
}
