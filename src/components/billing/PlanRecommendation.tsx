"use client";

/**
 * PlanRecommendation — primary upsell module on the Change Plan page. Ported from
 * LowHigh's components/billing/PlanRecommendation.tsx, re-themed dark-only
 * (stone/gold). Tier-driven: Starter → Plus + Premium, Plus → Premium,
 * Premium → null (module hidden). Each upgrade is one click → Stripe Checkout.
 */

import { useState } from "react";
import { Loader2, ArrowUpRight, Sparkles, RefreshCw, Zap, ChevronDown } from "lucide-react";
import { startSubscriptionCheckout, type SubscriptionPlanOption } from "@/lib/billingService";
import type { SubscriptionSummary } from "@/lib/lowhighClient";
import type { PlanRecommendation as PlanRecommendationData, PlanUpsellTarget, UsageAverage } from "@/lib/billingTypes";
import TokenUsageBreakdown from "./TokenUsageBreakdown";

function upsellSlugsForTier(tier: number): string[] {
  if (tier === 1) return ["plus", "premium"];
  if (tier === 2) return ["premium"];
  return [];
}

function deriveUpsellTargets(
  subscription: SubscriptionSummary | null,
  plans: SubscriptionPlanOption[]
): PlanUpsellTarget[] {
  if (!subscription) return [];
  return upsellSlugsForTier(subscription.tierLevel)
    .map((slug) => plans.find((p) => p.slug === slug))
    .filter((p): p is SubscriptionPlanOption => Boolean(p))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      tokenAllowance: p.tokenAllowance,
      priceMonthly: p.priceMonthly ?? 0,
      extraTokenPricePerMillionUsd: p.extraTokenPricePerMillionUsd ?? 0,
      rolloverCap: p.rolloverCap,
      rolloverUncapped: p.rolloverUncapped,
      annualSavingsUsd: 0,
      monthlyTotalProjectedUsd: p.priceMonthly ?? 0,
    }));
}

