/** Shared (client + server) shape for a GraveLens-visible reward goal. */

export type GoalStatus = "claimable" | "claimed" | "locked" | "coming_soon";

export interface GraveLensGoal {
  slug: string;
  title: string;
  description: string;
  category: string;
  tokenReward: number;
  frequency: string;
  redemption: string;
  requirementType: string;
  status: GoalStatus;
  claimedAt: string | null;
  /** Present for gravelens_rank_* goals — drives the RankInsignia + threshold. */
  minRank: number | null;
}
