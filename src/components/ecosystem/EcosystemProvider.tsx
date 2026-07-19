"use client";

/**
 * Ecosystem context — bridges GraveLens to the shared LowHigh account.
 *
 * On first authenticated load it records the GraveLens "open" (which grants the
 * one-time 100k welcome bonus) and fetches the user's shared token balance. It
 * exposes the balance to consumers (ProfileBadge, AI actions) and provides a
 * centralized "out of tokens" modal so AI routes that 402 can deep-link the
 * user to billing.
 *
 * All of this no-ops gracefully when NEXT_PUBLIC_LOWHIGH_API_BASE is unset, so
 * the app behaves normally before the integration is configured.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  recordAppOpen,
  fetchBilling,
  formatTokens,
  type BillingData,
} from "@/lib/lowhighClient";
import { captureRefFromUrl, attributeStoredRef } from "@/lib/referralClient";
import { pushExplorerPoints, EXPLORER_PROGRESS_EVENT } from "@/lib/cloudSync";
import { createClient } from "@/lib/supabase/browser";
import { loadUnlocks, totalXP, getRank } from "@/lib/achievements";
import type { GraveLensGoal } from "@/lib/goalsTypes";
import {
  readSessionCache,
  writeSessionCache,
  clearSessionCache,
  useIsomorphicLayoutEffect,
} from "@/lib/sessionCache";

interface OutOfTokensInfo {
  available?: number;
  required?: number;
}

/** Low/out-of-tokens alert state, shared by the header bar and the account dot. */
interface TokenAlert {
  level: "low" | "out" | null;
  /** Show the global header bar (active and not dismissed at this level). */
  barVisible: boolean;
  /** Show the persistent dot on the account badge (active but dismissed). */
  dotVisible: boolean;
  /** Dismiss the bar at the current level (the dot persists). */
  dismiss: () => void;
}

/** Redeemable-rewards indicator, shared by the account badge + menu dots. */
interface ClaimableRewards {
  /** Server-confirmed claimable goals (excluding referrals). */
  count: number;
  /** Show the notification dot: server has a claimable reward OR the user's
   *  locally-known rank already crosses an unclaimed rank-reward threshold. */
  dotVisible: boolean;
}

interface EcosystemContextValue {
  loading: boolean;
  /** Available LowHigh tokens, or null if unknown / not configured. */
  availableTokens: number | null;
  billing: BillingData | null;
  refresh: () => Promise<void>;
  /** Re-fetch the shared reward goals (pushes local XP first). Coalesced so
   *  concurrent callers share one round-trip. */
  refreshRewards: () => Promise<void>;
  /** Shared reward goals (GraveLens-visible), or null until first loaded. The
   *  single source of truth — rewards/achievements read this instead of
   *  fetching /api/goals themselves. */
  goals: GraveLensGoal[] | null;
  /** True unless we KNOW the balance is empty (avoid over-blocking when unknown). */
  hasTokens: boolean;
  /** Open the shared "out of tokens" modal (called on a 402 from an AI route). */
  showOutOfTokens: (info?: OutOfTokensInfo) => void;
  /** Running-low / out-of-tokens alert for the global header bar + account dot. */
  tokenAlert: TokenAlert;
  /** Redeemable-rewards indicator for the account-badge + menu dots. */
  claimableRewards: ClaimableRewards;
  /** Subscription-ending indicator (final 7 days) for the account-badge red dot. */
  subscriptionAlert: { expiringSoon: boolean; endsAt: string | null };
  /** Show a brief confirmation toast (e.g. after a plan change). */
  showToast: (message: string) => void;
}

/** Red "plan ending" dot fires only in the final week before a cancellation
 *  takes effect (quiet, state-driven, not dismissible). */
function computeSubscriptionAlert(
  billing: BillingData | null
): { expiringSoon: boolean; endsAt: string | null } {
  const sub = billing?.subscription;
  if (!sub?.cancelAtPeriodEnd || !sub.currentPeriodEnd) return { expiringSoon: false, endsAt: null };
  const end = new Date(sub.currentPeriodEnd).getTime();
  if (Number.isNaN(end)) return { expiringSoon: false, endsAt: null };
  const days = (end - Date.now()) / 86_400_000;
  return { expiringSoon: days >= 0 && days <= 7, endsAt: sub.currentPeriodEnd };
}

