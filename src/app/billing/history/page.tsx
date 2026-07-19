"use client";

/**
 * GraveLens Transaction History — /billing/history
 *
 * Two views, reached from the Rewards page:
 *   • Added — itemized token additions (purchases, monthly grants, rewards,
 *     gifts) from the token_transactions ledger, keyset-paginated.
 *   • Used — token usage aggregated by calendar month. Usage is not itemized in
 *     the ledger (it lives in api_usage_log), so it's summarized one line per
 *     month, with the amount that expired / didn't carry over.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, ReceiptText } from "lucide-react";
import PageShell from "@/components/layout/PageShell";
import { Card, CardLabel } from "@/components/ui/Card";
import { useAuth } from "@/lib/auth";
import { fetchTransactionHistory, fetchMonthlyUsage } from "@/lib/billingService";
import { formatTokens, type TokenTransaction, type MonthlyUsage } from "@/lib/lowhighClient";
import { fmtDate } from "@/lib/format";
import { txDescription, txTypeLabel } from "@/lib/txLabels";
import { readSessionCache, writeSessionCache, useIsomorphicLayoutEffect } from "@/lib/sessionCache";

type Scope = "credits" | "usage";

// Per-user session caches so switching between Added/Used (or returning from
// Rewards) repaints instantly instead of re-spinning; each still revalidates.
const HIST_CREDITS_KEY = "gl_hist_credits";
const HIST_USAGE_KEY = "gl_hist_usage";

/** Placeholder rows matching the list layout — shown only on a cold load. */
function HistoryRowsSkeleton() {
  return (
    <ul className="space-y-3 animate-pulse" role="status" aria-label="Loading">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <div className="h-3.5 w-40 rounded bg-stone-800" />
            <div className="h-2.5 w-24 rounded bg-stone-800" />
          </div>
          <div className="h-3.5 w-14 rounded bg-stone-800 shrink-0" />
        </li>
      ))}
    </ul>
  );
}

const SCOPES: Array<{ key: Scope; label: string }> = [
  { key: "credits", label: "Added" },
  { key: "usage", label: "Used" },
];

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

/** Month label from an ISO month-start, built from Y/M parts to avoid tz shift. */
const fmtMonth = (iso: string) => {
  const [y, m] = String(iso).slice(0, 7).split("-").map(Number);
  if (!y || !m) return "—";
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { year: "numeric", month: "long" });
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <PageShell backgroundClass="bg-transparent" title="Recent activity" icon={<ReceiptText className="w-5 h-5" />}>
      <div className="w-full max-w-lg mx-auto px-4 py-6 space-y-4">
        <Link
          href="/rewards"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-stone-400 hover:text-stone-200 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Balance &amp; rewards
        </Link>
        {children}
      </div>
    </PageShell>
  );
}

