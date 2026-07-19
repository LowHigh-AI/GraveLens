/**
 * GraveLens billing service (client-side).
 *
 * Talks to GraveLens's OWN same-origin billing routes (`/api/billing/*`), which
 * read the shared Supabase project and drive Stripe with the shared account.
 * GraveLens still holds ZERO pricing data — the catalog is fetched at runtime.
 * We only render and redirect; checkout return URLs are derived server-side.
 */

import type { PlanRecommendation, PlanChangeImpact, UsageAverage } from "@/lib/billingTypes";
import type { ConfirmationDetail, TransactionHistoryPage, MonthlyUsage, UsageAction } from "@/lib/lowhighClient";

// Catalog shapes mirror LowHigh's src/types/billing.ts (kept loose on purpose).
export interface SubscriptionPlanOption {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  tierLevel: number;
  priceMonthly: number | null;
  priceAnnual: number | null;
  priceAnnualTotal: number | null;
  tokenAllowance: number;
  rolloverCap: number | null;
  rolloverUncapped: boolean;
  extraTokenPricePerMillionUsd: number | null;
  features: string[];
  sortOrder: number;
}

export interface TopUpPackage {
  id: string;
  name: string;
  tokenAmount: number;
  basePriceUsd: number;
  sortOrder: number;
}

export interface PlansCatalog {
  plans: SubscriptionPlanOption[];
  packages: TopUpPackage[];
  discounts: Array<{ packageId: string; minTierLevel: number; discountPct: number }>;
}

export async function fetchPlansCatalog(): Promise<PlansCatalog | null> {
  try {
    // Same-origin GraveLens route — reads the shared Supabase catalog directly.
    const res = await fetch("/api/billing/catalog", { method: "GET" });
    if (!res.ok) return null;
    return (await res.json()) as PlansCatalog;
  } catch {
    return null;
  }
}

/** Tier-driven upsell payload for the Change Plan page (null = hide module). */
export async function fetchPlanRecommendation(): Promise<PlanRecommendation | null> {
  try {
    const res = await fetch("/api/billing/plan-recommendation", { method: "GET" });
    if (!res.ok) return null;
    return (await res.json()) as PlanRecommendation | null;
  } catch {
    return null;
  }
}

/** Concrete impact of switching to `targetSlug` (null = unavailable). */
export async function fetchPlanChangeImpact(targetSlug: string): Promise<PlanChangeImpact | null> {
  try {
    const res = await fetch(`/api/billing/plan-change-impact?target=${encodeURIComponent(targetSlug)}`, {
      method: "GET",
    });
    if (!res.ok) return null;
    return (await res.json()) as PlanChangeImpact | null;
  } catch {
    return null;
  }
}

/** Per-component usage averages + the caller's current-month token usage. */
export async function fetchUsageStats(): Promise<{ averages: UsageAverage[]; monthlyTokens: number | null }> {
  try {
    const res = await fetch("/api/billing/usage-stats", { method: "GET" });
    if (!res.ok) return { averages: [], monthlyTokens: null };
    return (await res.json()) as { averages: UsageAverage[]; monthlyTokens: number | null };
  } catch {
    return { averages: [], monthlyTokens: null };
  }
}

/** A page of transaction history. `scope`: credits (default) | usage | all. */
export async function fetchTransactionHistory(
  { before, scope = "credits" }: { before?: string | null; scope?: "credits" | "usage" | "all" } = {}
): Promise<TransactionHistoryPage> {
  try {
    const qs = new URLSearchParams({ scope });
    if (before) qs.set("before", before);
    const res = await fetch(`/api/billing/transactions?${qs.toString()}`, { method: "GET" });
    if (!res.ok) return { items: [], nextCursor: null };
    return (await res.json()) as TransactionHistoryPage;
  } catch {
    return { items: [], nextCursor: null };
  }
}