const TOKEN_ALERT_KEY = "gl_token_alert_dismissed";
// Last-known billing snapshot, kept in sessionStorage so the balance/plan paint
// instantly on reload (stale-while-revalidate) instead of showing "—" until the
// /api/billing round-trip lands. Scoped to the signed-in user; cleared on
// sign-out.
const BILLING_CACHE_KEY = "gl_billing_cache";
// Last-known reward goals, kept in sessionStorage so the rewards page paints its
// goal sections instantly on reload instead of skeleton-then-fill.
const GOALS_CACHE_KEY = "gl_goals_cache";

/**
 * "out" at zero; "low" when running down.
 *  - Subscribers: under 10% of the monthly allowance (they refill next cycle, so
 *    10% left is a meaningful "you'll run out before renewal" warning).
 *  - Free / reward-only users: no refill, so warn only when nearly out (roughly
 *    one AI action left) rather than a high floor that would nag during normal
 *    use. It's still dismissible-to-a-dot, so never a persistent bar.
 */
function computeAlertLevel(billing: BillingData | null): "low" | "out" | null {
  const avail = billing?.tokenBalance?.availableTokens ?? null;
  if (avail == null) return null;
  if (avail <= 0) return "out";
  const allowance = billing?.subscription?.tokenAllowance ?? null;
  const lowThreshold = allowance && allowance > 0 ? allowance * 0.1 : 50_000;
  return avail < lowThreshold ? "low" : null;
}

const Ctx = createContext<EcosystemContextValue | null>(null);

/** May return null if no provider is mounted — callers should guard. */
export const useEcosystem = () => useContext(Ctx);