const fmtMillions = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`
    : `${Math.round(n / 1000).toLocaleString()}K`;

const fmtUsd = (n: number) => {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
};

const MIN_DAYS_FOR_USAGE_FRAMING = 7;

type BillingCycle = "monthly" | "annual";

function UpsellCard({
  target,
  planOption,
  billingCycle,
  selected,
  onSelect,
}: {
  target: PlanUpsellTarget;
  planOption?: SubscriptionPlanOption;
  billingCycle: BillingCycle;
  selected: boolean;
  onSelect: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Annual pricing lives on the catalog plan option (upsell targets only carry
  // the monthly price). Fall back to monthly when annual isn't available.
  const annualSupported = planOption?.priceAnnual != null && planOption?.priceAnnualTotal != null;
  const showAnnual = billingCycle === "annual" && annualSupported;
  const perMonth = showAnnual ? planOption!.priceAnnual! : target.priceMonthly;
  const yearlyTotal = planOption?.priceAnnualTotal ?? null;
  const yearlySavings =
    showAnnual && yearlyTotal != null ? Math.max(0, target.priceMonthly * 12 - yearlyTotal) : 0;
  const checkoutCycle: BillingCycle = showAnnual ? "annual" : "monthly";

  const handleUpgrade = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await startSubscriptionCheckout(target.slug as "starter" | "plus" | "premium", checkoutCycle);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start checkout.");
      setBusy(false);
    }
  };

  const rolloverDescription = target.rolloverUncapped
    ? "Unlimited rollover"
    : target.rolloverCap && target.rolloverCap > 0
      ? `Rollover up to ${fmtMillions(target.rolloverCap)}`
      : "No rollover";

  const showSavings = target.annualSavingsUsd >= 12;

  return (
    <div
      role="radio"
      aria-checked={selected}
      aria-label={`Estimate uses for ${target.name}`}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`h-full flex flex-col rounded-2xl p-6 cursor-pointer transition-all bg-gradient-to-br from-[rgba(201,168,76,0.08)] to-transparent border border-[var(--t-gold-600)]/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)] focus-visible:ring-offset-2 focus-visible:ring-offset-stone-900 ${
        selected ? "ring-2 ring-[var(--t-gold-500)] ring-offset-2 ring-offset-stone-900" : ""
      }`}
    >
      <div className="flex items-center gap-1.5">
        <Sparkles className="w-4 h-4 text-[var(--t-gold-400)]" />
        <h3 className="text-lg font-bold text-stone-50 font-serif">{target.name}</h3>
      </div>

      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="text-3xl font-bold tabular-nums text-stone-50">{fmtUsd(perMonth)}</span>
        <span className="text-sm pb-0.5 text-stone-400">/mo</span>
      </div>
      {showAnnual && yearlyTotal != null && (
        <p className="mt-1 text-xs text-stone-400">
          Billed {fmtUsd(yearlyTotal)}/yr
          {yearlySavings > 0 && (
            <span className="ml-1 font-semibold text-[var(--t-gold-400)]">· Save {fmtUsd(yearlySavings)}/yr</span>
          )}
        </p>
      )}

      <div className="mt-4">
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-bold tabular-nums text-[var(--t-gold-400)]">
            {fmtMillions(target.tokenAllowance)}
          </span>
          <span className="text-[10px] uppercase tracking-wider font-semibold text-stone-400">tokens / mo</span>
        </div>
      </div>

      <ul className="mt-4 space-y-1.5">
        <li className="flex items-center gap-1.5">
          <RefreshCw className="w-3 h-3 shrink-0 text-[var(--t-gold-400)]" aria-hidden="true" />
          <span className="text-[12px] font-medium text-stone-300">{rolloverDescription}</span>
        </li>
        <li className="flex items-center gap-1.5">
          <Zap className="w-3 h-3 shrink-0 text-[var(--t-gold-400)]" aria-hidden="true" />
          <span className="text-[12px] font-medium text-stone-300">
            <span className="font-normal text-stone-400">Top-up </span>
            <span className="font-semibold tabular-nums">${target.extraTokenPricePerMillionUsd}</span>
            <span className="font-normal text-stone-400"> / M</span>
          </span>
        </li>
      </ul>

      {showSavings && (
        <div className="mt-4 text-xs font-semibold tabular-nums text-[var(--t-gold-400)]">
          Saves you {fmtUsd(target.annualSavingsUsd)} / yr at your pace
        </div>
      )}

      <div className="mt-auto pt-5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleUpgrade();
          }}
          onKeyDown={(e) => e.stopPropagation()}
          disabled={busy}
          aria-busy={busy}
          className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-bold text-[#1a1917] transition-all active:scale-[0.97] disabled:opacity-50"
          style={{ background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }}
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUpRight className="w-4 h-4" />}
          Upgrade to {target.name}
        </button>
        {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
      </div>
    </div>
  );
}

export default function PlanRecommendation({
  data,
  loading,
  subscription,
  plans,
  usageAverages,
}: {
  data: PlanRecommendationData | null;
  loading: boolean;
  subscription: SubscriptionSummary | null;
  plans: SubscriptionPlanOption[];
  usageAverages?: UsageAverage[];
}) {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("annual");

  const targets = data?.upsellTargets?.length ? data.upsellTargets : deriveUpsellTargets(subscription, plans);
  const hasInfoToDecide = !!data || (!!subscription && plans.length > 0);

  if (loading && !hasInfoToDecide) {
    return (
      <section className="rounded-2xl p-7 border border-stone-700/70 bg-stone-900/65 backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-stone-400" />
          <span className="text-sm text-stone-400">Looking at your recent usage…</span>
        </div>
      </section>
    );
  }

  if (targets.length === 0) return null;

  const selectedTarget = targets.find((t) => t.slug === selectedSlug) ?? targets[0];
  const hasUsageFraming =
    !!data && data.recentAvgTokensMonthly > 0 && data.daysOfHistory >= MIN_DAYS_FOR_USAGE_FRAMING;
  const twoUp = targets.length >= 2;

  // Only surface the monthly/annual toggle when at least one recommended plan
  // actually has annual pricing in the catalog.
  const anyAnnual = targets.some((t) => {
    const p = plans.find((pl) => pl.slug === t.slug);
    return p?.priceAnnual != null && p?.priceAnnualTotal != null;
  });

  return (
    <section className="rounded-2xl p-7 border border-stone-700/70 bg-stone-900/65 backdrop-blur-xl">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <div className="flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-[var(--t-gold-400)]" />
          <h2 className="text-lg font-semibold text-stone-50 font-serif">Recommended for you</h2>
        </div>
        {anyAnnual && (
          <div
            role="tablist"
            aria-label="Billing cycle"
            className="inline-flex items-center gap-1 p-1 rounded-full border border-stone-700 bg-stone-900/70 backdrop-blur-xl"
          >
            {(["monthly", "annual"] as const).map((cycle) => {
              const active = billingCycle === cycle;
              return (
                <button
                  key={cycle}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setBillingCycle(cycle)}
                  className={`px-3.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wide transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)] focus-visible:ring-offset-1 focus-visible:ring-offset-stone-900 ${
                    active ? "text-[#1a1917] shadow-sm" : "text-stone-400 hover:text-stone-200"
                  }`}
                  style={
                    active
                      ? { background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }
                      : undefined
                  }
                >
                  {cycle === "monthly" ? "Monthly" : "Annual"}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {hasUsageFraming && data ? (
        <p className="text-sm text-stone-300">
          Over the last <span className="font-semibold tabular-nums">{Math.min(data.daysOfHistory, 90)} days</span>, you&rsquo;ve
          averaged <span className="font-semibold tabular-nums">{fmtMillions(data.recentAvgTokensMonthly)}</span> tokens / mo
          {data.currentOverageUsdMonthly > 0 && (
            <>
              {" "}and paid about <span className="font-semibold tabular-nums">{fmtUsd(data.currentOverageUsdMonthly)}</span> / mo in
              overage
            </>
          )}
          .{" "}
          {twoUp
            ? "Either upgrade gets you more tokens, a lower top-up rate, and better rollover."
            : "The next tier gives you more tokens, a lower top-up rate, and uncapped rollover."}
        </p>
      ) : (
        <p className="text-sm text-stone-300">
          {twoUp
            ? "Get more tokens, a lower top-up rate, and better rollover behaviour."
            : "The next tier gives you more tokens, a lower top-up rate, and uncapped rollover."}
        </p>
      )}

      <div
        role="radiogroup"
        aria-label="Preview plan for use estimate"
        className={`mt-6 grid gap-4 ${twoUp ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}
      >
        {targets.map((target) => (
          <UpsellCard
            key={target.slug}
            target={target}
            planOption={plans.find((p) => p.slug === target.slug)}
            billingCycle={billingCycle}
            selected={target.slug === selectedTarget.slug}
            onSelect={() => setSelectedSlug(target.slug)}
          />
        ))}
      </div>

      <details className="group mt-5">
        <summary className="cursor-pointer list-none inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] transition-colors text-stone-500 hover:text-stone-300">
          <span>Estimated uses with {selectedTarget.name}</span>
          <ChevronDown className="w-3 h-3 transition-transform group-open:rotate-180" />
        </summary>
        <TokenUsageBreakdown tokens={selectedTarget.tokenAllowance} averages={usageAverages} className="mt-4" />
      </details>
    </section>
  );
}
