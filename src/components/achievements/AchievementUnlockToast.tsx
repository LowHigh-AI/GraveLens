"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Trophy, X } from "lucide-react";
import { RankInsignia } from "@/components/ui/RankInsignia";
import { formatTokens } from "@/lib/lowhighClient";
import { haptic } from "@/lib/haptic";

/**
 * A single, non-disruptive unlock notification shown at top-center after a save.
 *
 *  - `count`: minor achievements collapsed into one pill. Auto-dismisses; tapping
 *     it opens the Explorer (where the "Just unlocked" section lives).
 *  - `hero`: a rank-up. Gold, celebratory, and persistent (no auto-dismiss) so the
 *     rare, high-value moment isn't missed. Routes to /rewards to claim tokens.
 *
 * Never stacks and never overlaps the bottom nav — replaces the old bottom-left
 * toast column.
 */
export type AchievementToastState =
  | { kind: "count"; count: number }
  | { kind: "hero"; rankLevel: number; rankTitle: string; bonus: number };

export default function AchievementUnlockToast({
  state,
  onDismiss,
}: {
  state: AchievementToastState;
  onDismiss: () => void;
}) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Minor-achievement pill auto-dismisses; the rank-up hero stays until acted on.
  useEffect(() => {
    if (state.kind !== "count") return;
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, [state, onDismiss]);

  if (!mounted) return null;

  const goExplorer = () => {
    haptic("light");
    onDismiss();
    router.push("/explorer");
  };
  const goClaim = () => {
    haptic("medium");
    onDismiss();
    router.push("/rewards");
  };

  return createPortal(
    <div
      className="fixed top-0 left-0 right-0 z-[70] flex justify-center px-4 pointer-events-none"
      style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)" }}
    >
      {state.kind === "count" ? (
        <div className="pointer-events-auto w-full max-w-sm animate-fade-up">
          <button
            onClick={goExplorer}
            className="w-full rounded-2xl px-4 py-3 flex items-center gap-3 text-left active:scale-[0.98] transition-transform"
            style={{
              background: "linear-gradient(135deg, var(--t-stone-800), var(--t-stone-900))",
              border: "1px solid rgba(201,168,76,0.5)",
              boxShadow: "0 4px 24px rgba(201,168,76,0.2)",
            }}
          >
            <div
              className="w-10 h-10 flex items-center justify-center rounded-lg shrink-0"
              style={{ background: "rgba(201,168,76,0.15)" }}
            >
              <Trophy size={20} strokeWidth={1.75} color="var(--t-gold-500)" />
            </div>
            <div className="flex-1 min-w-0">
              <p
                className="text-[0.75rem] uppercase tracking-widest font-medium"
                style={{ color: "var(--t-gold-500)" }}
              >
                {state.count === 1 ? "Achievement unlocked" : `${state.count} achievements unlocked`}
              </p>
              <p className="text-sm font-semibold text-stone-100 leading-tight mt-0.5">
                Tap to view in Explorer
              </p>
            </div>
            <span
              onClick={(e) => {
                e.stopPropagation();
                onDismiss();
              }}
              className="shrink-0 p-1.5 rounded-lg text-stone-400 hover:text-stone-200 hover:bg-white/5"
              aria-label="Dismiss"
            >
              <X size={16} strokeWidth={2} />
            </span>
          </button>
        </div>
      ) : (
        <div
          className="pointer-events-auto w-full max-w-sm rounded-2xl p-4 animate-fade-up"
          style={{
            background: "linear-gradient(135deg, var(--t-stone-900), var(--t-stone-800))",
            border: "1px solid rgba(201,168,76,0.6)",
            boxShadow: "0 8px 32px rgba(201,168,76,0.3)",
          }}
        >
          <div className="flex items-center gap-3">
            <div className="shrink-0">
              <RankInsignia level={state.rankLevel} size={44} />
            </div>
            <div className="flex-1 min-w-0">
              <p
                className="text-[0.7rem] uppercase tracking-widest font-medium"
                style={{ color: "var(--t-gold-500)" }}
              >
                Rank {state.rankLevel} reached
              </p>
              <p
                className="font-serif text-base font-bold leading-tight mt-0.5"
                style={{ color: "var(--t-gold-200)" }}
              >
                {state.rankTitle}
              </p>
              {state.bonus > 0 && (
                <p className="text-xs text-stone-400 mt-0.5">
                  {formatTokens(state.bonus)} bonus tokens ready to claim
                </p>
              )}
            </div>
            <button
              onClick={onDismiss}
              className="shrink-0 p-1.5 rounded-lg text-stone-400 hover:text-stone-200 hover:bg-white/5"
              aria-label="Dismiss"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
          {state.bonus > 0 && (
            <button
              onClick={goClaim}
              className="mt-3 w-full rounded-xl px-4 py-2.5 text-sm font-bold active:scale-[0.98] transition-transform"
              style={{ background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))", color: "#1a1917" }}
            >
              Claim tokens
            </button>
          )}
        </div>
      )}
    </div>,
    document.body
  );
}
