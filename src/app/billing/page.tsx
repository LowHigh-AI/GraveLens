"use client";

/**
 * GraveLens Pricing page — /billing
 *
 * The prospect-facing pricing surface, ported from LowHigh's PricingPage (hero,
 * annual-first billing toggle, rich plan cards, top-up callout, usage breakdown,
 * FAQ, and a "how tokens work" explainer), restyled into GraveLens's warm stone
 * + gold theme and rendered inside the app chrome (PageShell).
 *
 * Signed-out visitors see the full pricing with "Sign in to subscribe" CTAs.
 * Active subscribers are redirected to /plan (Change Plan) — mirroring LowHigh's
 * prospect→plan redirect; pass ?as_prospect=1 to view this page anyway. The
 * logged-in management surfaces are /plan (change plan) and /topup (buy tokens).
 *
 * 100% data-driven from the shared billing catalog — no plan names, prices, or
 * token allowances are hardcoded. Stripe redirects return here with
 * ?status=success|canceled.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useEcosystem } from "@/components/ecosystem/EcosystemProvider";
import PageShell from "@/components/layout/PageShell";
import { Banner } from "@/components/ui/Banner";
import {
  fetchPlansCatalog,
  startSubscriptionCheckout,
  startTopupCheckout,
  openBillingPortal,
  type PlansCatalog,
  type SubscriptionPlanOption,
} from "@/lib/billingService";

const ACTIVE_STATUSES = ["active", "trialing", "lifetime"];
const usd = (n: number | null | undefined) =>
  n == null ? "—" : `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** Compact token count: 1.5M / 500K. */
