"use client";

/**
 * CancelRetentionDrawer — nested cancel flow inside PlanChangeDrawer, ported from
 * LowHigh's components/billing/CancelRetentionDrawer.tsx and re-themed dark-only.
 * Shows concrete losses, offers a downgrade-to-Starter alternative, then hands
 * off cancellation to the Stripe portal (the auditable source of truth).
 *
 * Note: GraveLens's billing read does not include monthly loyalty grant totals,
 * so that loss line is omitted (the rest is computed from real account state).
 */

import { useEffect, useState } from "react";
import { Loader2, AlertTriangle, X, ArrowRight } from "lucide-react";
import {
  fetchPlanChangeImpact,
  setSubscriptionCancellation,
  startSubscriptionCheckout,
  type SubscriptionPlanOption,
} from "@/lib/billingService";
import { useEcosystem } from "@/components/ecosystem/EcosystemProvider";
import type { SubscriptionSummary, TokenBalance } from "@/lib/lowhighClient";
import type { PlanChangeImpact } from "@/lib/billingTypes";

const fmtMillions = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`
    : `${Math.round(n / 1000).toLocaleString()}K`;

const fmtDate = (iso: string | null): string => {
  if (!iso) return "the end of your billing period";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "the end of your billing period";
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
};

export default function CancelRetentionDrawer({
  open,
  onClose,
  subscription,
  tokenBalance,
  plans,
  billingCycle = "annual",
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  subscription: SubscriptionSummary | null;
  tokenBalance: TokenBalance | null;
  plans: SubscriptionPlanOption[];
  billingCycle?: "monthly" | "annual";
  /** Called after a scheduled (deferred) downgrade so the parent can refresh. */
  onChanged?: () => void;
}) {
  const [starterImpact, setStarterImpact] = useState<PlanChangeImpact | null>(null);
  const [busy, setBusy] = useState<"downgrade" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const eco = useEcosystem();

  useEffect(() => {
    if (!open || !subscription) return;
    let cancelled = false;
    fetchPlanChangeImpact("starter").then((data) => {
      if (!cancelled) setStarterImpact(data);
    });
    return () => {
      cancelled = true;
    };
  }, [open, subscription]);

  const handlePortal = async (which: "downgrade" | "cancel") => {
    setBusy(which);
    setError(null);
    try {
      if (which === "downgrade") {
        // Route the retention downgrade through the plan-change confirmation
        // flow (same as Other Plan Options), not the generic portal home. Use
        // the drawer's selected cycle, falling back to monthly if Starter has
        // no annual price.
        const starter = plans.find((p) => p.slug === "starter");
        const cycle =
          billingCycle === "annual" && starter?.priceAnnual != null && starter?.priceAnnualTotal != null
            ? "annual"
            : "monthly";
        const outcome = await startSubscriptionCheckout("starter", cycle);
        // Scheduled downgrade: no navigation. Refresh the parent's banner.
        if (outcome?.scheduled) {
          eco?.showToast(
            `Downgrade to ${outcome.planName ?? "Starter"} scheduled for ${fmtDate(outcome.effectiveAt)}.${
              subscription ? ` You keep ${subscription.planName} until then.` : ""
            }`
          );
          onChanged?.();
          return;
        }
      } else {
        // Cancel at period end in-app (no generic Stripe portal). The parent
        // refreshes and shows the "ending on [date]" banner.
        await setSubscriptionCancellation();
        eco?.showToast(
          `Your ${subscription?.planName ?? "current"} plan will end on ${fmtDate(
            subscription?.currentPeriodEnd ?? null
          )}. You keep full access until then.`
        );
        onChanged?.();
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the portal.");
      setBusy(null);
    }
  };

  // ── Loss items (monthly loyalty grants unavailable in GraveLens billing read) ──
  const rolloverTokens = tokenBalance?.rolloverTokens ?? 0;
  const losses: string[] = [];
  if (rolloverTokens > 0) losses.push(`Your rollover bank of ${fmtMillions(rolloverTokens)} tokens`);
  if (starterImpact?.nearestMilestone?.wouldBeLost && starterImpact.nearestMilestone.daysRemaining > 0) {
    losses.push(`${starterImpact.nearestMilestone.name}, only ${starterImpact.nearestMilestone.daysRemaining} days away`);
  }
  if (subscription?.tokenAllowance && subscription.tokenAllowance > 0) {
    losses.push(`Your monthly ${fmtMillions(subscription.tokenAllowance)} token allowance`);
  }

  const hasStarter = plans.some((p) => p.slug === "starter");
  const showDowngradeOffer = hasStarter && subscription && subscription.tierLevel > 1;

  if (!open) return null;

  return (
    <section className="overflow-hidden animate-in fade-in slide-in-from-top-1 duration-300">
      <div className="mt-4 rounded-2xl p-7 border border-stone-700/70 bg-stone-900/65 backdrop-blur-xl">
            <div className="flex items-start justify-between gap-4 mb-1">
              <h2 className="text-lg font-semibold text-stone-50 font-serif">Before you cancel</h2>
              <button
                type="button"
                onClick={onClose}
                className="text-sm text-stone-300 hover:opacity-70 transition-opacity"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {losses.length > 0 && (
              <div className="mt-4 rounded-xl p-4 bg-amber-500/10 border border-amber-500/20">
                <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-amber-300">
                  <AlertTriangle className="w-3 h-3" />
                  What you&rsquo;ll give up
                </div>
                <ul className="mt-2 space-y-1 text-sm text-stone-300">
                  {losses.map((l, i) => (
                    <li key={i}>• {l}</li>
                  ))}
                </ul>
              </div>
            )}

            {showDowngradeOffer && (
              <div className="mt-5 rounded-xl p-5 border border-[var(--t-gold-600)]/40 bg-[rgba(201,168,76,0.06)]">
                <h3 className="text-base font-semibold text-stone-50 font-serif">Try Starter instead</h3>
                <p className="mt-1 text-sm text-stone-300">
                  Stay on LowHigh at the lower tier. You keep your account, your apps, and any rollover you&rsquo;re entitled to
                  under Starter&rsquo;s policy.
                </p>
                <button
                  type="button"
                  onClick={() => handlePortal("downgrade")}
                  disabled={busy !== null}
                  aria-busy={busy === "downgrade"}
                  className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-[#1a1917] transition-all active:scale-[0.97] disabled:opacity-50"
                  style={{ background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }}
                >
                  {busy === "downgrade" ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                  Downgrade to Starter
                </button>
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold border border-stone-700 text-stone-200 hover:border-stone-600 transition-colors"
              >
                Keep my plan
              </button>
              <button
                type="button"
                onClick={() => handlePortal("cancel")}
                disabled={busy !== null}
                aria-busy={busy === "cancel"}
                className="text-sm text-stone-400 hover:underline disabled:opacity-50"
              >
                {busy === "cancel" ? "Canceling…" : "Cancel anyway"}
              </button>
            </div>
            {error && <div className="mt-3 text-xs text-red-400">{error}</div>}
      </div>
    </section>
  );
}