export default function TransactionHistoryPage() {
  const { user, loading: authLoading } = useAuth();
  const [scope, setScope] = useState<Scope>("credits");

  if (!authLoading && !user) {
    return (
      <Shell>
        <Card>
          <CardLabel>Sign in required</CardLabel>
          <p className="text-sm text-stone-300">Sign in to view your recent activity.</p>
          <div className="mt-4">
            <Link
              href="/login?next=/billing/history"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-bold transition-all active:scale-[0.97]"
              style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
            >
              Sign in
            </Link>
          </div>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <div role="group" aria-label="Filter transactions" className="flex flex-wrap gap-2">
        {SCOPES.map((s) => {
          const active = s.key === scope;
          return (
            <button
              key={s.key}
              type="button"
              aria-pressed={active}
              onClick={() => setScope(s.key)}
              className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)] focus-visible:ring-offset-1 focus-visible:ring-offset-stone-900 ${
                active
                  ? "border-[var(--t-gold-600)] text-[var(--t-gold-400)] bg-[rgba(201,168,76,0.10)]"
                  : "border-stone-700 text-stone-400 hover:text-stone-200"
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {scope === "usage" ? <UsageList userId={user?.id} /> : <CreditsList userId={user?.id} />}
    </Shell>
  );
}

/** Itemized token additions (credits), keyset-paginated. */
function CreditsList({ userId }: { userId?: string }) {
  const [items, setItems] = useState<TokenTransaction[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Paint the cached first page before the browser paints, so a tab switch or
  // return visit shows rows immediately (skeleton only on a true cold load).
  useIsomorphicLayoutEffect(() => {
    if (!userId) return;
    const snap = readSessionCache<{ items: TokenTransaction[]; cursor: string | null }>(
      HIST_CREDITS_KEY,
      userId
    );
    if (snap) {
      setItems(snap.items);
      setCursor(snap.cursor);
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    let alive = true;
    fetchTransactionHistory({ scope: "credits" }).then((page) => {
      if (!alive) return;
      setItems(page.items);
      setCursor(page.nextCursor);
      setLoading(false);
      if (userId) writeSessionCache(HIST_CREDITS_KEY, userId, { items: page.items, cursor: page.nextCursor });
    });
    return () => {
      alive = false;
    };
  }, [userId]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const page = await fetchTransactionHistory({ scope: "credits", before: cursor });
    setItems((prev) => [...prev, ...page.items]);
    setCursor(page.nextCursor);
    setLoadingMore(false);
  }, [cursor, loadingMore]);

  return (
    <Card>
      <CardLabel>Added</CardLabel>
      {loading ? (
        <HistoryRowsSkeleton />
      ) : items.length === 0 ? (
        <div className="py-2">
          <p className="text-sm font-medium text-stone-200">No transactions yet</p>
          <p className="mt-1 text-sm text-stone-400">
            Your purchases, monthly tokens, and rewards will show up here.
          </p>
          <Link
            href="/billing"
            className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-bold transition-all active:scale-[0.97]"
            style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
          >
            See plans
          </Link>
        </div>
      ) : (
        <>
          <ul className="space-y-3">
            {items.map((t) => {
              const positive = t.amount >= 0;
              return (
                <li key={t.id} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate text-stone-100">{txDescription(t)}</p>
                    <p className="text-[11px] text-stone-400">
                      {txTypeLabel(t.type)} · {fmtDate(t.created_at)}
                      {t.chargeAmountUsd != null ? ` · ${fmtUsd(t.chargeAmountUsd)} charged` : ""}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p
                      className="text-sm font-semibold tabular-nums"
                      style={{ color: positive ? "var(--t-gold-500)" : "var(--t-stone-400)" }}
                    >
                      {positive ? "+" : "−"}
                      {formatTokens(Math.abs(t.amount))}
                    </p>
                    {t.balanceAfter != null && (
                      <p className="text-[11px] text-stone-400">Balance {formatTokens(t.balanceAfter)}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {cursor && (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold border border-stone-700 bg-stone-800 text-stone-200 transition-all active:scale-[0.97] disabled:opacity-60"
              >
                {loadingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** Token usage summarized one line per calendar month. */
function UsageList({ userId }: { userId?: string }) {
  const [months, setMonths] = useState<MonthlyUsage[] | null>(null);

  useIsomorphicLayoutEffect(() => {
    if (!userId) return;
    const snap = readSessionCache<MonthlyUsage[]>(HIST_USAGE_KEY, userId);
    if (snap) setMonths(snap);
  }, [userId]);

  useEffect(() => {
    let alive = true;
    fetchMonthlyUsage().then((m) => {
      if (!alive) return;
      setMonths(m);
      if (userId) writeSessionCache(HIST_USAGE_KEY, userId, m);
    });
    return () => {
      alive = false;
    };
  }, [userId]);

  return (
    <Card>
      <CardLabel>Used by month</CardLabel>
      {months === null ? (
        <HistoryRowsSkeleton />
      ) : months.length === 0 ? (
        <div className="py-2">
          <p className="text-sm font-medium text-stone-200">No usage yet</p>
          <p className="mt-1 text-sm text-stone-400">
            When you use AI features, your monthly token usage will show up here.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {months.map((m) => (
            <li key={m.month} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-stone-100">{fmtMonth(m.month)}</p>
                <p className="text-[11px] text-stone-500">
                  {m.callCount.toLocaleString()} AI {m.callCount === 1 ? "action" : "actions"}
                </p>
              </div>
              <div className="text-right shrink-0 font-mono">
                <p className="text-sm font-semibold tabular-nums text-stone-200">
                  −{formatTokens(m.usedTokens)}
                </p>
                {m.expiredTokens != null && m.expiredTokens > 0 && (
                  <p className="text-[11px] text-stone-500 tabular-nums">
                    {formatTokens(m.expiredTokens)} expired
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