const fmtMillions = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`
    : `${(n / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })}K`;

/** Plain-dollar formatter for price headlines (no trailing .00). */
const fmtPrice = (n: number) => {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(2);
};

const rolloverLabel = (plan: SubscriptionPlanOption): string => {
  if (plan.rolloverUncapped) return "Unlimited rollover";
  if (plan.rolloverCap && plan.rolloverCap > 0) {
    return `Rollover up to ${fmtMillions(plan.rolloverCap)} unused tokens`;
  }
  return "No rollover";
};

/** The recommended tier: prefer "plus", else the middle plan when 3+ exist. */
function pickPopularSlug(plans: SubscriptionPlanOption[]): string | null {
  const plus = plans.find((p) => p.slug === "plus");
  if (plus) return plus.slug;
  if (plans.length >= 3) return plans[1].slug;
  return null;
}

// ─── Static content ─────────────────────────────────────────────────────────

const FAQ: { q: string; a: string }[] = [
  {
    q: "What is a token?",
    a: "Tokens are the unit LowHigh uses to bill AI features. In GraveLens, every gravestone scan, research lookup, life story, and narration draws from your shared LowHigh balance. Your plan includes a monthly allowance, and you can top up any time.",
  },
  {
    q: "How are tokens spent?",
    a: "Each AI action consumes tokens. Reading a weathered stone, researching a life, writing a memorial story, and narrating it all cost tokens based on length and complexity. Your remaining balance is always shown at the top of this page.",
  },
  {
    q: "Does my plan only work in GraveLens?",
    a: "No. GraveLens shares one balance with your LowHigh account, so the tokens in your plan work in every LowHigh app. You subscribe once and it covers all of them.",
  },
  {
    q: "What happens if I run out of tokens?",
    a: "AI features pause until you top up or your next billing period starts. Everything already saved to your archive stays accessible offline. You can buy additional tokens at any time.",
  },
  {
    q: "Do unused tokens roll over?",
    a: "Plus subscribers carry unused tokens over up to a cap. Premium subscribers carry over with no cap. Starter does not roll over.",
  },
  {
    q: "Can I top up between billing cycles?",
    a: "Yes. Buy additional tokens any time from the top-up section below. Plus and Premium subscribers pay a lower per-million rate.",
  },
  {
    q: "Can I switch plans or cancel any time?",
    a: "Yes. Upgrade, downgrade, or cancel any time through Stripe. Changes take effect at your next billing cycle. Your GraveLens subscription is the same LowHigh account you use everywhere.",
  },
];

const HOW_IT_WORKS = [
  "Every AI action spends tokens, whether you're in GraveLens or any other LowHigh app. Length and complexity set the cost.",
  "Your plan refills the same balance each billing cycle. Higher tiers carry unused tokens forward.",
  "Need more before the next refill? Top up at your tier's rate, any time.",
];

/** Rough per-action token costs for the "what you get" estimate. Estimates only. */
const USAGE_ESTIMATES: { label: string; perUse: number }[] = [
  { label: "Gravestone scans", perUse: 10_000 },
  { label: "Cultural & historical context", perUse: 18_000 },
  { label: "Voice narrations", perUse: 12_000 },
  { label: "Life research lookups", perUse: 25_000 },
  { label: "AI memorial stories", perUse: 35_000 },
];

// ─── Small presentational pieces ──────────────────────────────────────────────

function Check() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-[var(--t-gold-500)] shrink-0 mt-0.5"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/** Thin meter showing a plan's allowance relative to the largest plan. */
function TokenScaleBar({ allowance, max, isPopular }: { allowance: number; max: number; isPopular: boolean }) {
  const pct = max > 0 ? Math.max(3, Math.round((allowance / max) * 100)) : 0;
  return (
    <div className="mt-3 h-1 rounded-full bg-stone-700/60 overflow-hidden" aria-hidden="true">
      <div
        className={`h-full rounded-full transition-[width] duration-700 ease-out ${
          isPopular ? "bg-[var(--t-gold-500)]" : "bg-stone-500"
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function PeriodToggle({
  period,
  onChange,
  savingsPct,
}: {
  period: "monthly" | "annual";
  onChange: (p: "monthly" | "annual") => void;
  savingsPct?: number;
}) {
  return (
    <div
      role="group"
      aria-label="Billing period"
      className="inline-flex items-center gap-1 p-1 rounded-full border border-stone-700 bg-stone-900/70 backdrop-blur-xl"
    >
      {(["monthly", "annual"] as const).map((p) => {
        const active = period === p;
        return (
          <button
            key={p}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(p)}
            className={`flex items-center gap-1.5 px-5 py-1.5 rounded-full text-xs font-semibold uppercase tracking-wide transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)] focus-visible:ring-offset-1 focus-visible:ring-offset-stone-900 ${
              active ? "text-[#1a1917] shadow-sm" : "text-stone-400 hover:text-stone-200"
            }`}
            style={
              active
                ? { background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }
                : undefined
            }
          >
            {p === "monthly" ? "Monthly" : "Annual"}
            {p === "annual" && savingsPct ? (
              <span className={active ? "text-[#1a1917]/80" : "text-[var(--t-gold-400)]"}>-{savingsPct}%</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ─── Plan Carousel (mobile/tablet) ───────────────────────────────────────────

/** Wraps the plan cards in a horizontal scroll-snap track below `lg` and shows
 *  directional arrows only when the track can actually scroll that way. At `lg`+
 *  the children lay out as a grid (no overflow) so the arrows stay hidden. */
function PlanCarousel({ children }: { children: React.ReactNode }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [update]);

  const scrollByDir = (dir: -1 | 1) => {
    const el = trackRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <div className="relative">
      <div
        ref={trackRef}
        role="group"
        aria-label="Subscription plans"
        className="flex lg:grid lg:grid-cols-3 gap-4 items-stretch overflow-x-auto lg:overflow-visible snap-x snap-mandatory lg:snap-none -mx-4 px-4 lg:mx-0 lg:px-0 pt-4 lg:pt-0 pb-2 lg:pb-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      {canLeft && <CarouselArrow dir="left" onClick={() => scrollByDir(-1)} />}
      {canRight && <CarouselArrow dir="right" onClick={() => scrollByDir(1)} />}
    </div>
  );
}

function CarouselArrow({ dir, onClick }: { dir: "left" | "right"; onClick: () => void }) {
  const isLeft = dir === "left";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={isLeft ? "Scroll to previous plans" : "Scroll to more plans"}
      className={`lg:hidden absolute top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full flex items-center justify-center border border-stone-600 bg-stone-900/85 backdrop-blur text-stone-100 shadow-lg transition-transform active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)] focus-visible:ring-offset-2 focus-visible:ring-offset-stone-900 ${
        isLeft ? "left-1" : "right-1"
      }`}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {isLeft ? <polyline points="15 18 9 12 15 6" /> : <polyline points="9 18 15 12 9 6" />}
      </svg>
    </button>
  );
}

// ─── Plan Card ────────────────────────────────────────────────────────────────

function PlanCard({
  plan,
  period,
  isCurrent,
  isPopular,
  isSelected,
  maxAllowance,
  index,
  signedOut,
  busySub,
  busyManage,
  onSubscribe,
  onManage,
}: {
  plan: SubscriptionPlanOption;
  period: "monthly" | "annual";
  isCurrent: boolean;
  isPopular: boolean;
  isSelected: boolean;
  maxAllowance: number;
  index: number;
  signedOut: boolean;
  busySub: boolean;
  busyManage: boolean;
  onSubscribe: () => void;
  onManage: () => void;
}) {
  const annualSupported = plan.priceAnnual != null && plan.priceAnnualTotal != null;
  const showAnnual = period === "annual" && annualSupported;
  const headlinePerMonth = showAnnual ? plan.priceAnnual : plan.priceMonthly;
  const yearlySavings =
    showAnnual && plan.priceMonthly != null && plan.priceAnnualTotal != null
      ? Math.max(0, plan.priceMonthly * 12 - plan.priceAnnualTotal)
      : 0;

  return (
    <div className="relative h-full animate-in fade-in slide-in-from-bottom-2 duration-300" style={{ animationDelay: `${index * 70}ms` }}>
      {isPopular && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-10">
          <div
            className="flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide text-[#1a1917] shadow-lg"
            style={{ background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2l2.9 6.3 6.9.7-5.1 4.7 1.4 6.8L12 17.8 5.9 21.3l1.4-6.8L2.2 9.7l6.9-.7L12 2z" />
            </svg>
            Most Popular
          </div>
        </div>
      )}

      <div
        className={`h-full flex flex-col rounded-2xl p-6 border backdrop-blur-xl transition-all duration-300 ${
          isPopular
            ? "border-[var(--t-gold-600)] bg-stone-900/80 shadow-[0_0_44px_-14px_rgba(201,168,76,0.35)]"
            : "border-stone-700/70 bg-stone-900/65"
        } ${isSelected ? "ring-2 ring-[var(--t-gold-500)]/70" : ""}`}
      >
        {/* Name + savings */}
        <div className="mb-4 flex items-center justify-between gap-2">
          <h3 className="text-base font-serif font-bold text-stone-50">{plan.name}</h3>
          {showAnnual && yearlySavings > 0 && (
            <span className="text-[11px] font-semibold text-[var(--t-gold-400)] bg-[rgba(201,168,76,0.10)] border border-[var(--t-gold-600)]/40 px-2 py-0.5 rounded-full">
              Save ${fmtPrice(yearlySavings)}/yr
            </span>
          )}
        </div>

        {/* Price */}
        <div className="flex items-end gap-1.5">
          {showAnnual && plan.priceMonthly != null && (
            <span className="text-2xl font-semibold text-stone-500 line-through pb-1">${fmtPrice(plan.priceMonthly)}</span>
          )}
          <span className="font-serif text-4xl font-bold text-stone-50 leading-none">
            {headlinePerMonth == null ? "—" : `$${fmtPrice(headlinePerMonth)}`}
          </span>
          <span className="text-stone-400 text-sm pb-1">/mo</span>
        </div>
        {showAnnual && plan.priceAnnualTotal != null ? (
          <p className="mt-1 text-xs text-stone-300 font-semibold">${fmtPrice(plan.priceAnnualTotal)} billed yearly</p>
        ) : (
          <p className="mt-1 text-xs text-stone-500">billed monthly</p>
        )}

        {/* Token allowance + scale */}
        <div className="mt-5 mb-4">
          <div className="flex items-baseline gap-2">
            <span
              className={`font-serif text-3xl font-bold leading-none ${
                isPopular ? "text-[var(--t-gold-400)]" : "text-stone-50"
              }`}
            >
              {fmtMillions(plan.tokenAllowance)}
            </span>
            <span className="text-xs text-stone-500 uppercase tracking-wider font-semibold">tokens / mo</span>
          </div>
          <TokenScaleBar allowance={plan.tokenAllowance} max={maxAllowance} isPopular={isPopular} />
        </div>

        {/* Value lines */}
        <ul className="mb-6 space-y-1.5">
          <li className="flex items-start gap-1.5 text-xs text-stone-300">
            <Check />
            {rolloverLabel(plan)}
          </li>
          {plan.extraTokenPricePerMillionUsd != null && (
            <li className="flex items-start gap-1.5 text-xs text-stone-300">
              <Check />
              <span>
                <span className="text-stone-500">Additional tokens: </span>
                <span className="font-semibold">${plan.extraTokenPricePerMillionUsd}</span>
                <span className="text-stone-500"> / million</span>
              </span>
            </li>
          )}
          {plan.features?.slice(0, 4).map((f, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs text-stone-400">
              <Check />
              {f}
            </li>
          ))}
        </ul>

        {/* CTA */}
        {isCurrent ? (
          <button
            type="button"
            onClick={onManage}
            disabled={busyManage}
            className="w-full mt-auto py-2.5 rounded-xl text-sm font-semibold border border-stone-700 bg-stone-800/80 text-stone-200 transition-all active:scale-[0.97] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)] focus-visible:ring-offset-2 focus-visible:ring-offset-stone-900"
          >
            {busyManage ? "Opening…" : "Manage subscription"}
          </button>
        ) : (
          <button
            type="button"
            onClick={onSubscribe}
            disabled={busySub}
            className={`w-full mt-auto py-2.5 rounded-xl text-sm font-semibold transition-all active:scale-[0.97] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)] focus-visible:ring-offset-2 focus-visible:ring-offset-stone-900 ${
              isPopular ? "text-[#1a1917]" : "border border-stone-700 bg-stone-800/80 text-stone-200"
            }`}
            style={
              isPopular
                ? { background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }
                : undefined
            }
          >
            {signedOut ? "Sign in to subscribe" : busySub ? "Redirecting…" : `Choose ${plan.name}`}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Usage breakdown ("what you get") ─────────────────────────────────────────

function UsageEstimate({ tokens }: { tokens: number }) {
  return (
    <div
      aria-live="polite"
      className="rounded-2xl border border-stone-700/70 bg-stone-900/65 backdrop-blur-xl p-6"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
        {USAGE_ESTIMATES.map((u) => {
          const uses = Math.floor(tokens / u.perUse);
          return (
            <div key={u.label} className="flex items-center justify-between gap-3">
              <span className="text-sm text-stone-300">{u.label}</span>
              <span className="text-sm font-serif font-semibold text-[var(--t-gold-400)] tabular-nums">
                ~{uses.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-5 text-[11px] text-stone-500 leading-relaxed">
        Estimates based on typical usage. Actual cost varies with image quality, story length, and how much
        research a life requires. It all comes from the same balance you spend across every LowHigh app.
      </p>
    </div>
  );
}

// ─── FAQ ──────────────────────────────────────────────────────────────────────

function FaqItem({ q, a, isOpen, onToggle }: { q: string; a: string; isOpen: boolean; onToggle: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="w-full flex items-center justify-between gap-4 py-4 px-5 text-left rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--t-gold-500)]"
      >
        <span className="text-sm font-semibold text-stone-100">{q}</span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-stone-500 shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {isOpen && (
        <p className="px-5 pb-4 -mt-1 text-sm text-stone-400 leading-relaxed animate-in fade-in slide-in-from-top-1 duration-200">
          {a}
        </p>
      )}
    </div>
  );
}

// ─── Page shell wrapper ───────────────────────────────────────────────────────

/** Renders inside the app chrome (sidebar + header + bottom nav). The shell is
 *  transparent so the global memorial background shows behind the content. */
function Shell({ children, scrollRef }: { children: React.ReactNode; scrollRef?: React.Ref<HTMLDivElement> }) {
  return (
    <PageShell
      backgroundClass="bg-transparent"
      title="Pricing"
      icon={
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <line x1="2" y1="10" x2="22" y2="10" />
        </svg>
      }
    >
      <div
        ref={scrollRef}
        className="w-full max-w-5xl mx-auto px-4 py-6 sm:py-8 rounded-3xl bg-stone-950/70 border border-white/5"
      >
        {children}
      </div>
    </PageShell>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function BillingInner() {
  const { user, loading: authLoading } = useAuth();
  const eco = useEcosystem();
  const router = useRouter();
  const params = useSearchParams();
  const topRef = useRef<HTMLDivElement>(null);

  const [catalog, setCatalog] = useState<PlansCatalog | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<"monthly" | "annual">("annual");
  const [previewSlug, setPreviewSlug] = useState<string | null>(null);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const status = params.get("status");
  const billing = eco?.billing ?? null;
  const sub = billing?.subscription ?? null;
  const isSubscribed = !!sub && ACTIVE_STATUSES.includes(sub.status);
  const currentTier = sub?.tierLevel ?? 0;

  useEffect(() => {
    fetchPlansCatalog().then(setCatalog);
  }, []);

  // Returning from Stripe — refresh the shared balance.
  useEffect(() => {
    if (status === "success" && eco) eco.refresh();
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(async (key: string, fn: () => Promise<void>) => {
    setError(null);
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }, []);

  const sortedPlans = useMemo(
    () => (catalog ? [...catalog.plans].sort((a, b) => a.sortOrder - b.sortOrder) : []),
    [catalog]
  );
  const popularSlug = useMemo(() => pickPopularSlug(sortedPlans), [sortedPlans]);
  const maxAllowance = useMemo(() => Math.max(0, ...sortedPlans.map((p) => p.tokenAllowance)), [sortedPlans]);
  const annualSavingsPct = useMemo(
    () =>
      Math.max(
        0,
        ...sortedPlans.map((p) =>
          p.priceMonthly && p.priceAnnualTotal
            ? Math.round((1 - p.priceAnnualTotal / (p.priceMonthly * 12)) * 100)
            : 0
        )
      ),
    [sortedPlans]
  );

  // Derive the active preview slug: the user's pick if it's a real plan,
  // otherwise fall back to the recommended (or first) plan. Derived rather than
  // stored so it never needs an effect to stay in sync with the loaded catalog.
  const effectivePreviewSlug = useMemo(() => {
    if (previewSlug && sortedPlans.some((p) => p.slug === previewSlug)) return previewSlug;
    return popularSlug ?? sortedPlans[0]?.slug ?? null;
  }, [previewSlug, sortedPlans, popularSlug]);

  const previewPlan = useMemo(
    () => sortedPlans.find((p) => p.slug === effectivePreviewSlug) ?? null,
    [sortedPlans, effectivePreviewSlug]
  );

  const scrollTop = () => topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  // Mirror LowHigh: active subscribers belong on the Change Plan page. Free and
  // signed-out visitors stay here and see the prospect pricing. `?as_prospect=1`
  // lets a subscriber preview this page anyway.
  const asProspect = params.get("as_prospect") === "1";
  const signedOut = !authLoading && !user;
  useEffect(() => {
    if (!authLoading && user && isSubscribed && !asProspect) router.replace("/plan");
  }, [authLoading, user, isSubscribed, asProspect, router]);

  return (
    <Shell scrollRef={topRef}>
      <div className="max-w-3xl mx-auto">
        {status === "success" && <Banner tone="gold">Payment complete. Your balance is updated.</Banner>}
        {status === "canceled" && <Banner tone="stone">Checkout canceled. No changes were made.</Banner>}
        {error && <Banner tone="stone">{error}</Banner>}
      </div>

      {/* Hero — h2 because PageShell already renders the page's single <h1>. */}
      <section className="text-center mb-8">
        <h2 className="font-serif text-4xl sm:text-5xl font-bold tracking-tight text-stone-50">Plans &amp; Pricing</h2>
        <div
          className="mx-auto mt-4 h-px w-16"
          style={{ background: "linear-gradient(to right, transparent, var(--t-gold-500), transparent)" }}
          aria-hidden="true"
        />
        <p className="mt-4 text-stone-300 text-sm whitespace-nowrap">
          Add AI functionality to GraveLens. Use your tokens in any LowHigh app.
        </p>
      </section>

      {/* Billing cycle toggle */}
      {sortedPlans.length > 0 && (
        <div className="flex justify-center mb-10">
          <PeriodToggle period={period} onChange={setPeriod} savingsPct={annualSavingsPct} />
        </div>
      )}

      {/* Plan cards */}
      <section className="max-w-5xl mx-auto mb-20">
        {!catalog ? (
          <p className="text-center text-stone-500 text-sm py-12">Loading plans…</p>
        ) : sortedPlans.length === 0 ? (
          <p className="text-center text-stone-500 text-sm py-12">No plans available right now. Please check back shortly.</p>
        ) : (
          // Below lg: horizontal scroll-snap carousel with directional arrows.
          // lg+: equal-height 3-across grid (handled inside PlanCarousel).
          <PlanCarousel>
            {sortedPlans.map((p, i) => (
              <div key={p.id} className="snap-center shrink-0 w-[85%] sm:w-[48%] lg:w-auto h-full">
                <PlanCard
                  plan={p}
                  period={period}
                  isCurrent={isSubscribed && p.tierLevel === currentTier}
                  isPopular={p.slug === popularSlug}
                  isSelected={p.slug === effectivePreviewSlug}
                  maxAllowance={maxAllowance}
                  index={i}
                  signedOut={signedOut}
                  busySub={busy === `sub:${p.slug}`}
                  busyManage={busy === "portal"}
                  onSubscribe={() =>
                    signedOut
                      ? router.push("/login?next=/billing")
                      : run(`sub:${p.slug}`, async () => {
                          const outcome = await startSubscriptionCheckout(
                            p.slug as "starter" | "plus" | "premium",
                            period
                          );
                          // A scheduled downgrade doesn't navigate; send the user
                          // to /plan to see the pending-change banner.
                          if (outcome?.scheduled) router.push("/plan");
                        })
                  }
                  onManage={() => run("portal", openBillingPortal)}
                />
              </div>
            ))}
          </PlanCarousel>
        )}
      </section>

      {/* Top-up callout + packages */}
      {catalog && catalog.packages.length > 0 && (
        <section className="max-w-3xl mx-auto mb-20 text-center">
          <h2 className="font-serif text-2xl font-bold text-stone-50 mb-2">Don&rsquo;t miss a beat.</h2>
          <p className="text-sm text-stone-400 max-w-md mx-auto mb-8">Add more tokens whenever you need them.</p>
          <div className="flex flex-wrap justify-center gap-3">
            {[...catalog.packages]
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((pkg) => (
                <button
                  key={pkg.id}
                  type="button"
                  onClick={() => run(`top:${pkg.id}`, () => startTopupCheckout({ packageId: pkg.id }))}
                  disabled={busy === `top:${pkg.id}`}
                  className="w-[150px] rounded-2xl p-4 border border-stone-700/70 bg-stone-900/65 backdrop-blur-xl text-left transition-all active:scale-[0.98] hover:border-[var(--t-gold-600)]/60 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)] focus-visible:ring-offset-2 focus-visible:ring-offset-stone-900"
                >
                  <p className="text-stone-50 font-serif font-semibold">{fmtMillions(pkg.tokenAmount)}</p>
                  <p className="text-stone-400 text-xs mt-0.5">{pkg.name}</p>
                  <p className="text-[var(--t-gold-400)] text-sm font-medium mt-2">{usd(pkg.basePriceUsd)}</p>
                </button>
              ))}
          </div>
        </section>
      )}

      {/* What you get */}
      {previewPlan && (
        <section className="max-w-3xl mx-auto mb-20">
          <p className="text-center text-xs uppercase tracking-[0.18em] text-stone-500 mb-4">
            What you get with{" "}
            <span className="text-[var(--t-gold-400)] font-semibold">{previewPlan.name}</span>
          </p>
          {sortedPlans.length > 1 && (
            <div
              role="group"
              aria-label="Preview token usage by plan"
              className="flex flex-wrap justify-center gap-2 mb-5"
            >
              {sortedPlans.map((p) => {
                const active = p.slug === effectivePreviewSlug;
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setPreviewSlug(p.slug)}
                    className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)] focus-visible:ring-offset-1 focus-visible:ring-offset-stone-900 ${
                      active
                        ? "border-[var(--t-gold-600)] text-[var(--t-gold-400)] bg-[rgba(201,168,76,0.10)]"
                        : "border-stone-700 text-stone-400 hover:text-stone-200"
                    }`}
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
          )}
          <UsageEstimate tokens={previewPlan.tokenAllowance} />
        </section>
      )}

      {/* FAQ */}
      <section className="max-w-3xl mx-auto mb-20">
        <h2 className="font-serif text-2xl font-bold text-stone-50 text-center mb-8">Frequently asked questions</h2>
        <div className="rounded-2xl border border-stone-700/70 bg-stone-900/65 backdrop-blur-xl divide-y divide-stone-800">
          {FAQ.map((item, i) => (
            <FaqItem
              key={i}
              q={item.q}
              a={item.a}
              isOpen={openFaq === i}
              onToggle={() => setOpenFaq(openFaq === i ? null : i)}
            />
          ))}
        </div>
      </section>

      {/* How tokens work */}
      <section className="max-w-4xl mx-auto mb-16">
        <h2 className="font-serif text-2xl font-bold text-stone-50 text-center mb-8">How tokens work</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-x-10 gap-y-8">
          {HOW_IT_WORKS.map((text, i) => (
            <div key={i}>
              <div className="h-px w-8 bg-[var(--t-gold-500)] mb-3" aria-hidden="true" />
              <p className="text-sm text-stone-400 leading-relaxed">{text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Return to top */}
      <div className="flex justify-center pb-4">
        <button
          type="button"
          onClick={scrollTop}
          className="rounded-md px-2 py-1 text-xs text-stone-400 hover:text-stone-200 transition-colors uppercase tracking-[0.18em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)] focus-visible:ring-offset-2 focus-visible:ring-offset-stone-900"
        >
          Return to top
        </button>
      </div>
    </Shell>
  );
}

export default function BillingPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-stone-500 text-sm">Loading…</div>}>
      <BillingInner />
    </Suspense>
  );
}
