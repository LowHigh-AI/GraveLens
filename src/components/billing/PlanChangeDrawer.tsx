"use client";

/**
 * PlanChangeDrawer — inline "Other Plan Options" drawer on the Change Plan page,
 * ported from LowHigh's components/billing/PlanChangeDrawer.tsx and re-themed
 * dark-only (stone/gold, with emerald/amber kept to signal upgrade vs downgrade).
 * Upgrades go straight to Stripe Checkout; downgrades route through the Stripe
 * portal. The nested CancelRetentionDrawer sits behind a footer link.
 */

import { useEffect, useState } from "react";
import { Loader2, ArrowRight, Check, AlertTriangle, RefreshCw, Zap, X, Sparkles, ChevronDown } from "lucide-react";
import { fetchPlanChangeImpact, startSubscriptionCheckout, type SubscriptionPlanOption } from "@/lib/billingService";
import type { SubscriptionSummary, TokenBalance } from "@/lib/lowhighClient";
import type { PlanChangeImpact, UsageAverage } from "@/lib/billingTypes";
import TokenUsageBreakdown from "./TokenUsageBreakdown";
import CancelRetentionDrawer from "./CancelRetentionDrawer";
import { useEcosystem } from "@/components/ecosystem/EcosystemProvider";

type BillingCycle = "monthly" | "annual";

