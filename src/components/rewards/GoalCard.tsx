"use client";

import { useState } from "react";
import { Check, Copy, Share2, Lock } from "lucide-react";
import type { GraveLensGoal } from "@/lib/goalsTypes";
import { RankInsignia } from "@/components/ui/RankInsignia";
import { formatTokens } from "@/lib/lowhighClient";

/**
 * One reward goal as a horizontal row — a re-themed port of LowHigh's GoalCard
 * (the `flex items-center … px-5 py-4` row idiom, title + reward badge + right
 * action). GraveLens is dark-only (stone/gold), so the dark/light branching is
 * dropped. Rank goals show a RankInsignia; referral goals show Copy + Share.
 */

interface GoalCardProps {
  goal: GraveLensGoal;
  claiming: boolean;
  onClaim: (slug: string) => void;
  referralUrl?: string | null;
  onShare?: () => void;
  /** Suppress the per-row claimable tint (used inside the Ready-to-claim card). */
  suppressClaimableBg?: boolean;
}

export default function GoalCard({
  goal,
  claiming,
  onClaim,
  referralUrl,
  onShare,
  suppressClaimableBg,
}: GoalCardProps) {
  const [copied, setCopied] = useState(false);

  const isClaimable = goal.status === "claimable";
  const isClaimed = goal.status === "claimed";
  const isReferral = goal.category === "spread_the_word";
  const isRank = goal.slug.startsWith("gravelens_rank_");

  const handleCopy = async () => {
    if (!referralUrl) return;
    try {
      await navigator.clipboard.writeText(referralUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — silent */
    }
  };

  const titleTone = isClaimed
    ? "text-stone-400"
    : goal.status === "locked" || goal.status === "coming_soon"
      ? "text-stone-300"
      : "text-stone-100";
  const rewardTone = isClaimable ? "text-[var(--t-gold-500)]" : "text-stone-400";

  return (
    <div
      className="flex items-center gap-4 px-5 py-4 transition-colors"
      style={{
        background: isClaimable && !suppressClaimableBg ? "rgba(201,168,76,0.06)" : undefined,
      }}
    >
      {isRank && goal.minRank != null && (
        <RankInsignia level={goal.minRank} size={30} />
      )}

      {/* Title + reward + description */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <h3 className={`text-sm font-semibold truncate ${titleTone}`}>{goal.title}</h3>
          <span className={`text-xs font-bold tabular-nums shrink-0 ${rewardTone}`}>
            +{formatTokens(goal.tokenReward)} Tokens
            {isReferral ? " / referral" : ""}
          </span>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed line-clamp-2 text-stone-400">
          {goal.description}
        </p>
      </div>

      {/* Status / action */}
      <div className={`shrink-0 flex items-center justify-end gap-2 ${isReferral ? "min-w-[170px]" : "min-w-[110px]"}`}>
        {isReferral ? (
          <>
            <button
              type="button"
              onClick={handleCopy}
              disabled={!referralUrl}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all active:scale-[0.97] disabled:opacity-50 border border-stone-700 bg-stone-800 text-stone-200"
              aria-label="Copy your referral link"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? "Copied" : "Copy link"}
            </button>
            <button
              type="button"
              onClick={() => onShare?.()}
              disabled={!referralUrl}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all active:scale-[0.97] disabled:opacity-50"
              style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
            >
              <Share2 className="w-3.5 h-3.5" />
              Share
            </button>
          </>
        ) : isClaimable ? (
          <button
            type="button"
            disabled={claiming}
            onClick={() => onClaim(goal.slug)}
            className="inline-flex items-center justify-center px-4 py-1.5 rounded-lg text-xs font-bold transition-all active:scale-[0.97] disabled:opacity-60 disabled:cursor-wait w-full"
            style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
          >
            {claiming ? "Claiming…" : "Claim"}
          </button>
        ) : isClaimed ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: "var(--t-gold-500)" }}>
            <Check className="w-3.5 h-3.5" />
            Claimed
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-stone-400">
            <Lock className="w-3 h-3" />
            {goal.status === "coming_soon" ? "In progress" : "Not yet earned"}
          </span>
        )}
      </div>
    </div>
  );
}
