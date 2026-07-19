"use client";

/**
 * GraveLens Purchase Confirmation — /billing/confirmation?session_id=cs_...
 *
 * Where Stripe Checkout returns after a successful subscription or top-up. The
 * itemized purchase is read straight from the Stripe Checkout Session (via
 * /api/billing/confirmation), so it is authoritative and shows immediately —
 * even before the fulfillment webhook has credited the tokens.
 *
 * The "tokens added / new balance" section is eventually consistent: it polls
 * eco.refresh() until the credit lands (balance increases, or a matching recent
 * ledger row appears), then shows the new balance. If the webhook lags past the
 * poll window it degrades to a calm "your balance will update shortly" message —
 * never an error, because Stripe already confirmed the payment.
 */

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, ArrowRight } from "lucide-react";
import PageShell from "@/components/layout/PageShell";
import { Card, CardLabel } from "@/components/ui/Card";
import { useEcosystem } from "@/components/ecosystem/EcosystemProvider";
import { fetchConfirmation } from "@/lib/billingService";
import { formatTokens, type ConfirmationDetail } from "@/lib/lowhighClient";
import { fmtDate } from "@/lib/format";

const MAX_POLLS = 10;
const POLL_MS = 2000;
const RECENT_WINDOW_MS = 10 * 60 * 1000;

const fmtMoney = (cents: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: (currency || "usd").toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <PageShell backgroundClass="bg-transparent" title="Purchase confirmed" icon={<CheckCircle2 className="w-5 h-5" />}>
      <div className="w-full max-w-lg mx-auto px-4 py-8 space-y-4">{children}</div>
    </PageShell>
  );
}

