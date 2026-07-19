"use client";

/**
 * Recent activity — a distinct, collapsible "ledger" panel for the Rewards hub.
 *
 * Deliberately styled UNLIKE the raised glass reward/goal cards: a recessed,
 * darker panel with an inner shadow and a gold left "margin rule" (a ledger-book
 * edge), hairline row dividers, and monospace tabular figures. This reads as a
 * record of activity, not another action card. Collapses/expands via the header.
 *
 * Two tabs split earn from spend:
 *   • Additions — credits from the token_transactions ledger (grants, rollover,
 *     top-ups, rewards), already loaded with the balance snapshot.
 *   • Usage — what recent AI actions cost, one row per action (grouped by
 *     prompt_id from api_usage_log), lazily fetched the first time the tab opens.
 *
 * Usage amounts are stone, not gold, so spend reads distinct from earn. Usage
 * has no balance-after column: api_usage_log stores no per-debit balance, so
 * showing one would be fabricated.
 */

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { ScrollText, ChevronDown, ArrowUpRight } from "lucide-react";
import { formatTokens, type TokenTransaction, type UsageAction } from "@/lib/lowhighClient";
import { fetchRecentUsage } from "@/lib/billingService";
import { fmtDate } from "@/lib/format";
import { txDescription, txTypeLabel } from "@/lib/txLabels";
import { useAuth } from "@/lib/auth";
import { readSessionCache, writeSessionCache, useIsomorphicLayoutEffect } from "@/lib/sessionCache";

type Tab = "additions" | "usage";

// Per-user session cache so returning to Rewards (or switching tabs) paints the
// usage rows instantly, matching how Additions come pre-resolved.
const RECENT_USAGE_KEY = "gl_recent_usage";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "additions", label: "Additions" },
  { key: "usage", label: "Usage" },
];

/** "Analyze Marker" or "Analyze Marker + 2 steps" when an action spans components. */
function actionLabel(a: UsageAction): string {
  const first = a.components[0] ?? "AI action";
  const extra = a.components.length - 1;
  return extra > 0 ? `${first} + ${extra} steps` : first;
}

export default function RecentActivity({ transactions }: { transactions: TokenTransaction[] }) {
  const { user } = useAuth();
  const userId = user?.id;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("additions");
  const [usage, setUsage] = useState<UsageAction[] | null>(null);
  const bodyId = useId();

  // Paint cached usage before the browser paints, then revalidate — so the
  // Usage tab is ready the moment it's opened rather than popping in.
  useIsomorphicLayoutEffect(() => {
    if (!userId) return;
    const snap = readSessionCache<UsageAction[]>(RECENT_USAGE_KEY, userId);
    if (snap) setUsage(snap);
  }, [userId]);

  useEffect(() => {
    let alive = true;
    fetchRecentUsage({ limit: 8 }).then((a) => {
      if (!alive) return;
      setUsage(a);
      if (userId) writeSessionCache(RECENT_USAGE_KEY, userId, a);
    });
    return () => {
      alive = false;
    };
  }, [userId]);

  if (transactions.length === 0) return null;
  const credits = transactions.slice(0, 8);

  return (
    <section className="relative overflow-hidden rounded-2xl border border-stone-800 bg-stone-950/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.03),inset_0_0_50px_rgba(0,0,0,0.45)]">
      {/* Gold margin rule — the ledger-book edge */}
      <div
        className="absolute left-0 top-0 bottom-0 w-px"
        style={{ background: "linear-gradient(to bottom, transparent, var(--t-gold-600), transparent)" }}
        aria-hidden="true"
      />

      {/* Header toggle */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="w-full flex items-center gap-3 px-5 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)] focus-visible:ring-inset"
      >
        <span className="grid place-items-center w-8 h-8 rounded-lg border border-stone-700/70 bg-stone-900 shrink-0" style={{ color: "var(--t-gold-500)" }}>
          <ScrollText className="w-4 h-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-serif text-sm font-semibold tracking-wide text-stone-100">Recent activity</span>
          <span className="block text-[11px] text-stone-500">Tokens added and used</span>
        </span>
        <ChevronDown
          className={`w-4 h-4 text-stone-400 transition-transform duration-300 ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {/* Collapsible body (grid-rows trick for a smooth height transition) */}
      <div
        id={bodyId}
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">
          {/* Tabs — earn vs spend */}
          <div role="tablist" aria-label="Recent activity" className="flex gap-2 px-5 pb-1">
            {TABS.map((t) => {
              const active = t.key === tab;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(t.key)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)] focus-visible:ring-inset ${
                    active
                      ? "border-[var(--t-gold-600)] text-[var(--t-gold-400)] bg-[rgba(201,168,76,0.10)]"
                      : "border-stone-700 text-stone-400 hover:text-stone-200"
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* Additions — credits */}
          {tab === "additions" && (
            <ul className="px-5 divide-y divide-stone-800/80">
              {credits.map((t) => {
                const positive = t.amount >= 0;
                return (
                  <li key={t.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate text-stone-100">{txDescription(t)}</p>
                      <p className="text-[11px] text-stone-500">
                        {txTypeLabel(t.type)} · {fmtDate(t.created_at)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right font-mono">
                      <p
                        className="text-sm font-semibold tabular-nums"
                        style={{ color: positive ? "var(--t-gold-500)" : "var(--t-stone-400)" }}
                      >
                        {positive ? "+" : "−"}
                        {formatTokens(Math.abs(t.amount))}
                      </p>
                      {t.balanceAfter != null && (
                        <p className="text-[11px] text-stone-500 tabular-nums">bal {formatTokens(t.balanceAfter)}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Usage — what recent AI actions cost */}
          {tab === "usage" &&
            (usage === null ? (
              <p className="px-5 py-6 text-center text-[11px] text-stone-500">Loading…</p>
            ) : usage.length === 0 ? (
              <p className="px-5 py-6 text-center text-[11px] text-stone-500">No usage yet.</p>
            ) : (
              <ul className="px-5 divide-y divide-stone-800/80">
                {usage.map((a) => (
                  <li key={a.promptId} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate text-stone-100">{actionLabel(a)}</p>
                      <p className="text-[11px] text-stone-500">
                        {[a.tool, fmtDate(a.started)].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <div className="shrink-0 text-right font-mono">
                      <p className="text-sm font-semibold tabular-nums text-stone-400">−{formatTokens(a.actionTokens)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ))}

          <div className="flex justify-end border-t border-stone-800/80 px-5 py-3">
            <Link
              href="/billing/history"
              className="inline-flex items-center gap-1 text-xs font-semibold hover:underline"
              style={{ color: "var(--t-gold-500)" }}
            >
              View full history <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
