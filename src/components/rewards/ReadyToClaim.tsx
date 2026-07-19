"use client";

import { Sparkles } from "lucide-react";
import GoalCard from "./GoalCard";
import type { GraveLensGoal } from "@/lib/goalsTypes";
import { formatTokens } from "@/lib/lowhighClient";

/**
 * Pinned claimable list at the top of the page — same rows as GoalsSection but
 * with a gold-tinted, accented card and a "tokens waiting" summary. Re-themed
 * port of LowHigh's ReadyToClaim.
 */
interface ReadyToClaimProps {
  goals: GraveLensGoal[];
  claimingSlug: string | null;
  onClaim: (slug: string) => void;
}

export default function ReadyToClaim({ goals, claimingSlug, onClaim }: ReadyToClaimProps) {
  if (goals.length === 0) return null;
  const total = goals.reduce((sum, g) => sum + g.tokenReward, 0);

  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-3 px-1">
        <div className="flex items-center gap-1.5">
          <Sparkles className="w-3 h-3" strokeWidth={2.25} style={{ color: "var(--t-gold-500)" }} />
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-400">
            Ready to claim
          </h2>
          {/* Terminal dot of the notification trail — the redeem spot. */}
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: "#10b981" }}
            aria-hidden="true"
          />
        </div>
        <p className="text-xs text-stone-400">
          <span className="font-bold tabular-nums text-stone-100">{formatTokens(total)}</span> tokens waiting
        </p>
      </div>

      <div
        className="rounded-2xl overflow-hidden border backdrop-blur-xl"
        style={{
          borderColor: "rgba(201,168,76,0.35)",
          backgroundColor: "rgba(201,168,76,0.03)",
          backgroundImage:
            "radial-gradient(ellipse 75% 90% at 0% 0%, rgba(201,168,76,0.12), transparent 65%)",
          boxShadow: "0 0 32px rgba(201,168,76,0.10), inset 0 1px 0 rgba(255,255,255,0.04)",
        }}
      >
        <div className="divide-y divide-[rgba(201,168,76,0.15)]">
          {goals.map((goal) => (
            <GoalCard
              key={goal.slug}
              goal={goal}
              claiming={claimingSlug === goal.slug}
              onClaim={onClaim}
              suppressClaimableBg
            />
          ))}
        </div>
      </div>
    </section>
  );
}