export function EcosystemProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [goals, setGoals] = useState<GraveLensGoal[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [welcomeAmount, setWelcomeAmount] = useState<number | null>(null);
  const [oot, setOot] = useState<OutOfTokensInfo | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  // Lazy-init from localStorage (no effect → no cascading render) so a reload
  // doesn't re-nag. Safe against SSR/hydration: dismissal only affects the alert
  // bar, which is hidden on first paint anyway (billing is null until fetched).
  const [alertDismissed, setAlertDismissed] = useState<"low" | "out" | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const v = localStorage.getItem(TOKEN_ALERT_KEY);
      return v === "low" || v === "out" ? v : null;
    } catch {
      return null;
    }
  });
  const openedFor = useRef<string | null>(null);

  // Redeemable-rewards indicator. `rewardsCount` is the server-confirmed count;
  // `unclaimedRankMinRanks` + `localRank` power the optimistic layer so a fresh
  // rank-up lights the dot instantly, before the server round-trip lands.
  const [rewardsCount, setRewardsCount] = useState(0);
  const [unclaimedRankMinRanks, setUnclaimedRankMinRanks] = useState<number[]>([]);
  const [localRank, setLocalRank] = useState(1);
  const lastRewardsRefreshRef = useRef(0);
  const refreshRewardsInFlight = useRef<Promise<void> | null>(null);

  // Clear a stale low/out dismissal once the balance has recovered (e.g. topped
  // up), so the next time they run low the bar shows fresh, not just the dot.
  // Runs in an async callback (not a render-phase effect).
  const clearDismissalIfRecovered = useCallback((b: BillingData | null) => {
    if (computeAlertLevel(b) == null) {
      setAlertDismissed(null);
      try {
        localStorage.removeItem(TOKEN_ALERT_KEY);
      } catch {
        /* ignore */
      }
    }
  }, []);

  // Recompute the locally-known explorer rank from cached achievement unlocks.
  // Cheap (localStorage + pure fns) and safe to call on the client only.
  const recomputeLocalRank = useCallback(() => {
    try {
      setLocalRank(getRank(totalXP(loadUnlocks())).level);
    } catch {
      /* ignore — keep prior rank */
    }
  }, []);

  // Push local XP so the server computes rank from fresh data, then refetch the
  // reward goals and derive the claimable count + unclaimed rank thresholds.
  // Best-effort throughout: on failure we keep the prior indicator (no flicker).
  const refreshRewards = useCallback((): Promise<void> => {
    if (!user) {
      setRewardsCount(0);
      setUnclaimedRankMinRanks([]);
      return Promise.resolve();
    }
    // Coalesce concurrent callers into one round-trip. The provider primes goals
    // on mount and the rewards/achievements pages ask again as they open; without
    // this they'd each push XP + fetch /api/goals separately.
    if (refreshRewardsInFlight.current) return refreshRewardsInFlight.current;
    const run = (async () => {
      lastRewardsRefreshRef.current = Date.now();
      try {
        await pushExplorerPoints(createClient(), user.id);
      } catch {
        /* non-fatal — server may just see a slightly stale rank */
      }
      try {
        const res = await fetch("/api/goals");
        if (!res.ok) return;
        const fetched = ((await res.json())?.goals as GraveLensGoal[]) ?? [];
        const claimable = fetched.filter(
          (g) => g.status === "claimable" && g.requirementType !== "referral_conversion"
        ).length;
        const rankMins = fetched
          .filter((g) => g.minRank != null && g.status !== "claimed")
          .map((g) => g.minRank as number);
        setGoals(fetched);
        setRewardsCount(claimable);
        setUnclaimedRankMinRanks(rankMins);
      } catch {
        /* non-fatal — keep the prior indicator */
      }
    })();
    refreshRewardsInFlight.current = run.finally(() => {
      refreshRewardsInFlight.current = null;
    });
    return refreshRewardsInFlight.current;
  }, [user?.id]);

  const refresh = useCallback(async () => {
    if (!user) {
      setBilling(null);
      return;
    }
    const b = await fetchBilling();
    setBilling(b);
    clearDismissalIfRecovered(b);
    // Subscribing / topping up can unlock rewards — keep the dot in sync with
    // every billing refresh (the /billing/confirmation poll calls this).
    await refreshRewards();
  }, [user?.id, clearDismissalIfRecovered, refreshRewards]);

  // Capture a ?ref=<code> as early as possible (even signed out) so it survives
  // the sign-up flow and can be attributed once the user is authenticated.
  useEffect(() => {
    captureRefFromUrl();
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!user) {
      setBilling(null);
      setGoals(null);
      setRewardsCount(0);
      setUnclaimedRankMinRanks([]);
      setLocalRank(1);
      openedFor.current = null;
      clearSessionCache(BILLING_CACHE_KEY);
      clearSessionCache(GOALS_CACHE_KEY);
      return;
    }
    // Record the open + fetch balance once per signed-in user per mount.
    if (openedFor.current === user.id) return;
    openedFor.current = user.id;

    (async () => {
      setLoading(true);
      const welcome = await recordAppOpen();
      if (!cancelled && welcome?.claimed && welcome.tokenReward > 0) {
        setWelcomeAmount(welcome.tokenReward);
      }
      // Attribute a captured referral now that we have an authenticated user.
      void attributeStoredRef();
      const b = await fetchBilling();
      if (!cancelled) {
        setBilling(b);
        setLoading(false);
        clearDismissalIfRecovered(b);
      }
      // Prime the rewards dot so it's present the moment the app finishes
      // loading (covers rewards already earned, incl. offline rank-ups).
      if (!cancelled) {
        recomputeLocalRank();
        void refreshRewards();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id, clearDismissalIfRecovered, recomputeLocalRank, refreshRewards]);

  // Trigger 2 — a scan just unlocked achievements (fired from ResultPage). Light
  // the dot optimistically from the new local rank, then reconcile with the
  // server. This is what makes a mid-session rank-up feel instant.
  useEffect(() => {
    if (!user) return;
    const onProgress = () => {
      recomputeLocalRank();
      void refreshRewards();
    };
    window.addEventListener(EXPLORER_PROGRESS_EVENT, onProgress);
    return () => window.removeEventListener(EXPLORER_PROGRESS_EVENT, onProgress);
  }, [user?.id, recomputeLocalRank, refreshRewards]);

  // Trigger 4 — safety net. On tab refocus, re-check (throttled to 30s) so the
  // dot self-heals after changes made elsewhere (e.g. another device). Focus
  // only, never a timer — no background polling.
  useEffect(() => {
    if (!user) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRewardsRefreshRef.current < 30_000) return;
      recomputeLocalRank();
      void refreshRewards();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [user?.id, recomputeLocalRank, refreshRewards]);

  // Paint the last-known balance/plan from sessionStorage before the browser
  // paints, so a reload shows real numbers immediately; the mount effect above
  // still refetches and reconciles. Only fills when billing isn't already set.
  useIsomorphicLayoutEffect(() => {
    if (!user || billing) return;
    const snap = readSessionCache<BillingData>(BILLING_CACHE_KEY, user.id);
    if (snap) setBilling(snap);
  }, [user?.id]);

  // Persist every fresh billing snapshot for the next reload.
  useEffect(() => {
    if (user && billing) writeSessionCache<BillingData>(BILLING_CACHE_KEY, user.id, billing);
  }, [user?.id, billing]);

  // Same stale-while-revalidate treatment for reward goals: paint the last-known
  // set before the browser paints, then let refreshRewards() reconcile.
  useIsomorphicLayoutEffect(() => {
    if (!user || goals !== null) return;
    const snap = readSessionCache<GraveLensGoal[]>(GOALS_CACHE_KEY, user.id);
    if (snap) setGoals(snap);
  }, [user?.id]);

  useEffect(() => {
    if (user && goals !== null) writeSessionCache<GraveLensGoal[]>(GOALS_CACHE_KEY, user.id, goals);
  }, [user?.id, goals]);

  const availableTokens = billing?.tokenBalance?.availableTokens ?? null;
  const hasTokens = availableTokens == null ? true : availableTokens > 0;
  const alertLevel = computeAlertLevel(billing);

  // Memoize the context value so consumers (ProfileBadge, token alerts, billing
  // UI) only re-render when the data they read actually changes — not on every
  // provider render (e.g. an unrelated toast open/close).
  const value: EcosystemContextValue = useMemo(
    () => ({
      loading,
      availableTokens,
      billing,
      goals,
      refresh,
      refreshRewards,
      hasTokens,
      showOutOfTokens: (info) => setOot(info ?? {}),
      tokenAlert: {
        level: alertLevel,
        barVisible: alertLevel != null && alertLevel !== alertDismissed,
        dotVisible: alertLevel != null && alertLevel === alertDismissed,
        dismiss: () => {
          if (!alertLevel) return;
          setAlertDismissed(alertLevel);
          try {
            localStorage.setItem(TOKEN_ALERT_KEY, alertLevel);
          } catch {
            /* ignore */
          }
        },
      },
      claimableRewards: {
        count: rewardsCount,
        // Optimistic OR server-confirmed: a stale local read can only ADD a dot,
        // never suppress a real reward.
        dotVisible:
          rewardsCount > 0 || unclaimedRankMinRanks.some((min) => min <= localRank),
      },
      subscriptionAlert: computeSubscriptionAlert(billing),
      showToast: setToastMsg,
    }),
    [
      loading,
      availableTokens,
      billing,
      goals,
      refresh,
      refreshRewards,
      hasTokens,
      alertLevel,
      alertDismissed,
      rewardsCount,
      unclaimedRankMinRanks,
      localRank,
    ]
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {welcomeAmount != null && (
        <WelcomeToast amount={welcomeAmount} onClose={() => setWelcomeAmount(null)} />
      )}
      {oot && <OutOfTokensModal info={oot} onClose={() => setOot(null)} />}
      {toastMsg && <ConfirmToast message={toastMsg} onClose={() => setToastMsg(null)} />}
    </Ctx.Provider>
  );
}

// ── Confirmation toast ────────────────────────────────────────────────────────

function ConfirmToast({ message, onClose }: { message: string; onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  // One-time accent pulse on entry (animate-ping loops, so we remove it after
  // roughly one cycle rather than letting it repeat).
  const [pulse, setPulse] = useState(true);
  useEffect(() => {
    setMounted(true);
    const p = setTimeout(() => setPulse(false), 1000);
    const t = setTimeout(onClose, 6000);
    return () => {
      clearTimeout(p);
      clearTimeout(t);
    };
  }, [onClose]);
  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-x-0 lg:left-56 top-0 z-[10000] flex justify-center px-4 pointer-events-none"
      style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}
    >
      <div
        className="pointer-events-auto max-w-md w-full rounded-2xl px-4 py-3.5 flex items-center gap-3 animate-in fade-in slide-in-from-top-6 zoom-in-95 duration-300 bg-stone-800/95 backdrop-blur-xl border border-[var(--t-gold-500)]/40 ring-1 ring-[var(--t-gold-500)]/10 shadow-[0_16px_48px_rgba(0,0,0,0.55)] text-stone-50"
        role="status"
      >
        <span className="relative shrink-0 w-8 h-8">
          {pulse && (
            <span
              className="absolute inset-0 rounded-full animate-ping"
              style={{ background: "var(--t-gold-500)", opacity: 0.5 }}
              aria-hidden="true"
            />
          )}
          <span
            className="relative w-8 h-8 rounded-full flex items-center justify-center shadow-[0_0_16px_rgba(201,168,76,0.45)]"
            style={{ background: "var(--t-gold-500)" }}
          >
            <Check className="w-4.5 h-4.5 text-[#1a1917]" strokeWidth={3} />
          </span>
        </span>
        <p className="min-w-0 flex-1 text-sm font-medium leading-snug">{message}</p>
        <button
          onClick={onClose}
          aria-label="Dismiss"
          className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-stone-400 hover:text-stone-100 hover:bg-stone-700/60 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>,
    document.body
  );
}

