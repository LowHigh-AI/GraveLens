"use client";

import type { ReactNode } from "react";
import GoalCard from "./GoalCard";
import type { GraveLensGoal } from "@/lib/goalsTypes";

/**
 * A grouped list of goals: muted section header above a single bordered glass
 * card with dividers between rows. Re-themed port of LowHigh's GoalsSection.
 */
interface GoalsSectionProps {
  title: string;
  goals: GraveLensGoal[];
  claimingSlug: string | null;
  onClaim: (slug: string) => void;
  referralUrl?: string | null;
  onShare?: () => void;
  footerSlot?: ReactNode;
  /** Optional content rendered to the right of the section title (e.g. a link). */
  headerRight?: ReactNode;
}

export default function GoalsSection({
  title,
  goals,
  claimingSlug,
  onClaim,
  referralUrl,
  onShare,
  footerSlot,
  headerRight,
}: GoalsSectionProps) {
  if (goals.length === 0 && !footerSlot) return null;

  return (
    <section>
      <div className="flex items-center justify-between gap-2 mb-3 px-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-400">
          {title}
        </h2>
        {headerRight}
      </div>
      <div className="space-y-4">
        {goals.length > 0 && (
          <div className="rounded-2xl overflow-hidden border border-stone-700/70 bg-stone-900/65 backdrop-blur-xl divide-y divide-stone-800">
            {goals.map((goal) => (
              <GoalCard
                key={goal.slug}
                goal={goal}
                claiming={claimingSlug === goal.slug}
                onClaim={onClaim}
                referralUrl={referralUrl}
                onShare={onShare}
              />
            ))}
          </div>
        )}
        {footerSlot}
      </div>
    </section>
  );
}