/** The caller's token usage aggregated by calendar month (newest first). */
export async function fetchMonthlyUsage(): Promise<MonthlyUsage[]> {
  try {
    const res = await fetch("/api/billing/usage-monthly", { method: "GET" });
    if (!res.ok) return [];
    const data = (await res.json()) as { months?: MonthlyUsage[] };
    return data.months ?? [];
  } catch {
    return [];
  }
}

/** The caller's recent AI spend, one entry per user action (newest first). */
export async function fetchRecentUsage({ limit }: { limit?: number } = {}): Promise<UsageAction[]> {
  try {
    const qs = limit ? `?limit=${limit}` : "";
    const res = await fetch(`/api/billing/usage-recent${qs}`, { method: "GET" });
    if (!res.ok) return [];
    const data = (await res.json()) as { actions?: UsageAction[] };
    return data.actions ?? [];
  } catch {
    return [];
  }
}

/**
 * Itemized details for a completed Stripe Checkout, keyed by session id (from
 * the confirmation redirect). Returns null when the session is missing, not the
 * caller's, or the lookup fails.
 */
export async function fetchConfirmation(sessionId: string): Promise<ConfirmationDetail | null> {
  try {
    const res = await fetch(`/api/billing/confirmation?session_id=${encodeURIComponent(sessionId)}`, {
      method: "GET",
    });
    if (!res.ok) return null;
    return (await res.json()) as ConfirmationDetail;
  } catch {
    return null;
  }
}

/** POST a same-origin billing action that returns a Stripe URL to redirect to. */
async function postForStripeUrl(path: string, body?: Record<string, unknown>): Promise<string> {
  const res = await fetch(path, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  const url = (data as { url?: string }).url;
  if (!url) throw new Error("Stripe did not return a URL.");
  return url;
}

/** A deferred downgrade takes effect at period end and involves no payment, so
 *  the server returns this instead of a redirect URL. */
export type PlanChangeOutcome = { scheduled: true; effectiveAt: string | null; planName: string | null };

/** Begin a subscription checkout. New subscriptions and upgrades redirect to
 *  Stripe. A downgrade is scheduled server-side (no payment) and returns the
 *  outcome so the caller can confirm in place instead of navigating away. */
export async function startSubscriptionCheckout(
  planSlug: "starter" | "plus" | "premium",
  billingPeriod: "monthly" | "annual" = "monthly"
): Promise<PlanChangeOutcome | void> {
  const res = await fetch("/api/billing/subscription-checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planSlug, billingPeriod }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  if ((data as { scheduled?: boolean }).scheduled) {
    return {
      scheduled: true,
      effectiveAt: (data as { effectiveAt?: string | null }).effectiveAt ?? null,
      planName: (data as { planName?: string | null }).planName ?? null,
    };
  }
  const url = (data as { url?: string }).url;
  if (!url) throw new Error("Stripe did not return a URL.");
  window.location.href = url;
}

/** Cancel a scheduled downgrade (releases the Stripe schedule). */
export async function cancelScheduledChange(): Promise<void> {
  const res = await fetch("/api/billing/cancel-scheduled-change", { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || "Failed to cancel the scheduled change.");
}

/** Cancel the subscription at period end, or resume it ({ resume: true }). */
export async function setSubscriptionCancellation(resume = false): Promise<void> {
  const res = await fetch("/api/billing/cancel-subscription", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resume }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || "Failed to update the subscription.");
}

/** Begin a token top-up checkout and redirect to Stripe. */
export async function startTopupCheckout(args: { packageId: string } | { tokens: number }): Promise<void> {
  window.location.href = await postForStripeUrl("/api/billing/topup-checkout", { ...args });
}

/**
 * Open the Stripe billing portal (manage payment method / cancel). Hits
 * GraveLens's own same-origin route; the return URL is derived server-side.
 */
export async function openBillingPortal(): Promise<void> {
  window.location.href = await postForStripeUrl("/api/billing/portal");
}