const fmtMillions = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`
    : `${Math.round(n / 1000).toLocaleString()}K`;

const fmtUsd = (n: number) => {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
};

const fmtUsdSigned = (n: number) => (n >= 0 ? `+${fmtUsd(n)}` : `-${fmtUsd(Math.abs(n))}`);

const fmtDate = (iso: string | null): string => {
  if (!iso) return "the end of your billing period";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "the end of your billing period";
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
};

function ImpactSummary({ impact }: { impact: PlanChangeImpact }) {
  if (impact.direction !== "downgrade") return null;

  const items: string[] = [];
  if (impact.tokenDelta < 0) items.push(`Lose ${fmtMillions(Math.abs(impact.tokenDelta))} tokens / mo`);
  if (impact.loyaltyGrantsLostMonthly > 0)
    items.push(`Forfeit ${fmtMillions(impact.loyaltyGrantsLostMonthly)} in monthly loyalty grants`);
  if (impact.rolloverBankAtRisk > 0) items.push(`Lose ${fmtMillions(impact.rolloverBankAtRisk)} of your rollover bank`);
  if (impact.nearestMilestone?.wouldBeLost && impact.nearestMilestone.daysRemaining > 0) {
    items.push(`Give up ${impact.nearestMilestone.name}, only ${impact.nearestMilestone.daysRemaining} days away`);
  }
  if (items.length === 0) return null;

  return (
    <div className="mt-3 text-xs space-y-1 text-stone-400">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-amber-300">
        <AlertTriangle className="w-3 h-3" />
        What you&rsquo;d lose
      </div>
      <ul className="space-y-0.5">
        {items.map((i, idx) => (
          <li key={idx}>• {i}</li>
        ))}
      </ul>
    </div>
  );
}

function ScaleBar({ allowance, max, fillClass }: { allowance: number; max: number; fillClass: string }) {
  const pct = max > 0 ? Math.max(2, Math.round((allowance / max) * 100)) : 0;
  return (
    <div className="mt-3 h-1.5 rounded-full bg-stone-700/60 overflow-hidden" aria-hidden="true">
      <div style={{ width: `${pct}%` }} className={`h-full rounded-full ${fillClass}`} />
    </div>
  );
}

const rolloverLabel = (plan: SubscriptionPlanOption): string => {
  if (plan.rolloverUncapped) return "Unlimited rollover";
  if (plan.rolloverCap && plan.rolloverCap > 0) return `Rollover up to ${fmtMillions(plan.rolloverCap)}`;
  return "No rollover";
};

function CompactPlanCard({
  plan,
  maxTokenAllowance,
  isCurrent,
  direction,
  tone,
  pill,
  impact,
  impactLoading,
  busy,
  selected,
  billingCycle,
  onSelect,
  onChoose,
}: {
  plan: SubscriptionPlanOption;
  maxTokenAllowance: number;
  isCurrent: boolean;
  direction: "upgrade" | "downgrade" | "same";
  tone: "green" | "yellow";
  pill: "recommended" | "current" | null;
  impact: PlanChangeImpact | null;
  impactLoading: boolean;
  busy: boolean;
  selected: boolean;
  billingCycle: BillingCycle;
  onSelect: () => void;
  onChoose: () => void;
}) {
  const isGreen = tone === "green";
  // Mirror the "Recommended for you" pricing: in annual mode show the annual
  // per-month rate (with the yearly total) when the plan has annual pricing,
  // otherwise fall back to the monthly price.
  const showAnnual = billingCycle === "annual" && plan.priceAnnual != null && plan.priceAnnualTotal != null;
  const perMonth = showAnnual ? plan.priceAnnual! : plan.priceMonthly ?? 0;

  const wrapperStyle = isGreen
    ? "border-emerald-400/50 bg-gradient-to-br from-emerald-500/[0.14] to-transparent shadow-[0_0_56px_color-mix(in_srgb,#10b981_16%,transparent)] hover:-translate-y-0.5 hover:shadow-[0_0_72px_color-mix(in_srgb,#10b981_26%,transparent)]"
    : "border-amber-400/40 bg-gradient-to-br from-amber-400/[0.10] to-transparent hover:border-amber-300/60 hover:-translate-y-0.5";
  const ringStyle = pill === "recommended" ? "ring-2 ring-emerald-400/40" : "";
  const toneText = isGreen ? "text-emerald-300" : "text-amber-300";
  const chipIcon = isGreen ? "text-emerald-400" : "text-amber-400";
  const scaleFill = isGreen ? "bg-emerald-400" : "bg-amber-400";
  const ctaGreen = "bg-emerald-500 text-emerald-950 hover:bg-emerald-400";
  const ctaYellow = "bg-amber-400/15 text-amber-200 hover:bg-amber-400/25";

  return (
    <div className="relative">
      {pill === "recommended" && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-10">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500 text-white text-[10px] font-bold tracking-wider uppercase shadow-lg">
            <Sparkles className="w-3 h-3" />
            Recommended
          </div>
        </div>
      )}
      {pill === "current" && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-10">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500 text-white text-[10px] font-bold tracking-wider uppercase shadow-lg">
            <Check className="w-3 h-3" />
            Current plan
          </div>
        </div>
      )}

      <div
        role="radio"
        aria-checked={selected}
        aria-label={`Estimate uses for ${plan.name}`}
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        className={`h-full flex flex-col rounded-2xl p-5 border cursor-pointer transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)] focus-visible:ring-offset-2 focus-visible:ring-offset-stone-900 ${wrapperStyle} ${ringStyle} ${
          selected ? "ring-2 ring-[var(--t-gold-500)] ring-offset-2 ring-offset-stone-900" : ""
        }`}
      >
        <h3 className="text-base font-bold text-stone-50 font-serif">{plan.name}</h3>

        <div className="mt-3 flex items-end gap-1.5">
          <span className="text-3xl font-bold tabular-nums text-stone-50">${perMonth}</span>
          <span className="text-xs pb-1 text-stone-400">/mo</span>
        </div>
        {showAnnual && plan.priceAnnualTotal != null && (
          <div className="mt-0.5 text-[11px] text-stone-400 tabular-nums">${plan.priceAnnualTotal} billed yearly</div>
        )}

        <div className="mt-4">
          <div className="flex items-baseline gap-1.5">
            <span className={`text-2xl font-bold tabular-nums leading-none ${toneText}`}>
              {fmtMillions(plan.tokenAllowance)}
            </span>
            <span className="text-[10px] uppercase tracking-wider font-semibold text-stone-400">tokens / mo</span>
          </div>
          <ScaleBar allowance={plan.tokenAllowance} max={maxTokenAllowance} fillClass={scaleFill} />
        </div>

        <ul className="mt-4 space-y-1.5">
          <li className="flex items-center gap-1.5">
            <RefreshCw className={`w-3 h-3 shrink-0 ${chipIcon}`} aria-hidden="true" />
            <span className={`text-[11px] font-medium ${toneText}`}>{rolloverLabel(plan)}</span>
          </li>
          {plan.extraTokenPricePerMillionUsd != null && (
            <li className="flex items-center gap-1.5">
              <Zap className={`w-3 h-3 shrink-0 ${chipIcon}`} aria-hidden="true" />
              <span className={`text-[11px] font-medium ${toneText}`}>
                <span className="font-normal text-stone-400">Top-up </span>
                <span className="font-semibold tabular-nums">${plan.extraTokenPricePerMillionUsd}</span>
                <span className="font-normal text-stone-400"> / M</span>
              </span>
            </li>
          )}
        </ul>

        {!isCurrent && impact && direction === "upgrade" && impact.tokenDelta > 0 && (
          <div className="mt-3 text-[11px] tabular-nums text-stone-400">
            <span className="font-semibold text-emerald-400">+{fmtMillions(impact.tokenDelta)}</span> tokens ·{" "}
            {fmtUsdSigned(impact.priceDeltaMonthlyUsd)}/mo
          </div>
        )}

        {!isCurrent && impact && direction === "downgrade" && <ImpactSummary impact={impact} />}

        <div className="mt-auto pt-4">
          {isCurrent ? (
            <div className="w-full text-center text-[11px] font-semibold uppercase tracking-wider text-stone-400">
              Your current plan
            </div>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onChoose();
              }}
              onKeyDown={(e) => e.stopPropagation()}
              disabled={busy || impactLoading}
              aria-busy={busy}
              className={`w-full inline-flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all active:scale-[0.97] disabled:opacity-50 ${
                isGreen ? ctaGreen : ctaYellow
              }`}
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
              {direction === "upgrade" ? `Upgrade to ${plan.name}` : `Switch to ${plan.name}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PlanChangeDrawer({
  open,
  onClose,
  plans,
  subscription,
  tokenBalance,
  usageAverages,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  plans: SubscriptionPlanOption[];
  subscription: SubscriptionSummary | null;
  tokenBalance: TokenBalance | null;
  usageAverages?: UsageAverage[];
  /** Called after a plan change that does NOT navigate away (a scheduled
   *  downgrade), so the parent can refresh the pending-change banner. */
  onChanged?: () => void;
}) {
  // The parent remounts this component per-open (via `key`), so each open starts
  // with a clean slate: impacts === null (loading) until the fetch resolves.
  const [impacts, setImpacts] = useState<Record<string, PlanChangeImpact> | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("annual");
  const eco = useEcosystem();
  const impactLoading = open && impacts === null;

  // Only surface the monthly/annual toggle when at least one plan actually has
  // annual pricing configured (mirrors the "Recommended for you" section).
  const anyAnnual = plans.some((p) => p.priceAnnual != null && p.priceAnnualTotal != null);

  // Fetch impacts for every non-current plan once, in parallel. State is only set
  // inside the async resolution (never synchronously) so we don't trigger the
  // cascading-render lint. Promise.all([]) resolves to {} for a single-plan catalog.
  useEffect(() => {
    if (!open || !subscription) return;
    let cancelled = false;
    const targets = plans.map((p) => p.slug).filter((slug) => slug !== subscription.planSlug);
    Promise.all(targets.map((slug) => fetchPlanChangeImpact(slug))).then((results) => {
      if (cancelled) return;
      const map: Record<string, PlanChangeImpact> = {};
      results.forEach((r) => {
        if (r) map[r.targetPlanSlug] = r;
      });
      setImpacts(map);
    });
    return () => {
      cancelled = true;
    };
  }, [open, subscription, plans]);

  // Default the usage-breakdown preview to the current plan until the user picks.
  const effectiveSlug = selectedSlug ?? subscription?.planSlug ?? null;

  const handleChoose = async (plan: SubscriptionPlanOption) => {
    if (!subscription || !impacts) return;
    const impact = impacts[plan.slug];
    if (!impact) return;
    setBusySlug(plan.slug);
    setError(null);
    try {
      // Upgrades and downgrades both modify the existing subscription via the
      // same Stripe plan-change confirmation flow. Whether the switch applies now
      // (upgrade) or at period end (downgrade) is governed by the Stripe portal
      // configuration. Check out at the selected cycle, falling back to monthly
      // when the chosen plan has no annual price.
      const cycle: BillingCycle =
        billingCycle === "annual" && plan.priceAnnual != null && plan.priceAnnualTotal != null
          ? "annual"
          : "monthly";
      const outcome = await startSubscriptionCheckout(plan.slug as "starter" | "plus" | "premium", cycle);
      // A downgrade is scheduled (no navigation): tell the parent to show the
      // pending-change banner and close the drawer. Upgrades navigate away
      // inside startSubscriptionCheckout, so we never reach here for those.
      if (outcome?.scheduled) {
        eco?.showToast(
          `Downgrade to ${outcome.planName ?? plan.name} scheduled for ${fmtDate(outcome.effectiveAt)}. You keep ${subscription.planName} until then.`
        );
        onChanged?.();
        onClose();
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not complete the change.");
      setBusySlug(null);
    }
  };

  const maxTokenAllowance = plans.reduce((m, p) => Math.max(m, p.tokenAllowance), 0);
  const selectedPlan = plans.find((p) => p.slug === effectiveSlug) ?? null;

  const currentTier = subscription?.tierLevel ?? null;
  const maxTier = plans.reduce((m, p) => Math.max(m, p.tierLevel), 0);
  const recommendedTier: number | null =
    currentTier == null
      ? null
      : plans
          .filter((p) => p.tierLevel > currentTier)
          .reduce<number | null>((min, p) => (min == null ? p.tierLevel : Math.min(min, p.tierLevel)), null);

  if (!open) return null;

  return (
    <section className="overflow-hidden animate-in fade-in slide-in-from-top-1 duration-300">
      <div>
          <div className="mt-4 rounded-2xl p-7 border border-stone-700/70 bg-stone-900/65 backdrop-blur-xl">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
              <h2 className="text-lg font-semibold text-stone-50 font-serif">Other Plan Options</h2>
              <div className="flex items-center gap-3">
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
                <button
                  type="button"
                  onClick={onClose}
                  className="text-sm text-stone-300 hover:opacity-70 transition-opacity"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <p className="text-sm text-stone-300">Compare every plan. Numbers are based on your account.</p>

            <div role="radiogroup" aria-label="Preview plan for use estimate" className="mt-7 grid grid-cols-1 sm:grid-cols-3 gap-4">
              {plans
                .slice()
                .sort((a, b) => a.tierLevel - b.tierLevel)
                .map((plan) => {
                  const isCurrent = subscription?.planSlug === plan.slug;
                  const impact = impacts?.[plan.slug] ?? null;
                  const direction =
                    impact?.direction ??
                    (isCurrent ? "same" : subscription && plan.tierLevel > subscription.tierLevel ? "upgrade" : "downgrade");
                  const isUpgrade = currentTier != null && plan.tierLevel > currentTier;
                  const isCurrentTop = isCurrent && plan.tierLevel === maxTier;
                  const tone: "green" | "yellow" = isUpgrade || isCurrentTop ? "green" : "yellow";
                  const pill: "recommended" | "current" | null =
                    recommendedTier != null && plan.tierLevel === recommendedTier
                      ? "recommended"
                      : isCurrentTop
                        ? "current"
                        : null;
                  return (
                    <CompactPlanCard
                      key={plan.slug}
                      plan={plan}
                      maxTokenAllowance={maxTokenAllowance}
                      isCurrent={isCurrent}
                      direction={direction}
                      tone={tone}
                      pill={pill}
                      impact={impact}
                      impactLoading={impactLoading}
                      busy={busySlug === plan.slug}
                      selected={plan.slug === effectiveSlug}
                      billingCycle={billingCycle}
                      onSelect={() => setSelectedSlug(plan.slug)}
                      onChoose={() => handleChoose(plan)}
                    />
                  );
                })}
            </div>

            {selectedPlan && (
              <details className="group mt-5">
                <summary className="cursor-pointer list-none inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] transition-colors text-stone-500 hover:text-stone-300">
                  <span>Estimated uses with {selectedPlan.name}</span>
                  <ChevronDown className="w-3 h-3 transition-transform group-open:rotate-180" />
                </summary>
                <TokenUsageBreakdown tokens={selectedPlan.tokenAllowance} averages={usageAverages} className="mt-4" />
              </details>
            )}

            {error && (
              <div className="mt-5 flex justify-end">
                <span className="text-xs text-red-400">{error}</span>
              </div>
            )}
          </div>

          <div className="mt-3 px-1 flex justify-end">
            <button
              type="button"
              onClick={() => setCancelOpen(true)}
              className="text-xs text-stone-400 hover:opacity-80 transition-opacity"
            >
              Cancel subscription
            </button>
          </div>

          <CancelRetentionDrawer
            open={cancelOpen}
            onClose={() => setCancelOpen(false)}
            subscription={subscription}
            tokenBalance={tokenBalance}
            plans={plans}
            billingCycle={billingCycle}
            onChanged={() => {
              onChanged?.();
              onClose();
            }}
          />
      </div>
    </section>
  );
}