// ── Welcome toast ─────────────────────────────────────────────────────────────

function WelcomeToast({ amount, onClose }: { amount: number; onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    const t = setTimeout(onClose, 8000);
    return () => clearTimeout(t);
  }, [onClose]);
  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-x-0 bottom-6 z-[10000] flex justify-center px-4 pointer-events-none">
      <div
        className="pointer-events-auto max-w-sm w-full rounded-2xl shadow-2xl px-4 py-3.5 flex items-center gap-3 animate-in fade-in slide-in-from-bottom-4 duration-300"
        style={{
          background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))",
          color: "#1a1917",
        }}
        role="status"
      >
        <div className="text-2xl leading-none">🎉</div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-sm">Welcome to GraveLens</p>
          <p className="text-xs opacity-90">
            {formatTokens(amount)} bonus tokens added to your LowHigh balance.
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Dismiss"
          className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-colors hover:bg-black/10"
        >
          ✕
        </button>
      </div>
    </div>,
    document.body
  );
}

// ── Out-of-tokens modal ───────────────────────────────────────────────────────

function OutOfTokensModal({ info, onClose }: { info: OutOfTokensInfo; onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-stone-950/70 backdrop-blur-sm" onPointerDown={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-label="Out of tokens"
        className="relative w-full max-w-sm rounded-3xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-200 p-6 text-center"
        style={{
          background: "linear-gradient(180deg, var(--t-stone-800), var(--t-stone-900))",
          border: "1px solid rgba(var(--glass-bg-rgb), 0.08)",
        }}
      >
        {/* Subtle close affordance, top-right (in addition to backdrop). */}
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 z-10 w-8 h-8 inline-flex items-center justify-center rounded-full text-stone-500 hover:text-stone-200 hover:bg-stone-800/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-500"
        >
          <X className="w-4 h-4" />
        </button>
        <p className="font-serif text-stone-100 font-semibold text-lg mb-2">You&apos;re out of tokens</p>
        <p className="text-stone-400 text-sm leading-relaxed mb-5">
          AI features share your LowHigh token balance. Top up or upgrade your plan to keep
          scanning and generating stories.
        </p>
        <button
          onClick={() => {
            onClose();
            router.push("/topup");
          }}
          className="w-full h-12 rounded-2xl font-semibold text-[#1a1917] text-sm transition-all active:scale-[0.97]"
          style={{ background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }}
        >
          Buy more tokens
        </button>
        <button
          onClick={onClose}
          className="w-full h-11 mt-2 rounded-2xl border border-stone-700 text-stone-400 text-sm font-medium transition-all active:scale-[0.97]"
        >
          Not now
        </button>
      </div>
    </div>,
    document.body
  );
}
