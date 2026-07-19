"use client";

/**
 * GraveLens Balance & Rewards — a re-themed port of LowHigh's BalanceRewardsPage
 * (current-plan card, Ready-to-claim, grouped goal sections, transactions),
 * reading the SHARED goals system filtered to GraveLens via /api/goals. Shows the
 * account-level rewards a GraveLens user qualifies for (account creation,
 * subscribe, referrals) plus GraveLens rank bonuses, and links to lowhigh.ai for
 * the rest. Single centered column so every card shares one width.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Gift, ArrowUpRight, CreditCard, ExternalLink, Wallet } from "lucide-react";
import PageShell from "@/components/layout/PageShell";
import { useAuth } from "@/lib/auth";
import { useEcosystem } from "@/components/ecosystem/EcosystemProvider";
import { openBillingPortal } from "@/lib/billingService";
import { formatTokens, formatTokensExact } from "@/lib/lowhighClient";
import { Card } from "@/components/ui/Card";
import type { GraveLensGoal } from "@/lib/goalsTypes";
import { fetchReferral, type ReferralData } from "@/lib/referralClient";
import { readSessionCache, writeSessionCache, useIsomorphicLayoutEffect } from "@/lib/sessionCache";
import GoalsSection from "@/components/rewards/GoalsSection";
import ReadyToClaim from "@/components/rewards/ReadyToClaim";
import RecentActivity from "@/components/rewards/RecentActivity";
import EstimatedUsesPanel from "@/components/rewards/EstimatedUsesPanel";

const LOWHIGH_REWARDS_URL = "https://www.lowhigh.ai";

// Cold-start placeholder (first-ever visit, no cache): mirrors the hero card +
// two goal sections so the layout doesn't jump when real data lands. Only shown
// when there's genuinely nothing cached to paint.
function RewardsSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" role="status" aria-label="Loading rewards">
      <div className="rounded-2xl border border-white/5 bg-stone-900/50 p-4 sm:p-5 space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2.5">
            <div className="h-2.5 w-24 rounded bg-stone-800" />
            <div className="h-9 w-32 rounded bg-stone-800" />
            <div className="h-2.5 w-20 rounded bg-stone-800" />
          </div>
          <div className="h-5 w-16 rounded bg-stone-800" />
        </div>
        <div className="grid grid-cols-3 gap-4 pt-5 border-t border-stone-800">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2">
              <div className="h-2.5 w-16 rounded bg-stone-800" />
              <div className="h-3.5 w-12 rounded bg-stone-800" />
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="h-9 w-28 rounded-lg bg-stone-800" />
          <div className="h-9 w-44 rounded-lg bg-stone-800" />
        </div>
      </div>
      {[0, 1].map((s) => (
        <div key={s} className="space-y-3">
          <div className="h-2.5 w-32 rounded bg-stone-800" />
          <div className="h-20 rounded-2xl border border-white/5 bg-stone-900/40" />
        </div>
      ))}
      <span className="sr-only">Loading rewards</span>
    </div>
  );
}
const isRank = (g: GraveLensGoal) => g.slug.startsWith("gravelens_rank_");
const isReferral = (g: GraveLensGoal) => g.category === "spread_the_word";

// Goals are owned by the ecosystem provider (one shared, sessionStorage-cached
// fetch). Only referral data is page-local, so that's all we cache here for an
// instant repaint on return; a sign-out/different user invalidates it via userId.
const REFERRAL_CACHE_KEY = "gl_referral_cache";


export default function RewardsPage() {
  const { user, loading: authLoading } = useAuth();
  const eco = useEcosystem();
  const router = useRouter();
  const signedOut = !authLoading && !user;

  // Goals come from the shared ecosystem context; referral is page-local.
  const goals = eco?.goals ?? [];
  const [referral, setReferral] = useState<ReferralData | null>(null);
  const [referralLoaded, setReferralLoaded] = useState(false);
  const [claimingSlug, setClaimingSlug] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);

  // Ready once both halves are known: goals from context (non-null) and referral.
  const loaded = eco?.goals != null && referralLoaded;

  const handlePortal = async () => {
    setPortalBusy(true);
    try {
      await openBillingPortal();
    } catch {
      setPortalBusy(false);
      setFlash("Could not open the billing portal right now.");
    }
  };

  // Paint the cached referral before the browser paints (goals hydrate inside the
  // provider), so a return visit shows the full page with no skeleton flash.
  useIsomorphicLayoutEffect(() => {
    if (!user || referralLoaded) return;
    const snap = readSessionCache<ReferralData>(REFERRAL_CACHE_KEY, user.id);
    if (snap) {
      setReferral(snap);
      setReferralLoaded(true);
    }
  }, [user?.id]);

  // On open, ask the provider to refresh goals (it pushes XP first and coalesces
  // the /api/goals call across consumers) and fetch the page-local referral.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void eco?.refreshRewards?.();
    (async () => {
      const ref = await fetchReferral();
      if (!cancelled) {
        setReferral(ref);
        setReferralLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist referral for the next visit.
  useEffect(() => {
    if (referralLoaded && user && referral) {
      writeSessionCache<ReferralData>(REFERRAL_CACHE_KEY, user.id, referral);
    }
  }, [referralLoaded, referral, user?.id]);

  // Logged-out visitors have no balance or rewards to show — send them to the
  // prospect pricing page rather than a half-rendered rewards shell. Gate on the
  // resolved auth state (signedOut already excludes the authLoading window) so a
  // signed-in user is never bounced during the brief session-restore flash.
  useEffect(() => {
    if (signedOut) router.replace("/billing");
  }, [signedOut, router]);

  const handleClaim = async (slug: string) => {
    setClaimingSlug(slug);
    setFlash(null);
    try {
      const res = await fetch("/api/goals-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        setFlash(`Claimed ${formatTokens(Number(data.claimed?.tokenReward ?? 0))} tokens.`);
        // refresh() re-reads billing AND goals (via refreshRewards), so the
        // claimed reward drops out of the list and the new balance shows.
        await eco?.refresh();
      } else {
        setFlash(data?.error || "Could not claim right now.");
      }
    } catch {
      setFlash("Could not claim right now. Please try again.");
    } finally {
      setClaimingSlug(null);
    }
  };

  const handleShare = async () => {
    if (!referral) return;
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({
          title: "GraveLens",
          text: "Explore and preserve history with me on GraveLens.",
          url: referral.url,
        });
        return;
      } catch {
        /* cancelled / unsupported */
      }
    }
    try {
      await navigator.clipboard.writeText(referral.url);
      setFlash("Referral link copied.");
    } catch {
      /* ignore */
    }
  };

  // ── Partition goals (claimable ones pin to Ready-to-claim, like LowHigh) ──
  const claimable = goals.filter((g) => g.status === "claimable" && !isReferral(g));
  const inReady = new Set(claimable.map((g) => g.slug));
  const accountGoals = goals.filter((g) => !isRank(g) && !isReferral(g) && !inReady.has(g.slug));
  const rankGoals = goals.filter((g) => isRank(g) && !inReady.has(g.slug));
  const referralGoals = goals.filter(isReferral);

  const sub = eco?.billing?.subscription ?? null;
  const bal = eco?.billing?.tokenBalance ?? null;
  const txns = eco?.billing?.recentTransactions ?? [];

  // While the redirect above is in flight, render nothing so the rewards shell
  // never flashes for a logged-out visitor.
  if (signedOut) return null;

  const rolloverLabel = sub
    ? sub.rolloverUncapped
      ? "Unlimited"
      : sub.rolloverCap && sub.rolloverCap > 0
        ? `Up to ${formatTokens(sub.rolloverCap)}`
        : "None"
    : "N/A";

  // Admins get a synthetic 999,999,999 sentinel — show "Unlimited" instead of a
  // fake exact number. Everyone else sees their precise available balance.
  const isAdmin = sub?.status === "admin";
  const heroBalance = isAdmin ? "Unlimited" : formatTokensExact(bal?.availableTokens ?? null);

  return (
    <PageShell
      title="Balance & Rewards"
      icon={<Gift size={20} strokeWidth={2} />}
      backgroundClass="bg-transparent"
      // Full-width main = the whole area scrolls (even over the side gutters);
      // children are centered/capped via the direct-child utilities.
      customMainClasses="w-full px-4 pt-5 pb-44 lg:pb-12 scroll-container flex flex-col items-center"
    >
      <div className="w-full max-w-2xl mx-auto rounded-3xl bg-stone-950/70 border border-white/5 p-3 sm:p-4 space-y-6">
      {!loaded ? (
        <RewardsSkeleton />
      ) : (
        <>
          {/* ── Available balance / current plan (hero) ─────────────── */}
          <Card>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-400">
                  Available balance
                </p>
                <p
                  className="font-serif text-3xl sm:text-4xl font-bold tracking-tight text-stone-50 tabular-nums leading-none mt-2"
                  title={isAdmin ? undefined : formatTokensExact(bal?.availableTokens ?? null)}
                >
                  {heroBalance}
                </p>
                <p className="text-[11px] text-stone-500 mt-1.5">LowHigh tokens</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-serif text-lg font-bold text-stone-200">{sub?.planName ?? "Free"}</span>
                {sub?.status && sub.status !== "admin" && (
                  <span className="px-2 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wider text-stone-300 border-stone-700">
                    {sub.status}
                  </span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4 mt-5 pt-5 border-t border-stone-800">
              {[
                { label: "Monthly tokens", value: sub?.tokenAllowance ? formatTokens(sub.tokenAllowance) : "N/A" },
                {
                  label: "Top-up price",
                  value: sub?.extraTokenPricePerMillionUsd != null ? `$${sub.extraTokenPricePerMillionUsd}/M` : "N/A",
                },
                { label: "Rollover", value: rolloverLabel },
              ].map((s) => (
                <div key={s.label}>
                  <p className="text-[11px] uppercase tracking-wider text-stone-400 leading-snug min-h-[2.4em]">{s.label}</p>
                  <p className="text-sm font-semibold mt-1 text-stone-100">{s.value}</p>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2 mt-5">
              <button
                onClick={() => router.push(sub ? "/plan" : "/billing")}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold border border-stone-700 bg-stone-800 text-stone-200 transition-all active:scale-[0.97]"
              >
                <CreditCard className="w-3.5 h-3.5" /> {sub ? "Change plan" : "Choose a plan"}
              </button>
              {sub && sub.status !== "admin" && (
                <button
                  onClick={handlePortal}
                  disabled={portalBusy}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold border border-stone-700 bg-stone-800 text-stone-200 transition-all active:scale-[0.97] disabled:opacity-60"
                >
                  <Wallet className="w-3.5 h-3.5" /> {portalBusy ? "Opening…" : "Manage payment & invoices"}
                </button>
              )}
              <button
                onClick={() => router.push("/topup")}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all active:scale-[0.97]"
                style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
              >
                <ArrowUpRight className="w-3.5 h-3.5" /> Buy more tokens
              </button>
            </div>
          </Card>

          {/* ── Estimated uses remaining (subtle, collapsed by default) ─── */}
          <EstimatedUsesPanel tokens={Math.max(0, bal?.availableTokens ?? 0)} />

          {flash && (
            <p className="text-xs text-center" style={{ color: "var(--t-gold-500)" }}>
              {flash}
            </p>
          )}

          {/* ── Ready to claim ──────────────────────────────────────── */}
          <ReadyToClaim goals={claimable} claimingSlug={claimingSlug} onClaim={handleClaim} />

          {/* ── Get started (account-level) ─────────────────────────── */}
          <GoalsSection title="Get started" goals={accountGoals} claimingSlug={claimingSlug} onClaim={handleClaim} />

          {/* ── Explorer rank rewards ───────────────────────────────── */}
          <GoalsSection
            title="Explorer rank rewards"
            goals={rankGoals}
            claimingSlug={claimingSlug}
            onClaim={handleClaim}
            footerSlot={
              rankGoals.length > 0 ? (
                <div className="flex justify-center px-1">
                  <Link
                    href="/explorer"
                    className="inline-flex items-center gap-1 text-xs font-semibold hover:underline"
                    style={{ color: "var(--t-gold-500)" }}
                  >
                    View Explorer Page <ArrowUpRight className="w-3 h-3" />
                  </Link>
                </div>
              ) : undefined
            }
          />

          {/* ── Refer friends ───────────────────────────────────────── */}
          <GoalsSection
            title="Refer friends"
            goals={referralGoals}
            claimingSlug={claimingSlug}
            onClaim={handleClaim}
            referralUrl={referral?.url ?? null}
            onShare={handleShare}
            footerSlot={
              referral ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl p-3 text-center border border-stone-700/70 bg-stone-900/50">
                    <p className="text-lg font-bold font-serif" style={{ color: "var(--t-gold-500)" }}>
                      {referral.stats.paid}
                    </p>
                    <p className="text-[0.7rem] uppercase tracking-wide text-stone-400 mt-0.5">Subscribed</p>
                  </div>
                  <div className="rounded-xl p-3 text-center border border-stone-700/70 bg-stone-900/50">
                    <p className="text-lg font-bold font-serif text-stone-300">{referral.stats.pending}</p>
                    <p className="text-[0.7rem] uppercase tracking-wide text-stone-400 mt-0.5">Pending</p>
                  </div>
                </div>
              ) : null
            }
          />

          {/* ── Recent activity (distinct collapsible ledger) ───────────── */}
          <RecentActivity transactions={txns} />

          {/* ── More ways to earn at lowhigh.ai ─────────────────────── */}
          <Card>
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-stone-100">More ways to earn rewards</p>
                <p className="text-xs text-stone-400 mt-0.5">
                  GraveLens shares your LowHigh account. Visit LowHigh for the full rewards catalog.
                </p>
              </div>
              <a
                href={LOWHIGH_REWARDS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-bold transition-all active:scale-[0.97]"
                style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
              >
                Visit LowHigh <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </Card>
        </>
      )}
      </div>
    </PageShell>
  );
}
