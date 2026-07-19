import "server-only";

/**
 * Server-side billing reads for GraveLens.
 *
 * GraveLens shares LowHigh's Supabase project, so rather than calling LowHigh's
 * cross-origin billing API (which only exists on stages that aren't deployed at
 * lowhigh.ai), we read the shared billing tables directly with the service-role
 * key — exactly how LowHigh's own `api/billing-subscription.js` does it. This
 * runs server-side only (service role bypasses RLS, including the SECURITY
 * DEFINER `v_token_balances` view), keeping the critical path same-origin.
 *
 * Queries/formatters ported from LowHigh's api/billing-subscription.js,
 * api/_utils/billingUtils.js and api/_billing-handlers/plans.js. Only the
 * fields the GraveLens billing page consumes are fetched (no loyalty RPC,
 * entitlements, or featured-apps — unused here).
 */

import { getServiceClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripeCustomer";
import type {
  BillingData,
  SubscriptionSummary,
  TokenBalance,
  TokenTransaction,
  TransactionHistoryPage,
  MonthlyUsage,
  UsageAction,
} from "@/lib/lowhighClient";
import type { PlansCatalog } from "@/lib/billingService";
import type { PlanRecommendation, PlanChangeImpact, UsageAverage } from "@/lib/billingTypes";

/** The 7 credit (non-usage) ledger types shown by default on billing surfaces. */
const CREDIT_TX_TYPES = ["allocation", "rollover", "top_up", "refund", "bonus", "gift", "adjustment"];

/** Map a raw `token_transactions` row to the client `TokenTransaction` shape. */
function mapTransaction(t: Record<string, unknown>): TokenTransaction {
  const meta = (t.metadata ?? null) as { charge_amount_usd?: unknown } | null;
  const rawCharge = meta?.charge_amount_usd;
  const charge = rawCharge != null ? Number(rawCharge) : NaN;
  return {
    id: String(t.id ?? ""),
    type: String(t.type ?? ""),
    amount: Number(t.amount ?? 0),
    balanceAfter: t.balance_after != null ? Number(t.balance_after) : null,
    description: (t.description as string) ?? null,
    created_at: String(t.created_at ?? ""),
    stripePaymentIntentId: (t.stripe_payment_intent_id as string) ?? null,
    chargeAmountUsd: Number.isFinite(charge) ? charge : null,
  };
}

const TX_COLUMNS = "id, type, amount, balance_after, description, created_at, stripe_payment_intent_id, metadata";

/** Admin (bypass_billing) users get a synthetic unlimited view, mirroring LowHigh. */
const ADMIN_SUBSCRIPTION: SubscriptionSummary = {
  planSlug: "admin",
  planName: "Admin",
  tierLevel: 99,
  status: "admin",
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  pendingDowngrade: null,
  tokenAllowance: 999_999_999,
  rolloverCap: null,
  rolloverUncapped: true,
  extraTokenPricePerMillionUsd: null,
};

const ADMIN_BALANCE: TokenBalance = {
  allocatedTokens: 999_999_999,
  purchasedTokens: 0,
  rolloverTokens: 0,
  usedTokens: 0,
  availableTokens: 999_999_999,
  periodEnd: null,
};

type Sb = NonNullable<ReturnType<typeof getServiceClient>>;

async function isAdminBypassed(supabase: Sb, userId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from("lowhigh_admins")
      .select("user_id")
      .eq("user_id", userId)
      .eq("is_active", true)
      .eq("bypass_billing", true)
      .maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}

function formatSubscription(row: Record<string, unknown> | null): SubscriptionSummary | null {
  if (!row) return null;
  const plan = (row.subscription_plans ?? {}) as Record<string, unknown>;
  return {
    planSlug: (plan.slug as string) ?? "unknown",
    planName: (plan.name as string) ?? "Unknown",
    tierLevel: (plan.tier_level as number) ?? 0,
    status: (row.status as string) ?? "unknown",
    currentPeriodEnd: (row.current_period_end as string) ?? null,
    cancelAtPeriodEnd: !!row.cancel_at_period_end,
    // Resolved separately from the Stripe schedule in fetchBillingForUser.
    pendingDowngrade: null,
    tokenAllowance: plan.token_allowance != null ? Number(plan.token_allowance) : null,
    rolloverCap: plan.rollover_cap != null ? Number(plan.rollover_cap) : null,
    rolloverUncapped: !!plan.rollover_uncapped,
    extraTokenPricePerMillionUsd:
      plan.extra_token_price_per_million_usd != null
        ? Number(plan.extra_token_price_per_million_usd)
        : null,
  };
}

function formatTokenBalance(row: Record<string, unknown> | null): TokenBalance | null {
  if (!row) return null;
  return {
    allocatedTokens: Number(row.allocated_tokens ?? 0),
    purchasedTokens: Number(row.purchased_tokens ?? 0),
    rolloverTokens: Number(row.rollover_tokens ?? 0),
    usedTokens: Number(row.used_tokens ?? 0),
    availableTokens: Number(row.available_tokens ?? 0),
    periodEnd: (row.period_end as string) ?? null,
  };
}

/**
 * Fetch a user's subscription, token balance, and recent transactions from the
 * shared Supabase project. Each query degrades to null/[] independently so a
 * single failure never blanks the whole page.
 */
export async function fetchBillingForUser(userId: string): Promise<BillingData> {
  const supabase = getServiceClient();
  if (!supabase) return { subscription: null, tokenBalance: null, recentTransactions: [] };

  if (await isAdminBypassed(supabase, userId)) {
    return { subscription: ADMIN_SUBSCRIPTION, tokenBalance: ADMIN_BALANCE, recentTransactions: [] };
  }

  const [subscriptionResult, balanceResult, transactionsResult] = await Promise.allSettled([
    supabase
      .from("user_subscriptions")
      .select(
        "*, subscription_plans(slug, name, tier_level, token_allowance, rollover_cap, rollover_uncapped, extra_token_price_per_million_usd)"
      )
      .eq("user_id", userId)
      .maybeSingle(),

    supabase.from("v_token_balances").select("*").eq("user_id", userId).maybeSingle(),

    supabase
      .from("token_transactions")
      .select(TX_COLUMNS)
      .eq("user_id", userId)
      .in("type", CREDIT_TX_TYPES)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const subscriptionRow =
    subscriptionResult.status === "fulfilled" ? subscriptionResult.value.data : null;
  const balanceRow = balanceResult.status === "fulfilled" ? balanceResult.value.data : null;
  const transactionRows =
    transactionsResult.status === "fulfilled" ? transactionsResult.value.data ?? [] : [];

  const subscription = formatSubscription(subscriptionRow as Record<string, unknown> | null);
  // Resolve a scheduled (deferred) downgrade from the Stripe schedule as part of
  // this once-per-session read, so /plan doesn't fire a Stripe call per visit.
  // A cancellation supersedes a downgrade, so skip the extra call in that case.
  if (subscription && subscriptionRow) {
    const subId = (subscriptionRow as Record<string, unknown>).stripe_subscription_id as
      | string
      | undefined;
    const active = ["active", "trialing", "past_due"].includes(subscription.status);
    if (subId && active && !subscription.cancelAtPeriodEnd) {
      subscription.pendingDowngrade = await resolvePendingDowngrade(supabase, subId);
    }
  }

  return {
    subscription,
    tokenBalance: formatTokenBalance(balanceRow as Record<string, unknown> | null),
    recentTransactions: (transactionRows as Record<string, unknown>[]).map(mapTransaction),
  };
}

/**
 * Read a deferred downgrade from the Stripe subscription schedule (the future
 * phase's price -> plan). Fully defensive: any failure returns null so it can
 * never break the core billing read.
 */
async function resolvePendingDowngrade(
  supabase: NonNullable<ReturnType<typeof getServiceClient>>,
  subId: string
): Promise<{ planName: string | null; effectiveAt: string | null } | null> {
  try {
    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(subId);
    if (!sub.schedule) return null;
    const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule.id;
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
    const currentPriceId = sub.items?.data?.[0]?.price?.id ?? null;
    const nowSec = Math.floor(Date.now() / 1000);
    const futurePhase = schedule.phases.find((p) => (p.start_date ?? 0) > nowSec);
    if (!futurePhase) return null;
    const pendingPriceId =
      typeof futurePhase.items[0].price === "string"
        ? futurePhase.items[0].price
        : futurePhase.items[0].price?.id ?? null;
    if (!pendingPriceId || pendingPriceId === currentPriceId) return null;

    let planName: string | null = null;
    const { data: plan } = await supabase
      .from("subscription_plans")
      .select("name")
      .or(`stripe_price_id_monthly.eq.${pendingPriceId},stripe_price_id_annual.eq.${pendingPriceId}`)
      .maybeSingle();
    planName = (plan as { name?: string } | null)?.name ?? null;
    if (!planName) {
      const price = await stripe.prices.retrieve(pendingPriceId, { expand: ["product"] });
      const product = price.product;
      if (product && typeof product === "object" && !("deleted" in product && product.deleted)) {
        planName = (product as { name?: string }).name ?? null;
      }
    }
    return {
      planName,
      effectiveAt: futurePhase.start_date ? new Date(futurePhase.start_date * 1000).toISOString() : null,
    };
  } catch (err) {
    console.error("[billingData] resolvePendingDowngrade error:", (err as Error).message);
    return null;
  }
}

/**
 * Fetch a page of the user's transaction ledger for the Transaction History
 * page. Keyset pagination on `created_at` (index-backed, stable for an
 * append-only ledger): pass the previous page's `nextCursor` as `before`.
 *
 * `scope` selects which ledger rows to include:
 *   - "credits" (default): the 7 non-usage types (matches the Rewards card)
 *   - "usage": only `debit` rows (AI token consumption)
 *   - "all": everything
 *
 * Service-role read; callers MUST have already authenticated the user and pass
 * that user's id (this enforces the user scope that RLS would otherwise apply).
 */
export async function fetchTransactionHistory(
  userId: string,
  { limit = 25, before, scope = "credits" }: { limit?: number; before?: string | null; scope?: "credits" | "usage" | "all" } = {}
): Promise<TransactionHistoryPage> {
  const supabase = getServiceClient();
  if (!supabase) return { items: [], nextCursor: null };

  const pageSize = Math.min(Math.max(1, limit), 100);

  let query = supabase
    .from("token_transactions")
    .select(TX_COLUMNS)
    .eq("user_id", userId)
    // (created_at, id) keyset: `id` breaks ties so rows that share a created_at
    // (e.g. a monthly reset's allocation + bonus, inserted at the same NOW())
    // are never skipped across a page boundary.
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(pageSize + 1); // fetch one extra to detect a next page

  if (scope === "credits") query = query.in("type", CREDIT_TX_TYPES);
  else if (scope === "usage") query = query.eq("type", "debit");

  // Cursor is "<created_at>|<id>". Older cursor form (bare timestamp) still works.
  if (before) {
    const sep = before.lastIndexOf("|");
    const beforeTs = sep >= 0 ? before.slice(0, sep) : before;
    const beforeId = sep >= 0 ? before.slice(sep + 1) : "";
    query = beforeId
      ? query.or(`created_at.lt.${beforeTs},and(created_at.eq.${beforeTs},id.lt.${beforeId})`)
      : query.lt("created_at", beforeTs);
  }

  const { data, error } = await query;
  if (error || !data) return { items: [], nextCursor: null };

  const rows = data as Record<string, unknown>[];
  const hasMore = rows.length > pageSize;
  const items = rows.slice(0, pageSize).map(mapTransaction);
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? `${last.created_at}|${last.id}` : null;
  return { items, nextCursor };
}

/**
 * Token usage aggregated by calendar month, for the Transaction History "Used"
 * view. Usage is not itemized in token_transactions (no debit rows are written);
 * it lives in api_usage_log, so we aggregate it in the DB via the usage_by_month
 * RPC (indexed on user_id, created_at) rather than summing rows in the app.
 *
 * The "expired / didn't carry over" figure per month is read from the sparse
 * `allocation` ledger rows' metadata (recorded at each monthly reset). Only
 * present for resets that ran after that instrumentation shipped; older months
 * report null.
 */
export async function fetchMonthlyUsage(userId: string): Promise<MonthlyUsage[]> {
  const supabase = getServiceClient();
  if (!supabase) return [];

  const { data, error } = await supabase.rpc("usage_by_month", { p_user_id: userId, p_limit: 24 });
  if (error || !data) return [];

  // Map calendar-month → expired tokens from allocation rows' metadata.
  const monthKey = (iso: string) => String(iso).slice(0, 7); // "2026-07"
  const expiredByMonth = new Map<string, number>();
  const { data: allocRows } = await supabase
    .from("token_transactions")
    .select("created_at, metadata")
    .eq("user_id", userId)
    .eq("type", "allocation")
    .order("created_at", { ascending: false })
    .limit(36);
  for (const r of (allocRows ?? []) as { created_at?: string; metadata?: Record<string, unknown> | null }[]) {
    const exp = r.metadata?.expired_tokens;
    if (r.created_at && exp != null) expiredByMonth.set(monthKey(r.created_at), Number(exp) || 0);
  }

  return (data as { month: string; used_tokens: number; call_count: number }[]).map((row) => {
    const key = monthKey(row.month);
    return {
      month: String(row.month),
      usedTokens: Number(row.used_tokens) || 0,
      expiredTokens: expiredByMonth.has(key) ? expiredByMonth.get(key)! : null,
      callCount: Number(row.call_count) || 0,
    };
  });
}

/** Group ~150 recent `api_usage_log` rows into per-action spends in JS. */
function groupUsageRows(
  rows: {
    prompt_id?: string | null;
    id?: string;
    created_at?: string;
    component?: string | null;
    tool?: string | null;
    lowhigh_tokens?: number | null;
  }[],
  limit: number
): UsageAction[] {
  const byAction = new Map<
    string,
    { started: string; actionTokens: number; callCount: number; tool: string | null; components: Set<string> }
  >();
  for (const r of rows) {
    // Legacy rows have a null prompt_id — key on the row id so each renders on
    // its own rather than collapsing into one bogus group.
    const key = r.prompt_id ?? r.id ?? "";
    if (!key) continue;
    const started = String(r.created_at ?? "");
    const g = byAction.get(key);
    if (g) {
      g.actionTokens += Number(r.lowhigh_tokens) || 0;
      g.callCount += 1;
      if (started && started < g.started) g.started = started;
      if (r.tool && !g.tool) g.tool = r.tool;
      if (r.component) g.components.add(r.component);
    } else {
      byAction.set(key, {
        started,
        actionTokens: Number(r.lowhigh_tokens) || 0,
        callCount: 1,
        tool: r.tool ?? null,
        components: new Set(r.component ? [r.component] : []),
      });
    }
  }
  return Array.from(byAction.entries())
    .map(([promptId, g]) => ({
      promptId,
      started: g.started,
      actionTokens: g.actionTokens,
      callCount: g.callCount,
      tool: g.tool,
      components: Array.from(g.components),
    }))
    .sort((a, b) => (a.started < b.started ? 1 : a.started > b.started ? -1 : 0))
    .slice(0, limit);
}

/**
 * Fetch the user's recent AI spend, one row per user action (grouped by
 * `prompt_id`). Prefers the `recent_usage_actions` RPC; if it isn't present in
 * the live schema yet, falls back to grouping ~150 recent `api_usage_log` rows
 * in JS so the feature works before the migration lands. Admin-bypassed users
 * have no metered usage, so they get an empty list.
 */
export async function fetchRecentUsage(userId: string, { limit = 8 }: { limit?: number } = {}): Promise<UsageAction[]> {
  const supabase = getServiceClient();
  if (!supabase) return [];
  if (await isAdminBypassed(supabase, userId)) return [];

  // Preferred path: the indexed RPC does the grouping in Postgres.
  const { data, error } = await supabase.rpc("recent_usage_actions", { p_user_id: userId, p_limit: limit });
  if (!error && data) {
    return (
      data as {
        prompt_id?: string | null;
        started?: string;
        action_tokens?: number;
        call_count?: number;
        tool?: string | null;
        components?: string[] | null;
      }[]
    ).map((r) => ({
      promptId: String(r.prompt_id ?? ""),
      started: String(r.started ?? ""),
      actionTokens: Number(r.action_tokens) || 0,
      callCount: Number(r.call_count) || 0,
      tool: r.tool ?? null,
      components: Array.isArray(r.components) ? r.components.filter(Boolean) : [],
    }));
  }

  // Fallback: pull recent raw rows and group them client-side.
  const { data: rawRows } = await supabase
    .from("api_usage_log")
    .select("id, prompt_id, created_at, component, tool, lowhigh_tokens")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(150);
  if (!rawRows) return [];
  return groupUsageRows(rawRows as Parameters<typeof groupUsageRows>[0], limit);
}

/**
 * Fetch the public catalog (active subscription plans, top-up packages, tier
 * discounts). Mirrors LowHigh's public `plans` endpoint.
 */
export async function fetchCatalog(): Promise<PlansCatalog> {
  const empty: PlansCatalog = { plans: [], packages: [], discounts: [] };
  const supabase = getServiceClient();
  if (!supabase) return empty;

  const [plansResult, pkgResult, discountResult] = await Promise.allSettled([
    supabase
      .from("subscription_plans")
      .select(
        "id, slug, name, description, tier_level, price_monthly, price_annual, price_annual_total, token_allowance, rollover_cap, rollover_uncapped, extra_token_price_per_million_usd, features, sort_order"
      )
      .eq("is_active", true)
      .eq("is_public", true)
      .order("sort_order"),

    supabase
      .from("token_top_up_packages")
      .select("id, name, token_amount, base_price_usd, sort_order")
      .eq("is_active", true)
      .order("sort_order"),

    supabase.from("top_up_tier_discounts").select("package_id, min_tier_level, discount_pct"),
  ]);

  const plansRows = (plansResult.status === "fulfilled" ? plansResult.value.data ?? [] : []) as Record<
    string,
    unknown
  >[];
  const pkgRows = (pkgResult.status === "fulfilled" ? pkgResult.value.data ?? [] : []) as Record<
    string,
    unknown
  >[];
  const discountRows = (discountResult.status === "fulfilled"
    ? discountResult.value.data ?? []
    : []) as Record<string, unknown>[];

  return {
    plans: plansRows.map((p) => ({
      id: String(p.id),
      slug: String(p.slug),
      name: String(p.name),
      description: (p.description as string) ?? null,
      tierLevel: Number(p.tier_level ?? 0),
      priceMonthly: p.price_monthly != null ? Number(p.price_monthly) : null,
      priceAnnual: p.price_annual != null ? Number(p.price_annual) : null,
      priceAnnualTotal: p.price_annual_total != null ? Number(p.price_annual_total) : null,
      tokenAllowance: Number(p.token_allowance ?? 0),
      rolloverCap: p.rollover_cap != null ? Number(p.rollover_cap) : null,
      rolloverUncapped: !!p.rollover_uncapped,
      extraTokenPricePerMillionUsd:
        p.extra_token_price_per_million_usd != null
          ? Number(p.extra_token_price_per_million_usd)
          : null,
      features: Array.isArray(p.features) ? (p.features as string[]) : [],
      sortOrder: Number(p.sort_order ?? 0),
    })),
    packages: pkgRows.map((pkg) => ({
      id: String(pkg.id),
      name: String(pkg.name),
      tokenAmount: Number(pkg.token_amount ?? 0),
      basePriceUsd: Number(pkg.base_price_usd ?? 0),
      sortOrder: Number(pkg.sort_order ?? 0),
    })),
    discounts: discountRows.map((d) => ({
      packageId: String(d.package_id),
      minTierLevel: Number(d.min_tier_level ?? 0),
      discountPct: Number(d.discount_pct ?? 0),
    })),
  };
}

// ── Subscriber decision surface (Change Plan / Top-up) ────────────────────────
// Ported from LowHigh's api/_billing-handlers/plan-recommendation.js,
// plan-change-impact.js and api/usage-stats.js. Same shared Supabase, read with
// the service-role key. Each degrades to null/empty on failure so a missing RPC
// or schema-drift surfaces as a hidden module rather than a 500.

type PlanRow = {
  slug?: string;
  name?: string;
  tier_level?: number;
  price_monthly?: number;
  token_allowance?: number;
  extra_token_price_per_million_usd?: number;
  rollover_cap?: number | null;
  rollover_uncapped?: boolean;
};

const RECOMMENDATION_WINDOW_DAYS = 90;

/** Project a plan's monthly cost at a usage rate, charging overage at its top-up rate. */
function projectedMonthlyCost(plan: PlanRow, avgMonthlyTokens: number) {
  const base = Number(plan.price_monthly || 0);
  const allowance = Number(plan.token_allowance || 0);
  const overageTokens = Math.max(0, avgMonthlyTokens - allowance);
  const overagePerMillion = Number(plan.extra_token_price_per_million_usd || 0);
  const overageCost = (overageTokens / 1_000_000) * overagePerMillion;
  return { total: base + overageCost, base, overageCost };
}

const upsellSlugsForTier = (tier: number): string[] => {
  if (tier === 1) return ["plus", "premium"];
  if (tier === 2) return ["premium"];
  return [];
};

/**
 * Tier-driven upsell payload for the Change Plan page. Returns null for admin,
 * free, or no-subscription users (the page hides the recommendation module).
 */
export async function fetchPlanRecommendation(userId: string): Promise<PlanRecommendation | null> {
  const supabase = getServiceClient();
  if (!supabase) return null;
  if (await isAdminBypassed(supabase, userId)) return null;

  try {
    const [subResult, plansResult] = await Promise.all([
      supabase
        .from("user_subscriptions")
        .select(
          "plan_id, status, created_at, subscription_plans(slug, name, tier_level, price_monthly, token_allowance, extra_token_price_per_million_usd, rollover_cap, rollover_uncapped)"
        )
        .eq("user_id", userId)
        .maybeSingle(),
      supabase
        .from("subscription_plans")
        .select(
          "id, slug, name, tier_level, price_monthly, token_allowance, extra_token_price_per_million_usd, rollover_cap, rollover_uncapped"
        )
        .eq("is_active", true)
        .eq("is_public", true)
        .order("tier_level"),
    ]);

    const subRow = subResult.data as { created_at?: string; subscription_plans?: PlanRow } | null;
    const plans = (plansResult.data ?? []) as PlanRow[];
    if (!subRow || !subRow.subscription_plans) return null;

    const currentPlan = subRow.subscription_plans;
    const currentTier = Number(currentPlan.tier_level || 0);

    // Usage lives in api_usage_log (normalized lowhigh_tokens), NOT as
    // token_transactions 'debit' rows — those are never written. Aggregate the
    // rolling window in the DB (usage_summary_since) rather than pulling every
    // row into the app.
    const windowStart = new Date(Date.now() - RECOMMENDATION_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: usageData } = await supabase.rpc("usage_summary_since", {
      p_user_id: userId,
      p_since: windowStart,
    });
    const usage = (Array.isArray(usageData) ? usageData[0] : usageData) as
      | { total_tokens?: number; earliest?: string }
      | null;
    const totalConsumed = Number(usage?.total_tokens ?? 0);
    const earliestEvent = usage?.earliest ? new Date(usage.earliest) : null;
    const subStart = subRow.created_at ? new Date(subRow.created_at) : null;
    const historyFloor =
      earliestEvent && subStart
        ? new Date(Math.max(earliestEvent.getTime(), subStart.getTime()))
        : earliestEvent || subStart || new Date();
    const daysOfHistory = Math.max(0, Math.floor((Date.now() - historyFloor.getTime()) / (24 * 60 * 60 * 1000)));
    const effectiveDays = Math.min(daysOfHistory, RECOMMENDATION_WINDOW_DAYS);
    const recentAvgTokensMonthly = effectiveDays > 0 ? Math.round((totalConsumed / effectiveDays) * 30) : 0;

    const currentProjection = projectedMonthlyCost(currentPlan, recentAvgTokensMonthly);
    const currentOverageUsdMonthly = Math.round(currentProjection.overageCost * 100) / 100;

    const upsellTargets = upsellSlugsForTier(currentTier)
      .map((slug) => plans.find((p) => p.slug === slug))
      .filter((p): p is PlanRow => Boolean(p))
      .map((plan) => {
        const { total } = projectedMonthlyCost(plan, recentAvgTokensMonthly);
        return {
          slug: String(plan.slug),
          name: String(plan.name),
          tokenAllowance: Number(plan.token_allowance || 0),
          priceMonthly: Number(plan.price_monthly || 0),
          extraTokenPricePerMillionUsd: Number(plan.extra_token_price_per_million_usd || 0),
          rolloverCap: plan.rollover_cap != null ? Number(plan.rollover_cap) : null,
          rolloverUncapped: !!plan.rollover_uncapped,
          annualSavingsUsd: Math.round((currentProjection.total - total) * 12 * 100) / 100,
          monthlyTotalProjectedUsd: Math.round(total * 100) / 100,
        };
      });

    return { currentTier, recentAvgTokensMonthly, daysOfHistory, currentOverageUsdMonthly, upsellTargets };
  } catch {
    return null;
  }
}

type LoyaltyGoal = {
  id?: string;
  title?: string;
  token_amount?: number;
  category?: string;
  requirement_params?: { min_tier_level?: number; min_paid_months?: number } | null;
};

/**
 * Concrete impact of switching to `targetSlug`. Returns null for admin / no
 * subscription / unknown target.
 */
export async function fetchPlanChangeImpact(
  userId: string,
  targetSlug: string
): Promise<PlanChangeImpact | null> {
  const supabase = getServiceClient();
  if (!supabase) return null;
  if (await isAdminBypassed(supabase, userId)) return null;

  try {
    const [subResult, targetResult, balanceResult, loyaltyResult, allGoalsResult] = await Promise.all([
      supabase
        .from("user_subscriptions")
        .select(
          "plan_id, subscription_plans(slug, name, tier_level, price_monthly, token_allowance, extra_token_price_per_million_usd, rollover_cap, rollover_uncapped)"
        )
        .eq("user_id", userId)
        .maybeSingle(),
      supabase
        .from("subscription_plans")
        .select(
          "id, slug, name, tier_level, price_monthly, token_allowance, extra_token_price_per_million_usd, rollover_cap, rollover_uncapped"
        )
        .eq("slug", targetSlug)
        .eq("is_active", true)
        .maybeSingle(),
      supabase
        .from("v_token_balances")
        .select("rollover_tokens, allocated_tokens, purchased_tokens, used_tokens, available_tokens")
        .eq("user_id", userId)
        .maybeSingle(),
      supabase
        .from("reward_claims")
        .select("reward_id, rewards(id, slug, title, token_amount, category, requirement_type, requirement_params)")
        .eq("user_id", userId),
      supabase
        .from("rewards")
        .select("id, slug, title, requirement_type, requirement_params")
        .eq("category", "loyalty")
        .eq("is_active", true),
    ]);

    const subRow = subResult.data as { subscription_plans?: PlanRow } | null;
    const targetPlan = targetResult.data as PlanRow | null;
    const balanceRow = balanceResult.data as { rollover_tokens?: number } | null;
    const claimedGoals = ((loyaltyResult.data ?? []) as { rewards?: LoyaltyGoal }[])
      .map((r) => r.rewards)
      .filter((g): g is LoyaltyGoal => Boolean(g));
    const allLoyaltyGoals = (allGoalsResult.data ?? []) as LoyaltyGoal[];

    if (!subRow || !subRow.subscription_plans || !targetPlan) return null;

    const currentPlan = subRow.subscription_plans;
    const currentTier = Number(currentPlan.tier_level || 0);
    const targetTier = Number(targetPlan.tier_level || 0);
    const direction = targetTier > currentTier ? "upgrade" : targetTier < currentTier ? "downgrade" : "same";

    const tokenDelta = Number(targetPlan.token_allowance || 0) - Number(currentPlan.token_allowance || 0);

    const loyaltyGrantsLostMonthly = claimedGoals.reduce((sum, g) => {
      if (g.category !== "loyalty") return sum;
      const required = Number(g.requirement_params?.min_tier_level ?? 1);
      return required > targetTier ? sum + Number(g.token_amount || 0) : sum;
    }, 0);

    const rolloverTokens = Number(balanceRow?.rollover_tokens ?? 0);
    const targetCap = targetPlan.rollover_cap != null ? Number(targetPlan.rollover_cap) : 0;
    const rolloverBankAtRisk = targetPlan.rollover_uncapped ? 0 : Math.max(0, rolloverTokens - targetCap);

    const priceDeltaMonthlyUsd = Number(targetPlan.price_monthly || 0) - Number(currentPlan.price_monthly || 0);
    const topUpRateDeltaUsd =
      Number(targetPlan.extra_token_price_per_million_usd || 0) -
      Number(currentPlan.extra_token_price_per_million_usd || 0);

    const claimedGoalIds = new Set(claimedGoals.map((g) => g.id));
    const distinctTiers = [
      ...new Set(
        allLoyaltyGoals
          .filter((g) => !claimedGoalIds.has(g.id))
          .map((g) => Number(g.requirement_params?.min_tier_level ?? 1))
          .filter((t) => t <= currentTier)
      ),
    ];

    const tenureByTier: Record<number, number> = {};
    await Promise.all(
      distinctTiers.map(async (tier) => {
        const { data } = await supabase.rpc("user_paid_tenure_months_at_tier", {
          p_user_id: userId,
          p_min_tier_level: tier,
        });
        tenureByTier[tier] = Number(data ?? 0);
      })
    );

    let nearestMilestone: PlanChangeImpact["nearestMilestone"] = null;
    let smallestDaysRemaining = Infinity;
    for (const g of allLoyaltyGoals) {
      if (claimedGoalIds.has(g.id)) continue;
      const params = g.requirement_params || {};
      const minTier = Number(params.min_tier_level ?? 1);
      const minMonths = Number(params.min_paid_months ?? 0);
      if (minTier > currentTier) continue;
      const tenure = tenureByTier[minTier] ?? 0;
      const monthsRemaining = Math.max(0, minMonths - tenure);
      const daysRemaining = Math.ceil(monthsRemaining * 30);
      if (daysRemaining < smallestDaysRemaining) {
        smallestDaysRemaining = daysRemaining;
        nearestMilestone = { name: String(g.title ?? ""), daysRemaining, wouldBeLost: minTier > targetTier };
      }
    }

    return {
      targetPlanSlug: String(targetPlan.slug),
      targetPlanName: String(targetPlan.name),
      targetTierLevel: targetTier,
      direction,
      tokenDelta,
      loyaltyGrantsLostMonthly,
      rolloverBankAtRisk,
      topUpRateDeltaUsd,
      priceDeltaMonthlyUsd,
      nearestMilestone,
    };
  } catch {
    return null;
  }
}

/**
 * Per-component usage averages (and the caller's current-month token usage when
 * `userId` is provided). Always returns an object; averages is [] on failure.
 */
export async function fetchUsageStats(
  userId: string | null
): Promise<{ averages: UsageAverage[]; monthlyTokens: number | null }> {
  const supabase = getServiceClient();
  if (!supabase) return { averages: [], monthlyTokens: null };

  let averages: UsageAverage[] = [];
  try {
    const { data: settingsRows } = await supabase
      .from("usage_tracking_settings")
      .select("app_slug, is_enabled, tracking_start_at")
      .eq("is_enabled", true);

    const enabledSet = new Set((settingsRows ?? []).map((s: { app_slug: string }) => s.app_slug));
    const startFilter = Object.fromEntries(
      (settingsRows ?? [])
        .filter((s: { tracking_start_at?: string }) => s.tracking_start_at)
        .map((s: { app_slug: string; tracking_start_at?: string }) => [s.app_slug, s.tracking_start_at])
    );

    if (enabledSet.size > 0) {
      const { data: avgRows } = await supabase.rpc("usage_by_app_component_filtered", {
        start_filter: startFilter,
      });
      averages = ((avgRows ?? []) as Record<string, unknown>[])
        .filter((row) => enabledSet.has(row.app_slug as string))
        .map((row) => {
          const avgTokens = Number(row.avg_lowhigh_tokens_per_prompt) || 0;
          return {
            appSlug: String(row.app_slug),
            tool: (row.tool as string) || null,
            component: String(row.component),
            avgTokens,
            totalPrompts: Number(row.total_prompts) || 0,
            estimatedTokensPerUse: avgTokens,
          };
        });
    }
  } catch {
    averages = [];
  }

  let monthlyTokens: number | null = null;
  if (userId) {
    try {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).toISOString();
      const { data: usageRows } = await supabase
        .from("api_usage_log")
        .select("lowhigh_tokens")
        .eq("user_id", userId)
        .gte("created_at", monthStart)
        .lte("created_at", monthEnd);
      monthlyTokens = ((usageRows ?? []) as { lowhigh_tokens?: number }[]).reduce(
        (sum, r) => sum + Number(r.lowhigh_tokens || 0),
        0
      );
    } catch {
      monthlyTokens = null;
    }
  }

  return { averages, monthlyTokens };
}
