"use client";

/**
 * TopupDeflection — one-time top-up section embedded on the Change Plan page,
 * ported from LowHigh's components/billing/TopupDeflection.tsx and re-themed
 * dark-only (stone/gold). Slider + stepper + total + buy, with a live estimated-
 * uses breakdown. Deflects users who came to downgrade after one overage cycle.
 */

import { useState } from "react";
import { Loader2, Zap, AlertCircle, Minus, Plus, ChevronDown } from "lucide-react";
import { startTopupCheckout } from "@/lib/billingService";
import type { SubscriptionSummary } from "@/lib/lowhighClient";
import type { UsageAverage } from "@/lib/billingTypes";
import TokenUsageBreakdown from "./TokenUsageBreakdown";

const MIN_MILLIONS = 1;
const MAX_MILLIONS = 50;
const DEFAULT_MILLIONS = 5;
const STANDARD_PRICE_PER_M = 10;

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

export default function TopupDeflection({
  subscription,
  usageAverages,
}: {
  subscription: SubscriptionSummary | null;
  usageAverages?: UsageAverage[];
}) {
  const [millions, setMillions] = useState<number>(DEFAULT_MILLIONS);
  const [millionsInput, setMillionsInput] = useState<string>(String(DEFAULT_MILLIONS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <section className="rounded-2xl p-7 border border-stone-700/70 bg-stone-900/65 backdrop-blur-xl">
      <div className="flex items-center gap-2 mb-1">
        <Zap className="w-4 h-4 text-[var(--t-gold-400)]" />
        <h2 className="text-base font-semibold text-stone-50 font-serif">Just need a one-time fill?</h2>
      </div>
      <p className="text-sm text-stone-300 mb-6">
        Top up at your{tier >= 2 && tierLabel ? ` discounted ${tierLabel}` : ""} rate. No plan change required.
      </p>

      {error && (
        <div className="flex items-start gap-2 text-sm text-red-400 mb-4">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="space-y-6">
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
            <span className="text-xs text-stone-400">for {millions}M tokens</span>
          </div>

          <button
            onClick={buy}
            disabled={busy || isAdmin}
            className="w-full mt-5 inline-flex items-center justify-center gap-2 px-5 py-3 rounded-lg text-sm font-bold text-[#1a1917] transition-all active:scale-[0.97] disabled:opacity-50"
            style={{ background: "var(--t-gold-500)" }}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            Buy now
          </button>
        </div>

        <details className="group">
          <summary className="cursor-pointer list-none inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] transition-colors text-stone-500 hover:text-stone-300">
            <span>Estimated uses</span>
            <ChevronDown className="w-3 h-3 transition-transform group-open:rotate-180" />
          </summary>
          <TokenUsageBreakdown tokens={tokensToBuy} averages={usageAverages} className="mt-4" />
        </details>
      </div>
    </section>
  );
}
