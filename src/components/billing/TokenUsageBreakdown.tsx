"use client";

/**
 * Estimated-uses breakdown, ported from LowHigh's components/usage/TokenUsageBreakdown.
 * Re-themed dark-only (stone/gold). When `averages` is omitted it self-fetches
 * from GraveLens's same-origin /api/billing/usage-stats (cookie auth); pages that
 * render several breakdowns pass a shared `averages` array to fetch only once.
 */

import { useEffect, useMemo, useState } from "react";
import { APP_ICONS, getAppLabel } from "@/lib/usageLabels";
import { groupByApp, fmtUses, type UsageAverage } from "@/lib/usageGroups";
import { fetchUsageStats } from "@/lib/billingService";

interface TokenUsageBreakdownProps {
  /** Token bucket to compute "uses available" against. */
  tokens: number;
  className?: string;
  emptyState?: React.ReactNode;
  /** Rendered while averages are being fetched. Defaults to null (renders nothing). */
  loadingState?: React.ReactNode;
  /** When true, show `loadingState` instead of the list (e.g. the token bucket
   *  changed and the caller wants a brief "recalculating" beat). */
  recalculating?: boolean;
  /** Pre-fetched averages; when provided the component skips its own fetch. */
  averages?: UsageAverage[];
  /**
   * Slug of the app the user is currently in — pinned to the top of the list.
   * This is GraveLens everywhere in this app, so it defaults accordingly.
   */
  currentAppSlug?: string;
}

export default function TokenUsageBreakdown({
  tokens,
  className,
  emptyState,
  loadingState,
  recalculating,
  averages: averagesProp,
  currentAppSlug = "gravelens",
}: TokenUsageBreakdownProps) {
  const usingProp = averagesProp !== undefined;
  const [fetched, setFetched] = useState<UsageAverage[]>([]);
  const [loading, setLoading] = useState(!usingProp);

  useEffect(() => {
    if (usingProp) return;
    let cancelled = false;
    fetchUsageStats()
      .then((data) => {
        if (!cancelled) setFetched(data?.averages ?? []);
      })
      .catch(() => {
        if (!cancelled) setFetched([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [usingProp]);

  const averages = usingProp ? averagesProp : fetched;

  const groups = useMemo(() => {
    if (averages.length === 0) return [];
    const grouped = groupByApp(averages);

    // Per-app "popularity" weight = recent token usage (avg per use × prompt count,
    // summed across the app's components). Higher = more used = higher in the list.
    const weight: Record<string, number> = {};
    for (const a of averages) {
      const label = getAppLabel(a.appSlug);
      weight[label] = (weight[label] ?? 0) + a.avgTokens * a.totalPrompts;
    }
    const pinnedLabel = getAppLabel(currentAppSlug);

    // Order: current app pinned top → highest recent token usage → alphabetical.
    return Object.keys(grouped)
      .sort((a, b) => {
        if (a === pinnedLabel && b !== pinnedLabel) return -1;
        if (b === pinnedLabel && a !== pinnedLabel) return 1;
        const wa = weight[a] ?? 0;
        const wb = weight[b] ?? 0;
        if (wb !== wa) return wb - wa;
        return a.localeCompare(b);
      })
      .map((appLabel) => ({
        appLabel,
        tools: Object.keys(grouped[appLabel])
          .sort((a, b) => a.localeCompare(b))
          .map((toolName) => ({
            toolName,
            features: Object.keys(grouped[appLabel][toolName])
              .sort((a, b) => a.localeCompare(b))
              .map((componentName) => ({
                componentName,
                estimatedTokensPerUse: grouped[appLabel][toolName][componentName].estimatedTokensPerUse,
              })),
          })),
      }));
  }, [averages, currentAppSlug]);

  if (loading || recalculating) return <>{loadingState ?? null}</>;
  if (groups.length === 0) return <>{emptyState ?? null}</>;

  return (
    <div className={`space-y-5 ${className ?? ""}`}>
      <div className="flex justify-end">
        <span className="text-[10px] uppercase tracking-[0.18em] text-stone-500">Estimated uses</span>
      </div>
      {groups.map((group) => {
        const Icon = APP_ICONS[group.appLabel];
        return (
          <div key={group.appLabel}>
            <div className="flex items-center gap-2 mb-2">
              {Icon && <Icon className="w-3 h-3 flex-shrink-0 text-stone-500" />}
              <span className="text-[10px] uppercase tracking-[0.18em] text-stone-500">{group.appLabel}</span>
              <span className="flex-1 h-px bg-stone-700/60" />
            </div>
            <div className="space-y-2.5">
              {group.tools.map((tool) => (
                <div key={tool.toolName}>
                  <div className="text-[11px] pl-4 mb-0.5 text-stone-500">{tool.toolName}</div>
                  <div>
                    {tool.features.map((feature) => {
                      const est = feature.estimatedTokensPerUse;
                      const uses = est > 0 && tokens > 0 ? Math.floor(tokens / est) : 0;
                      return (
                        <div key={feature.componentName} className="flex items-baseline gap-2 pl-8 py-[3px]">
                          <span className="text-xs text-stone-400">{feature.componentName}</span>
                          <span className="flex-1 border-b border-dotted border-stone-700/70 translate-y-[-3px]" />
                          <span className="text-xs tabular-nums text-stone-300">
                            {est > 0 && tokens > 0 ? fmtUses(uses) : "—"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
