"use client";

/**
 * Estimated uses remaining — a subtle, collapsible wrapper around the standard
 * usage estimator (TokenUsageBreakdown). Closed by default so it stays out of the
 * way; when opened it shows how many uses the user's CURRENT balance buys across
 * apps/features. Styled lighter than the RecentActivity ledger so it reads as a
 * quiet utility, not another action card.
 *
 * The estimator self-fetches its per-feature averages, so we defer mounting it
 * until the panel is first opened (no fetch for users who never expand it), and
 * show a throbber while those averages load.
 *
 * The figures recompute automatically whenever `tokens` changes (React props).
 * When that happens while the panel is OPEN — e.g. the user claims a reward and
 * the balance jumps — we flash the same throbber for a beat so the recalculation
 * is visible instead of the numbers silently changing. The estimator stays
 * mounted throughout, so its cached averages are not re-fetched.
 */

import { useEffect, useId, useState } from "react";
import { Calculator, ChevronDown, Loader2 } from "lucide-react";
import TokenUsageBreakdown from "@/components/billing/TokenUsageBreakdown";

export default function EstimatedUsesPanel({ tokens }: { tokens: number }) {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const bodyId = useId();

  const toggle = () => {
    setOpen((o) => !o);
    setEverOpened(true);
  };

  // Flash the throbber when the balance changes while open (e.g. after a claim).
  // The change is detected during render (React's recommended alternative to a
  // setState-in-effect); the effect below only owns the 600ms auto-clear timer,
  // which resets on each change. While closed we keep prevTokens synced so
  // reopening never falsely triggers the throbber.
  const [prevTokens, setPrevTokens] = useState(tokens);
  if (tokens !== prevTokens) {
    setPrevTokens(tokens);
    if (open) setRecalculating(true);
  }
  useEffect(() => {
    if (!recalculating) return;
    const timer = setTimeout(() => setRecalculating(false), 600);
    return () => clearTimeout(timer);
  }, [recalculating, tokens]);

  return (
    <section className="overflow-hidden rounded-2xl border border-white/5 bg-stone-950/40">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className="w-full flex items-center gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)] focus-visible:ring-inset"
      >
        <Calculator className="w-3.5 h-3.5 shrink-0 text-stone-500" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-stone-300">Estimated uses remaining</span>
          <span className="block text-[11px] text-stone-500">What your balance is worth across apps</span>
        </span>
        <ChevronDown
          className={`w-4 h-4 text-stone-500 transition-transform duration-300 ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {/* grid-rows trick for a smooth height transition */}
      <div
        id={bodyId}
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">
          {everOpened && (
            <div className="px-4 pb-4 pt-1">
              <TokenUsageBreakdown
                tokens={Math.max(0, tokens)}
                recalculating={recalculating}
                loadingState={
                  <div className="flex items-center gap-2 py-2 text-stone-500" role="status" aria-live="polite">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    <span className="text-[11px]">Calculating estimates…</span>
                  </div>
                }
                emptyState={
                  <p className="text-[11px] text-stone-500">
                    No usage data yet. Once you use GraveLens features, estimates appear here.
                  </p>
                }
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
