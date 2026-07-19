"use client";

/**
 * GraveLens Change Plan — /plan
 *
 * Subscriber decision surface, ported from LowHigh's PlanPage. NOT the prospect
 * pricing page (that's /billing). Renders the recommendation, top-up deflection,
 * and asymmetric-friction plan-change / cancel drawers, inside the GraveLens app
 * chrome (PageShell). Free / signed-out users are redirected away.
 */

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CreditCard, ArrowLeft } from "lucide-react";
import PageShell from "@/components/layout/PageShell";
import { useAuth } from "@/lib/auth";
import { useEcosystem } from "@/components/ecosystem/EcosystemProvider";
import {
  fetchPlansCatalog,
  fetchPlanRecommendation,
  fetchUsageStats,
  cancelScheduledChange,
  setSubscriptionCancellation,
  type PlansCatalog,
} from "@/lib/billingService";
import { formatTokens, type SubscriptionSummary } from "@/lib/lowhighClient";
import type { PlanRecommendation as PlanRecommendationData, UsageAverage } from "@/lib/billingTypes";
import PlanRecommendation from "@/components/billing/PlanRecommendation";
import TopupDeflection from "@/components/billing/TopupDeflection";
import PlanChangeDrawer from "@/components/billing/PlanChangeDrawer";
import { readSessionCache, writeSessionCache, useIsomorphicLayoutEffect } from "@/lib/sessionCache";

// Cached catalog + recommendation + usage so a return visit paints in one pass
// instantly instead of re-running the skeleton every time. Subscription/balance
// already come cached via the ecosystem provider.
type PlanSnapshot = {
  catalog: PlansCatalog | null;
  recommendation: PlanRecommendationData | null;
  usageAverages: UsageAverage[];
};
const PLAN_CACHE_KEY = "gl_plan_cache";

const fmtDate = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric" });
};

// Includes the year — a deferred downgrade can land up to a year out.
const fmtDateFull = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
};

/** Plain-language rollover policy for the current plan (loss-aversion context). */
const rolloverPolicy = (sub: SubscriptionSummary | null): string => {
  if (!sub) return "";
  if (sub.rolloverUncapped) return "Unused tokens roll over with no cap.";
  if (sub.rolloverCap && sub.rolloverCap > 0)
    return `Unused tokens roll over up to ${formatTokens(sub.rolloverCap)} each month.`;
  return "Unused tokens reset each month and don't roll over.";
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <PageShell title="Change plan" icon={<CreditCard size={20} strokeWidth={2} />} backgroundClass="bg-transparent">
      <div className="w-full pt-5 mb-3 px-4 sm:px-6 flex items-center gap-3">
        <Link
          href="/rewards"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-stone-400 hover:text-stone-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)] rounded"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          Balance &amp; Rewards
        </Link>
      </div>

      <div className="max-w-3xl mx-auto rounded-3xl bg-stone-950/70 border border-white/5 px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </div>
    </PageShell>
  );
}

// Loading placeholder that mirrors the final layout (header + recommendation
// card + top-up deflection + plan-options link). The page renders in a single
// pass once every section's data is in, so this holds the exact shape rather
// than letting sections pop in one fetch at a time.
function PlanSkeleton() {
  return (
    <div className="animate-pulse" role="status" aria-label="Loading your plan">
      <div className="mb-8 space-y-2">
        <div className="h-2.5 w-20 rounded bg-stone-800" />
        <div className="h-8 w-48 rounded bg-stone-800" />
        <div className="h-3 w-36 rounded bg-stone-800" />
      </div>
      <div className="space-y-6">
        <div className="rounded-2xl border border-white/5 bg-stone-900/40 p-5 space-y-4">
          <div className="h-3 w-28 rounded bg-stone-800" />
          <div className="h-5 w-3/4 rounded bg-stone-800" />
          <div className="h-3 w-full rounded bg-stone-800" />
          <div className="h-10 w-40 rounded-lg bg-stone-800" />
        </div>
        <div className="rounded-2xl border border-white/5 bg-stone-900/40 p-5 space-y-3">
          <div className="h-3 w-32 rounded bg-stone-800" />
          <div className="h-3 w-2/3 rounded bg-stone-800" />
        </div>
        <div className="h-4 w-36 rounded bg-stone-800" />
      </div>
      <span className="sr-only">Loading your plan</span>
    </div>
  );
}

