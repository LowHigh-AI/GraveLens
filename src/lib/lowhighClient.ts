/**
 * GraveLens → LowHigh ecosystem bridge (browser-side).
 *
 * Talks to LowHigh's cross-origin APIs with the shared Supabase session as a
 * Bearer token. Used for the welcome reward, balance display, and the billing
 * surface. All calls no-op gracefully if NEXT_PUBLIC_LOWHIGH_API_BASE is unset.
 */

import { createClient } from "@/lib/supabase/browser";

const BASE = (process.env.NEXT_PUBLIC_LOWHIGH_API_BASE || "").replace(/\/$/, "");

export const lowhighConfigured = () => BASE.length > 0;

export async function getAccessToken(): Promise<string | null> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/** fetch() against the LowHigh API base with the user's Bearer token attached. */
export async function lhFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${BASE}${path}`, { ...init, headers });
}

// ── Welcome reward ──────────────────────────────────────────────────────────

export interface WelcomeResult {
  claimed: boolean;
  tokenReward: number;
  newAvailableTokens: number | null;
}

/**
 * Record that this user has opened GraveLens and (idempotently) claim the
 * one-time 100k welcome bonus. Safe to call on every load — the server only
 * grants once. Returns the welcome result, or null if not configured / failed.
 */
export async function recordAppOpen(): Promise<WelcomeResult | null> {
  try {
    // Same-origin GraveLens route — records the open + claims the welcome bonus
    // against the shared Supabase project (service role). Auth via session cookie.
    const res = await fetch("/api/app-open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appSlug: "gravelens" }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.welcome as WelcomeResult) ?? null;
  } catch {
    return null;
  }
}

// ── Billing / balance ───────────────────────────────────────────────────────

export interface TokenBalance {
  allocatedTokens: number;
  purchasedTokens: number;
  rolloverTokens: number;
  usedTokens: number;
  availableTokens: number;
  periodEnd: string | null;
}

export interface SubscriptionSummary {
  planSlug: string;
  planName: string;
  tierLevel: number;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** A deferred downgrade scheduled to take effect at period end, or null. */
  pendingDowngrade: { planName: string | null; effectiveAt: string | null } | null;
  tokenAllowance: number | null;
  rolloverCap: number | null;
  rolloverUncapped: boolean;
  extraTokenPricePerMillionUsd: number | null;
}

/**
 * One row of the shared token ledger (`token_transactions`). `amount` is signed
 * (positive = credit, negative = usage debit). `stripePaymentIntentId` and
 * `chargeAmountUsd` are only present on paid rows (top_up / gift).
 */
export interface TokenTransaction {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number | null;
  description: string | null;
  created_at: string;
  stripePaymentIntentId: string | null;
  chargeAmountUsd: number | null;
}

export interface BillingData {
  subscription: SubscriptionSummary | null;
  tokenBalance: TokenBalance | null;
  recentTransactions?: TokenTransaction[];
}

/** A page of transaction history. `nextCursor` is null when the ledger is exhausted. */
export interface TransactionHistoryPage {
  items: TokenTransaction[];
  nextCursor: string | null;
}

/**
 * Token usage aggregated by calendar month (from api_usage_log — usage is not
 * itemized in the ledger). `expiredTokens` is the amount that did not carry over
 * at that month's reset; null when unknown (only recorded going forward).
 */
export interface MonthlyUsage {
  month: string; // ISO timestamp of the month start
  usedTokens: number;
  expiredTokens: number | null;
  callCount: number;
}

/**
 * One recent AI action's token spend, grouped from `api_usage_log` by
 * `prompt_id` (one user action = one row; a single action may span several API
 * calls). Unlike credits, usage carries no stored `balance_after`, so this is a
 * standalone spend record, not a running-balance ledger.
 */
export interface UsageAction {
  promptId: string;
  started: string; // ISO timestamp — earliest call in the action
  actionTokens: number; // summed LowHigh-token cost
  callCount: number;
  tool: string | null;
  components: string[]; // distinct human UI labels touched by the action
}

/**
 * Itemized purchase details for the confirmation page, derived server-side from
 * the Stripe Checkout Session (authoritative + race-free vs. webhook credit).
 * The resulting token balance is NOT here — it comes from the eventually
 * consistent ledger via `eco.billing.tokenBalance` after polling.
 */
export interface ConfirmationDetail {
  paid: boolean;
  kind: "topup" | "subscription";
  currency: string;
  /** Total charged, in the currency's minor unit (cents). */
  amountTotal: number;
  lineItems: Array<{
    name: string;
    description: string | null;
    quantity: number;
    amountTotal: number;
  }>;
  tokens: number | null;
  planSlug: string | null;
  planName: string | null;
}

/**
 * Fetch the user's subscription + token balance.
 *
 * Read from GraveLens's OWN same-origin route (`/api/billing`), which queries
 * the shared Supabase project server-side with the service-role key. This
 * avoids the cross-origin LowHigh dependency (those endpoints aren't deployed at
 * lowhigh.ai). Auth rides the same-origin session cookie — no Bearer needed.
 */
export async function fetchBilling(): Promise<BillingData | null> {
  try {
    const res = await fetch("/api/billing", { method: "GET" });
    if (!res.ok) return null;
    return (await res.json()) as BillingData;
  } catch {
    return null;
  }
}

/** Format a LowHigh-token count for compact display (e.g. 1.2M, 340k). */
export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (!isFinite(n)) return "∞";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${Math.round(n)}`;
}

/**
 * Format a LowHigh-token count at full precision with grouped thousands
 * (e.g. 1,247,300). Same guards as `formatTokens`; used where the user needs to
 * see their exact balance rather than a compact approximation.
 */
export function formatTokensExact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (!isFinite(n)) return "∞";
  return Math.round(n).toLocaleString("en-US");
}
