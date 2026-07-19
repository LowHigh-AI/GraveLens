import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { requireAuth } from "@/lib/apiAuth";
import { getServiceClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripeCustomer";
import type { ConfirmationDetail } from "@/lib/lowhighClient";

/**
 * GET /api/billing/confirmation?session_id=cs_... — itemized details for a just
 * completed Checkout, for the /billing/confirmation page.
 *
 * Reads the Stripe Checkout Session directly (authoritative + independent of the
 * async fulfillment webhook), so the confirmation can show exactly what the user
 * bought even before their token balance updates. READ-ONLY: this never credits
 * tokens — fulfillment stays solely in the webhook (stripeFulfillment.ts).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const sessionId = req.nextUrl.searchParams.get("session_id");
  if (!sessionId) {
    return NextResponse.json({ error: "session_id is required" }, { status: 400 });
  }

  let session: Stripe.Checkout.Session;
  try {
    session = await getStripe().checkout.sessions.retrieve(sessionId, {
      expand: ["line_items", "line_items.data.price.product", "payment_intent"],
    });
  } catch (err) {
    console.error("[confirmation] retrieve error:", (err as Error).message);
    // Unknown/garbage session id — don't leak whether it exists.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Ownership gate — the session must belong to the signed-in user. Return 404
  // (not 403) to non-owners so we never confirm a foreign session exists.
  const ownerId = session.client_reference_id || session.metadata?.supabase_user_id || null;
  if (ownerId !== auth.userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const paid = session.payment_status === "paid" || session.payment_status === "no_payment_required";
  const kind: ConfirmationDetail["kind"] =
    session.metadata?.kind === "topup" || session.mode === "payment" ? "topup" : "subscription";

  const lineItems = (session.line_items?.data ?? []).map((li) => {
    const product = (li.price?.product ?? null) as Stripe.Product | null;
    const name =
      (product && typeof product === "object" && "name" in product ? product.name : null) ||
      li.description ||
      "Purchase";
    const description =
      product && typeof product === "object" && "description" in product ? product.description : null;
    return {
      name,
      description: description ?? null,
      quantity: li.quantity ?? 1,
      amountTotal: li.amount_total ?? 0,
    };
  });

  // Tokens: top-ups carry it in metadata; subscriptions derive it from the plan.
  let tokens: number | null = null;
  let planSlug: string | null = null;
  let planName: string | null = null;

  if (kind === "topup") {
    const t = Number(session.metadata?.tokens);
    tokens = Number.isFinite(t) && t > 0 ? t : null;
  } else {
    planSlug = session.metadata?.plan_slug ?? null;
    const supabase = getServiceClient();
    if (supabase && planSlug) {
      const { data } = await supabase
        .from("subscription_plans")
        .select("name, token_allowance")
        .eq("slug", planSlug)
        .maybeSingle();
      const plan = data as { name?: string; token_allowance?: number } | null;
      if (plan) {
        planName = plan.name ?? null;
        tokens = plan.token_allowance != null ? Number(plan.token_allowance) : null;
      }
    }
  }

  const payload: ConfirmationDetail = {
    paid,
    kind,
    currency: session.currency ?? "usd",
    amountTotal: session.amount_total ?? 0,
    lineItems,
    tokens,
    planSlug,
    planName,
  };
  return NextResponse.json(payload);
}
