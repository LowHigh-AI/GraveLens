"use client";

/**
 * GraveLens Buy More Tokens — /topup
 *
 * Ported from LowHigh's TopupPage and re-themed dark-only (stone/gold), inside
 * the GraveLens app chrome (PageShell). Quantity slider + tier-priced total +
 * a live per-feature usage breakdown. Subscribers only; signed-out / free users
 * see sign-in / "pick a plan" blocks. Top-up amount is arbitrary (1–50M).
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Zap, Loader2, AlertCircle, ArrowRight, ArrowLeft, Minus, Plus, Lock } from "lucide-react";
import PageShell from "@/components/layout/PageShell";
import { useAuth } from "@/lib/auth";
import { useEcosystem } from "@/components/ecosystem/EcosystemProvider";
import { startTopupCheckout, fetchUsageStats } from "@/lib/billingService";
import { APP_ICONS, APP_NOUN, getAppLabel } from "@/lib/usageLabels";
import { type UsageAverage, groupByApp, fmtTokens, fmtUses } from "@/lib/usageGroups";
import { detectSourceApp } from "@/lib/sourceApp";

const MIN_MILLIONS = 1;
const MAX_MILLIONS = 50;
const DEFAULT_MILLIONS = 5;
const STANDARD_PRICE_PER_M = 10;
const PLUS_PRICE_PER_M = 8;
const PREMIUM_PRICE_PER_M = 4;
const ACTIVE_STATUSES = ["active", "trialing", "lifetime"];

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

interface AppAverage {
  label: string;
  avgTokens: number;
  totalPrompts: number;
}

const aggregateByApp = (averages: UsageAverage[]): AppAverage[] => {
  const acc: Record<string, { tokenSum: number; promptSum: number }> = {};
  for (const row of averages) {
    if (!row.estimatedTokensPerUse || row.estimatedTokensPerUse <= 0) continue;
    const label = getAppLabel(row.appSlug);
    if (!acc[label]) acc[label] = { tokenSum: 0, promptSum: 0 };
    acc[label].tokenSum += row.estimatedTokensPerUse * Math.max(1, row.totalPrompts);
    acc[label].promptSum += Math.max(1, row.totalPrompts);
  }
  return Object.entries(acc)
    .map(([label, { tokenSum, promptSum }]) => ({ label, avgTokens: tokenSum / promptSum, totalPrompts: promptSum }))
    .filter((a) => a.avgTokens > 0)
    .sort((a, b) => b.totalPrompts - a.totalPrompts);
};

const usesFor = (tokens: number, avgTokens: number): number => (avgTokens <= 0 ? 0 : Math.floor(tokens / avgTokens));

export default function TopupPage() {
  const { user, loading: authLoading } = useAuth();
  const eco = useEcosystem();
  const subscription = eco?.billing?.subscription ?? null;
  const tokenBalance = eco?.billing?.tokenBalance ?? null;
  const isAuthenticated = !authLoading && !!user;

  const [averages, setAverages] = useState<UsageAverage[]>([]);
  const [millions, setMillions] = useState<number>(DEFAULT_MILLIONS);
  const [millionsInput, setMillionsInput] = useState<string>(String(DEFAULT_MILLIONS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceSlug] = useState<string | null>(() => detectSourceApp());

  useEffect(() => {
    let mounted = true;
    fetchUsageStats()
      .then((data) => {
        if (mounted) setAverages(data?.averages ?? []);
      })
      .catch(() => {
        /* hide estimate section silently */
      });
    return () => {
      mounted = false;
    };
  }, []);

  const tier = subscription?.tierLevel ?? 0;
  const isAdmin = tier === 99;
  const pricePerMillion = subscription?.extraTokenPricePerMillionUsd ?? STANDARD_PRICE_PER_M;
  const hasDiscount = !isAdmin && pricePerMillion < STANDARD_PRICE_PER_M;
  const tierLabel = subscription?.planName ?? "";

  const unitDisplayPrice = isAdmin ? 0 : pricePerMillion;
  const totalPrice = isAdmin ? 0 : millions * pricePerMillion;
  const standardTotal = millions * STANDARD_PRICE_PER_M;
  const savings = hasDiscount ? standardTotal - totalPrice : 0;
  const tokensToBuy = millions * 1_000_000;
  const sliderPct = ((millions - MIN_MILLIONS) / (MAX_MILLIONS - MIN_MILLIONS)) * 100;

  const appAverages = useMemo(() => aggregateByApp(averages), [averages]);
  const hasEstimates = appAverages.length > 0;

  const sourceApp = useMemo(() => {
    if (!sourceSlug) return null;
    const label = getAppLabel(sourceSlug);
    return appAverages.find((a) => a.label === label) ?? null;
  }, [sourceSlug, appAverages]);

  const pricingCardApps = useMemo(() => (sourceApp ? [sourceApp] : []), [sourceApp]);

  const chartGroups = useMemo(() => {
    if (averages.length === 0) return [];
    const grouped = groupByApp(averages);
    return Object.keys(grouped)
      .sort((a, b) => a.localeCompare(b))
      .map((appLabel) => ({
        appLabel,
        tools: Object.keys(grouped[appLabel])
          .sort((a, b) => a.localeCompare(b))
          .map((toolName) => ({
            toolName,
            features: Object.keys(grouped[appLabel][toolName])
              .sort((a, b) => a.localeCompare(b))
              .map((componentName) => ({
                componentName,
                estimatedTokensPerUse: grouped[appLabel][toolName][componentName].estimatedTokensPerUse,
              })),
          })),
      }));
  }, [averages]);

  const clamp = (n: number) => Math.max(MIN_MILLIONS, Math.min(MAX_MILLIONS, n));
  const setMillionsBoth = (n: number) => {
    const c = clamp(n);
    setMillions(c);
    setMillionsInput(String(c));
  };
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw === "" || /^\d+$/.test(raw)) {
      setMillionsInput(raw);
      const n = parseInt(raw, 10);
      if (!Number.isNaN(n)) setMillions(clamp(n));
    }
  };
  const handleInputBlur = () => {
    const n = parseInt(millionsInput, 10);
    if (Number.isNaN(n)) setMillionsBoth(DEFAULT_MILLIONS);
    else setMillionsBoth(n);
  };

  const buy = async () => {
    setBusy(true);
    setError(null);
    try {
      await startTopupCheckout({ tokens: tokensToBuy });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start checkout.");
      setBusy(false);
    }
  };

  const noSubBlock = useMemo(() => {
    if (!isAuthenticated) return "unauthenticated" as const;
    if (!subscription || !ACTIVE_STATUSES.includes(subscription.status) || subscription.tierLevel <= 0)
      return "no_plan" as const;
    return null;
  }, [isAuthenticated, subscription]);

  return (
    <PageShell title="Buy more tokens" icon={<Zap size={20} strokeWidth={2} />} backgroundClass="bg-transparent">
      <div className="w-full pt-5 mb-3 px-4 sm:px-6">
        <Link
          href="/rewards"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-stone-400 hover:text-stone-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)] rounded"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          Balance &amp; Rewards
        </Link>
      </div>

      <div className="max-w-2xl mx-auto rounded-3xl bg-stone-950/70 border border-white/5 px-4 py-8 sm:px-6 sm:py-10 space-y-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-stone-50 font-serif">Top up tokens</h2>
          <p className="mt-1 text-sm text-stone-400">
            Add tokens to your balance. Subscribers pay less per token at higher tiers.
          </p>
        </div>

        {error && (
          <div className="flex items-start gap-2 text-sm text-red-400">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {tokenBalance && (
          <div className="rounded-xl p-5 border border-stone-700/70 bg-stone-900/65 backdrop-blur-xl">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="text-[11px] uppercase tracking-wider text-stone-500">Current balance</p>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="text-2xl font-bold tabular-nums text-stone-100">
                    {fmtTokens(Math.max(0, tokenBalance.availableTokens))}
                  </span>
                  <span className="text-sm text-stone-400">tokens</span>
                </div>
              </div>

              {!noSubBlock && (
                <>
                  <ArrowRight className="hidden sm:block w-4 h-4 self-end mb-2 flex-shrink-0 text-stone-600" />
                  <div className="text-left sm:text-right">
                    <p className="text-[11px] uppercase tracking-wider text-stone-500">After purchase</p>
                    <div className="flex items-baseline gap-2 mt-1 sm:justify-end">
                      <span className="text-2xl font-bold tabular-nums text-stone-100">
                        {fmtTokens(Math.max(0, tokenBalance.availableTokens) + tokensToBuy)}
                      </span>
                      <span className="text-sm text-stone-400">tokens</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {noSubBlock === "unauthenticated" && (
          <div className="rounded-xl p-6 border border-stone-700/70 bg-stone-900/65 backdrop-blur-xl">
            <p className="text-sm text-stone-400">Sign in to buy tokens.</p>
            <Link
              href="/login?next=/topup"
              className="inline-block mt-3 px-4 py-2 rounded-lg text-sm font-bold text-[#1a1917]"
              style={{ background: "var(--t-gold-500)" }}
            >
              Sign in
            </Link>
          </div>
        )}

        {noSubBlock === "no_plan" && (
          <div className="rounded-xl p-6 border border-stone-700/70 bg-stone-900/65 backdrop-blur-xl">
            <h3 className="text-sm font-semibold mb-1 text-stone-100">Pick a plan first</h3>
            <p className="text-sm text-stone-400">
              Top-ups attach to your active subscription. You&rsquo;ll get better rates on Plus and Premium tiers.
            </p>
            <Link
              href="/billing"
              className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-lg text-sm font-bold text-[#1a1917] transition-all active:scale-[0.97]"
              style={{ background: "var(--t-gold-500)" }}
            >
              See plans
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        )}

        {!noSubBlock && (
          <div className="rounded-xl p-6 border border-stone-700/70 bg-stone-900/65 backdrop-blur-xl space-y-6">
            {/* Unit display: 1 million tokens */}
            <div>
              <p className="text-[11px] uppercase tracking-wider text-stone-500">1 million tokens</p>
              <div className="mt-1 flex items-baseline gap-3 flex-wrap">
                {(isAdmin || hasDiscount) && (
                  <span className="text-xl line-through tabular-nums text-stone-500">{fmtUsd(STANDARD_PRICE_PER_M)}</span>
                )}
                <span className="text-3xl font-bold tabular-nums text-stone-100">
                  {isAdmin ? "Free" : fmtUsd(unitDisplayPrice)}
                </span>
                {isAdmin ? (
                  <span className="text-xs font-semibold px-2 py-1 rounded bg-[rgba(201,168,76,0.15)] text-[var(--t-gold-400)] capitalize">
                    Admin tier
                  </span>
                ) : hasDiscount ? (
                  <span className="text-xs font-semibold text-[var(--t-gold-400)] capitalize">{tierLabel} price</span>
                ) : null}
              </div>

              {/* Tier-upgrade hint: only visible to Starter/Plus, links to plans */}
              {!isAdmin && tier > 0 && tier < 3 && (
                <Link
                  href="/billing"
                  className="inline-flex items-center gap-1.5 text-[11px] mt-2 transition-colors text-stone-500 hover:text-stone-300"
                >
                  {tier === 1 && (
                    <>
                      <span>
                        Plus <span className="tabular-nums font-medium text-stone-300">${PLUS_PRICE_PER_M}/M</span>
                      </span>
                      <span className="text-stone-500">·</span>
                    </>
                  )}
                  <span>
                    Premium <span className="tabular-nums font-medium text-stone-300">${PREMIUM_PRICE_PER_M}/M</span>
                  </span>
                  <ArrowRight className="w-3 h-3" />
                </Link>
              )}

              {hasEstimates && pricingCardApps.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs mb-2 text-stone-400">Covers approximately:</p>
                  <ul className="space-y-1.5">
                    {pricingCardApps.map((app) => {
                      const uses = usesFor(1_000_000, app.avgTokens);
                      const noun = APP_NOUN[app.label] ?? "uses";
                      return (
                        <li key={app.label} className="flex items-center gap-2 text-sm">
                          <span className="w-1 h-1 rounded-full bg-stone-500" />
                          <span className="text-stone-100">~{fmtTokens(uses)}</span>
                          <span className="text-stone-400">
                            {app.label} {noun}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>

            <div className="h-px bg-stone-700/50" />

            {/* Quantity selector */}
            <div>
              <p className="text-[11px] uppercase tracking-wider text-stone-500 mb-4">How many?</p>

              <div className="px-1.5">
                <input
                  type="range"
                  min={MIN_MILLIONS}
                  max={MAX_MILLIONS}
                  step={1}
                  value={millions}
                  onChange={(e) => setMillionsBoth(Number(e.target.value))}
                  aria-label="Millions of tokens"
                  style={{
                    background: `linear-gradient(to right, var(--t-gold-500) 0%, var(--t-gold-500) ${sliderPct}%, rgba(255,255,255,0.06) ${sliderPct}%, rgba(255,255,255,0.06) 100%)`,
                  }}
                  className="w-full h-1.5 rounded-full appearance-none cursor-pointer outline-none
                    [&::-webkit-slider-thumb]:appearance-none
                    [&::-webkit-slider-thumb]:w-4
                    [&::-webkit-slider-thumb]:h-4
                    [&::-webkit-slider-thumb]:rounded-full
                    [&::-webkit-slider-thumb]:bg-[var(--t-gold-500)]
                    [&::-webkit-slider-thumb]:shadow-[0_0_0_5px_rgba(201,168,76,0.15)]
                    [&::-webkit-slider-thumb]:transition-transform
                    [&::-webkit-slider-thumb]:hover:scale-110
                    [&::-moz-range-thumb]:w-4
                    [&::-moz-range-thumb]:h-4
                    [&::-moz-range-thumb]:rounded-full
                    [&::-moz-range-thumb]:bg-[var(--t-gold-500)]
                    [&::-moz-range-thumb]:border-0
                    [&::-moz-range-thumb]:cursor-pointer"
                />
              </div>

              <div className="mt-5 flex items-center justify-center">
                <div className="flex items-center rounded-xl p-1 w-56 border border-stone-700/70 bg-stone-800/60">
                  <button
                    type="button"
                    onClick={() => setMillionsBoth(millions - 1)}
                    disabled={millions <= MIN_MILLIONS}
                    className="flex-shrink-0 w-10 h-12 rounded-lg flex items-center justify-center transition-colors disabled:opacity-25 text-stone-300 hover:bg-white/[0.05]"
                    aria-label="Decrease"
                  >
                    <Minus className="w-4 h-4" strokeWidth={3} />
                  </button>
                  <div className="flex-1 flex flex-col items-center justify-center h-12">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={millionsInput}
                      onChange={handleInputChange}
                      onBlur={handleInputBlur}
                      className="w-full text-center bg-transparent border-0 outline-0 text-2xl font-semibold tabular-nums leading-none text-stone-100"
                      aria-label="Millions of tokens"
                    />
                    <span className="text-[9px] uppercase tracking-[0.2em] mt-1 text-stone-500">million</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMillionsBoth(millions + 1)}
                    disabled={millions >= MAX_MILLIONS}
                    className="flex-shrink-0 w-10 h-12 rounded-lg flex items-center justify-center transition-colors disabled:opacity-25 text-stone-300 hover:bg-white/[0.05]"
                    aria-label="Increase"
                  >
                    <Plus className="w-4 h-4" strokeWidth={2.5} />
                  </button>
                </div>
              </div>
            </div>

            <div className="h-px bg-stone-700/50" />

            {/* Total + buy */}
            <div>
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <p className="text-[11px] uppercase tracking-wider text-stone-500">Total</p>
                {hasDiscount && <span className="text-xs font-semibold text-emerald-400">You save {fmtUsd(savings)}</span>}
              </div>
              <div className="mt-1 flex items-baseline gap-3 flex-wrap">
                {(isAdmin || hasDiscount) && (
                  <span className="text-base line-through tabular-nums text-stone-500">{fmtUsd(standardTotal)}</span>
                )}
                <span className="text-2xl font-semibold tabular-nums text-stone-100">
                  {isAdmin ? "Free" : fmtUsd(totalPrice)}
                </span>
              </div>

              <button
                onClick={buy}
                disabled={busy}
                className="w-full mt-5 inline-flex items-center justify-center gap-2 px-5 py-3 rounded-lg text-sm font-bold text-[#1a1917] transition-all active:scale-[0.97] disabled:opacity-50"
                style={{ background: "var(--t-gold-500)" }}
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                Buy now
              </button>
            </div>
          </div>
        )}

        {/* Feature breakdown — editorial index layout */}
        {!noSubBlock && chartGroups.length > 0 && (
          <div className="px-8 -mt-2">
            <div className="flex justify-end mb-3 text-[10px] uppercase tracking-[0.18em] text-stone-500">
              <span>Additional Uses (Estimated)</span>
            </div>

            <div className="space-y-5">
              {chartGroups.map((group) => {
                const Icon = APP_ICONS[group.appLabel];
                return (
                  <div key={group.appLabel}>
                    <div className="flex items-center gap-2 mb-2">
                      {Icon && <Icon className="w-3 h-3 flex-shrink-0 text-stone-500" />}
                      <span className="text-[10px] uppercase tracking-[0.18em] text-stone-500">{group.appLabel}</span>
                      <span className="flex-1 h-px bg-stone-700/60" />
                    </div>

                    <div className="space-y-2.5">
                      {group.tools.map((tool) => (
                        <div key={tool.toolName}>
                          <div className="text-[11px] pl-4 mb-0.5 text-stone-500">{tool.toolName}</div>
                          <div>
                            {tool.features.map((feature) => {
                              const est = feature.estimatedTokensPerUse;
                              const uses = est > 0 ? Math.floor(tokensToBuy / est) : 0;
                              return (
                                <div key={feature.componentName} className="flex items-baseline gap-2 pl-8 py-[3px]">
                                  <span className="text-xs text-stone-400">{feature.componentName}</span>
                                  <span className="flex-1 border-b border-dotted border-stone-700/70 translate-y-[-3px]" />
                                  <span className="text-xs tabular-nums text-stone-300">
                                    {est > 0 ? fmtUses(uses) : "N/A"}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Footer disclaimer */}
        <div className="mt-8 pt-5 border-t border-stone-700/50 space-y-1.5">
          <p className="text-center text-[11px] text-stone-400">
            <Lock className="w-3 h-3 inline-block mr-1.5 -translate-y-px opacity-60" />
            Payments are processed by Stripe.
          </p>
          <p className="text-center text-[11px] text-stone-400">
            Purchased tokens never expire as long as your account is active.
          </p>
        </div>
      </div>
    </PageShell>
  );
}