function ConfirmationInner() {
  const eco = useEcosystem();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConfirmationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [credited, setCredited] = useState(false);
  const [pollDone, setPollDone] = useState(false);

  // Latest eco snapshot for use inside the polling closure, plus the balance
  // captured on first paint (before any credit) for delta detection.
  const ecoRef = useRef(eco);
  ecoRef.current = eco;
  const baselineRef = useRef<number | null>(null);
  const baselineSet = useRef(false);
  if (!baselineSet.current) {
    baselineRef.current = eco?.billing?.tokenBalance?.availableTokens ?? null;
    baselineSet.current = true;
  }

  // Read session_id on the client (useSearchParams would also work; this keeps
  // the Suspense boundary purely for hydration timing).
  useEffect(() => {
    setSessionId(new URLSearchParams(window.location.search).get("session_id"));
  }, []);

  // Fetch the authoritative purchase detail.
  useEffect(() => {
    if (sessionId === null) return; // not read yet
    if (!sessionId) {
      setLoading(false);
      return;
    }
    let alive = true;
    fetchConfirmation(sessionId).then((d) => {
      if (alive) {
        setDetail(d);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const isCredited = () => {
    const bal = eco?.billing?.tokenBalance?.availableTokens ?? null;
    const base = baselineRef.current;
    if (bal != null && base != null && bal > base) return true;
    const txs = eco?.billing?.recentTransactions ?? [];
    const now = Date.now();
    const wantType = detail?.kind === "topup" ? "top_up" : "allocation";
    return txs.some(
      (t) => t.type === wantType && now - new Date(t.created_at).getTime() < RECENT_WINDOW_MS
    );
  };

  // React to balance changes: mark credited as soon as the ledger reflects it.
  useEffect(() => {
    if (!detail?.paid || credited) return;
    if (isCredited()) setCredited(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eco?.billing, detail, credited]);

  // Drive polling: pump eco.refresh() until credited or the window elapses.
  useEffect(() => {
    if (!detail?.paid || credited) return;
    let attempts = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const pump = async () => {
      if (stopped) return;
      attempts += 1;
      await ecoRef.current?.refresh();
      if (stopped) return;
      if (attempts >= MAX_POLLS) {
        setPollDone(true);
        return;
      }
      timer = setTimeout(pump, POLL_MS);
    };
    timer = setTimeout(pump, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [detail, credited]);

  if (loading) {
    return (
      <Shell>
        <Card>
          <div className="flex items-center gap-3 text-stone-300 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading your confirmation…
          </div>
        </Card>
      </Shell>
    );
  }

  if (!detail) {
    return (
      <Shell>
        <Card>
          <CardLabel>Confirmation unavailable</CardLabel>
          <p className="text-sm text-stone-300">
            We couldn&apos;t load this purchase. If you were charged, your payment is safe and your
            balance updates automatically. Check your Recent Activity in a minute.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href="/billing/history"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold border border-stone-700 bg-stone-800 text-stone-200 transition-all active:scale-[0.97]"
            >
              Recent activity
            </Link>
            <Link
              href="/rewards"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold border border-stone-700 bg-stone-800 text-stone-200 transition-all active:scale-[0.97]"
            >
              Balance &amp; rewards
            </Link>
          </div>
        </Card>
      </Shell>
    );
  }

  if (!detail.paid) {
    return (
      <Shell>
        <Card>
          <CardLabel>Payment not completed</CardLabel>
          <p className="text-sm text-stone-300">
            This checkout hasn&apos;t completed yet. No tokens have been added. You can try again
            from the pricing page.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href="/billing"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold border border-stone-700 bg-stone-800 text-stone-200 transition-all active:scale-[0.97]"
            >
              Back to pricing
            </Link>
          </div>
        </Card>
      </Shell>
    );
  }

  const isTopup = detail.kind === "topup";

  return (
    <Shell>
      {/* Success header */}
      <div className="flex items-center gap-3">
        <CheckCircle2 className="w-7 h-7 shrink-0" style={{ color: "var(--t-gold-500)" }} />
        <div>
          <h2 className="font-serif text-xl font-bold text-stone-50">
            {isTopup ? "Top-up confirmed" : "Subscription confirmed"}
          </h2>
          <p className="text-xs text-stone-400">
            {isTopup ? "Your tokens are on the way." : "Your subscription is active."}
          </p>
        </div>
      </div>

      {/* Itemized purchase (authoritative, from Stripe) */}
      <Card>
        <CardLabel>{isTopup ? "Top-up" : detail.planName ?? "Subscription"}</CardLabel>
        <ul className="space-y-2">
          {detail.lineItems.map((li, i) => (
            <li key={i} className="flex items-start justify-between gap-3 text-sm">
              <span className="min-w-0 text-stone-200">
                {li.name}
                {li.quantity > 1 ? ` × ${li.quantity}` : ""}
              </span>
              <span className="shrink-0 tabular-nums text-stone-300">
                {fmtMoney(li.amountTotal, detail.currency)}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3 pt-3 border-t border-stone-700/70 flex items-center justify-between">
          <span className="text-sm font-semibold text-stone-100">Total charged</span>
          <span className="text-sm font-bold tabular-nums text-stone-50">
            {fmtMoney(detail.amountTotal, detail.currency)}
          </span>
        </div>
      </Card>

      {/* Tokens added / new balance (eventually consistent) */}
      <Card>
        <CardLabel>{isTopup ? "Tokens added" : "Monthly tokens"}</CardLabel>
        {detail.tokens != null && (
          <p className="text-2xl font-serif font-bold" style={{ color: "var(--t-gold-500)" }}>
            +{formatTokens(detail.tokens)}
          </p>
        )}
        {credited ? (
          <>
            <p className="mt-1 text-sm text-stone-300">
              New balance{" "}
              <span className="font-semibold text-stone-100">
                {formatTokens(eco?.billing?.tokenBalance?.availableTokens ?? null)}
              </span>
            </p>
            {!isTopup && eco?.billing?.subscription?.currentPeriodEnd && (
              <p className="mt-0.5 text-xs text-stone-400">
                Renews {fmtDate(eco.billing.subscription.currentPeriodEnd)}
              </p>
            )}
          </>
        ) : pollDone ? (
          <p className="mt-1 text-sm text-stone-400">
            Your purchase is confirmed. Your balance will update within a minute.
          </p>
        ) : (
          <p className="mt-1 flex items-center gap-2 text-sm text-stone-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Updating your balance…
          </p>
        )}
      </Card>

      {/* CTAs */}
      <div className="flex flex-wrap gap-2 pt-1">
        <Link
          href="/billing/history"
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold border border-stone-700 bg-stone-800 text-stone-200 transition-all active:scale-[0.97]"
        >
          Recent activity <ArrowRight className="w-3.5 h-3.5" />
        </Link>
        {isTopup && (
          <Link
            href="/topup"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold border border-stone-700 bg-stone-800 text-stone-200 transition-all active:scale-[0.97]"
          >
            Buy more
          </Link>
        )}
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-bold transition-all active:scale-[0.97]"
          style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
        >
          Back to app
        </Link>
      </div>
    </Shell>
  );
}

export default function ConfirmationPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-stone-500 text-sm">Loading…</div>}>
      <ConfirmationInner />
    </Suspense>
  );
}