function PlanPageInner() {
  const { user, loading: authLoading } = useAuth();
  const eco = useEcosystem();
  const router = useRouter();
  const searchParams = useSearchParams();
  const upgradeToastedRef = useRef(false);

  const subscription = eco?.billing?.subscription ?? null;
  const tokenBalance = eco?.billing?.tokenBalance ?? null;
  const billingLoading = eco?.loading ?? false;

  const [catalog, setCatalog] = useState<PlansCatalog | null>(null);
  const [recommendation, setRecommendation] = useState<PlanRecommendationData | null>(null);
  const [recLoading, setRecLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [planDrawerOpen, setPlanDrawerOpen] = useState(false);
  const [usageAverages, setUsageAverages] = useState<UsageAverage[]>([]);
  const [usageLoaded, setUsageLoaded] = useState(false);
  const [cancelingPending, setCancelingPending] = useState(false);
  const [resumingCancel, setResumingCancel] = useState(false);

  // The scheduled downgrade now comes from the shared billing read (no per-visit
  // Stripe call) — derived, not fetched.
  const pendingChange = subscription?.pendingDowngrade ?? null;

  const handleResume = async () => {
    setResumingCancel(true);
    try {
      await setSubscriptionCancellation(true);
      await eco?.refresh?.();
      eco?.showToast(`Subscription resumed. Your ${subscription?.planName ?? "current"} plan continues as normal.`);
    } catch {
      /* leave the banner in place on failure */
    } finally {
      setResumingCancel(false);
    }
  };

  const handleCancelPending = async () => {
    setCancelingPending(true);
    try {
      await cancelScheduledChange();
      await eco?.refresh?.();
      eco?.showToast(`Downgrade canceled. You're staying on ${subscription?.planName ?? "your current plan"}.`);
    } catch {
      /* leave the banner in place on failure */
    } finally {
      setCancelingPending(false);
    }
  };

  // Paint the last-known catalog/recommendation/usage before the browser paints,
  // so a return visit renders the full page immediately (skeleton only cold).
  useIsomorphicLayoutEffect(() => {
    if (!user) return;
    const snap = readSessionCache<PlanSnapshot>(PLAN_CACHE_KEY, user.id);
    if (snap) {
      setCatalog(snap.catalog);
      setRecommendation(snap.recommendation);
      setUsageAverages(snap.usageAverages);
      setCatalogLoading(false);
      setRecLoading(false);
      setUsageLoaded(true);
    }
  }, [user?.id]);

  // Persist once all three sections are in, for the next visit.
  useEffect(() => {
    if (user && !catalogLoading && !recLoading && usageLoaded && catalog) {
      writeSessionCache<PlanSnapshot>(PLAN_CACHE_KEY, user.id, {
        catalog,
        recommendation,
        usageAverages,
      });
    }
  }, [user?.id, catalogLoading, recLoading, usageLoaded, catalog, recommendation, usageAverages]);

  // Gate: signed-out → login; free authed → prospect pricing. Wait for billing
  // to settle so we don't bounce a subscriber whose data is mid-fetch.
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.replace("/login?next=/plan");
      return;
    }
    if (!billingLoading && (!subscription || subscription.tierLevel < 1)) {
      router.replace("/billing");
    }
  }, [authLoading, user, billingLoading, subscription, router]);

  useEffect(() => {
    let cancelled = false;
    fetchUsageStats()
      .then((data) => {
        if (!cancelled) setUsageAverages(data?.averages ?? []);
      })
      .catch(() => {
        if (!cancelled) setUsageAverages([]);
      })
      .finally(() => {
        if (!cancelled) setUsageLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchPlansCatalog().then((c) => {
      if (cancelled) return;
      setCatalog(c);
      setCatalogLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetchPlanRecommendation().then((r) => {
      if (cancelled) return;
      setRecommendation(r);
      setRecLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Confirm an upgrade returning from Stripe (the return_url carries the plan
  // name): toast it once, refresh billing, and strip the param so a page refresh
  // won't re-toast.
  useEffect(() => {
    const upgraded = searchParams.get("upgraded");
    if (!upgraded || upgradeToastedRef.current) return;
    upgradeToastedRef.current = true;
    eco?.showToast(`You're on ${upgraded} now. Your new tokens are available right away.`);
    eco?.refresh?.();
    router.replace("/plan");
  }, [searchParams, router]); // eslint-disable-line react-hooks/exhaustive-deps

  // While a redirect is pending (signed-out or free), render nothing meaningful.
  if (!authLoading && !user) return <Shell>{null}</Shell>;
  if (!billingLoading && (!subscription || subscription.tierLevel < 1)) return <Shell>{null}</Shell>;

  const renewDateLabel = subscription ? fmtDate(subscription.currentPeriodEnd) : "";

  // Wait for every section's data before rendering, so the page appears in one
  // pass instead of each element popping in as its own fetch resolves. Gate on
  // data PRESENCE (not billingLoading), so a cache-hydrated revisit paints
  // immediately while billing re-validates in the background.
  const dataLoading =
    !subscription || catalogLoading || recLoading || !usageLoaded;

  if (dataLoading) {
    return (
      <Shell>
        <PlanSkeleton />
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="mb-8">
        <div className="text-xs font-semibold uppercase tracking-widest text-stone-500">Your plan</div>
        <h2 className="mt-1 text-3xl font-bold tracking-tight text-stone-50 font-serif">
          {subscription ? subscription.planName : ""}
        </h2>
        {renewDateLabel && <div className="mt-2 text-sm text-stone-400">Renews {renewDateLabel}</div>}
        {subscription && (
          <div className="mt-1 text-xs text-stone-500">{rolloverPolicy(subscription)}</div>
        )}
      </header>

      {subscription?.cancelAtPeriodEnd ? (
        <div className="mb-6 rounded-2xl border border-red-400/40 bg-red-400/8 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-stone-200">
              <span className="font-semibold text-red-300">Subscription ending.</span> Your{" "}
              <span className="font-semibold text-stone-50">{subscription.planName}</span> plan will end
              {subscription.currentPeriodEnd
                ? ` on ${fmtDateFull(subscription.currentPeriodEnd)}`
                : " at the end of your billing period"}
              . You keep full access until then.
            </p>
            <button
              type="button"
              onClick={handleResume}
              disabled={resumingCancel}
              className="shrink-0 text-xs font-semibold text-stone-300 underline hover:text-stone-50 disabled:opacity-50"
            >
              {resumingCancel ? "Updating…" : "Resume subscription"}
            </button>
          </div>
        </div>
      ) : pendingChange ? (
        <div className="mb-6 rounded-2xl border border-amber-400/40 bg-amber-400/8 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-stone-200">
              <span className="font-semibold text-amber-200">Downgrade scheduled.</span>{" "}
              {pendingChange.planName ? (
                <>
                  You&rsquo;ll switch to{" "}
                  <span className="font-semibold text-stone-50">{pendingChange.planName}</span>
                </>
              ) : (
                "Your plan will change"
              )}
              {pendingChange.effectiveAt
                ? ` on ${fmtDateFull(pendingChange.effectiveAt)}`
                : " at the end of your billing period"}
              . You keep {subscription?.planName ?? "your current plan"} until then, at no charge now.
            </p>
            <button
              type="button"
              onClick={handleCancelPending}
              disabled={cancelingPending}
              className="shrink-0 text-xs font-semibold text-stone-300 underline hover:text-stone-50 disabled:opacity-50"
            >
              {cancelingPending ? "Updating…" : "Keep my current plan"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="space-y-6">
          <PlanRecommendation
            data={recommendation}
            loading={recLoading}
            subscription={subscription}
            plans={catalog?.plans ?? []}
            usageAverages={usageAverages}
          />

          <TopupDeflection subscription={subscription} usageAverages={usageAverages} />

          <div className="pt-2">
            <button
              type="button"
              onClick={() => setPlanDrawerOpen((v) => !v)}
              aria-expanded={planDrawerOpen}
              disabled={catalogLoading || !catalog}
              className="text-sm font-semibold text-stone-300 hover:text-stone-50 transition-colors disabled:opacity-50"
            >
              {planDrawerOpen ? "Close plan options" : "Other Plan Options"}
            </button>
          </div>

          <PlanChangeDrawer
            key={planDrawerOpen ? "open" : "closed"}
            open={planDrawerOpen}
            onClose={() => setPlanDrawerOpen(false)}
            plans={catalog?.plans ?? []}
            subscription={subscription}
            tokenBalance={tokenBalance}
            usageAverages={usageAverages}
            onChanged={() => {
              eco?.refresh?.();
            }}
          />
      </div>
    </Shell>
  );
}

// useSearchParams() (read inside PlanPageInner) requires a Suspense boundary
// during prerender, or `next build` fails on this route. Mirror /billing.
export default function PlanPage() {
  return (
    <Suspense fallback={<Shell><PlanSkeleton /></Shell>}>
      <PlanPageInner />
    </Suspense>
  );
}
