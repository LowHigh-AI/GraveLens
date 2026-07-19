/**
 * Subscriber decision-surface types (Change Plan / Top-up), ported from LowHigh's
 * src/types/billing.ts. The catalog/balance/subscription shapes live in
 * billingService.ts and lowhighClient.ts; these cover the recommendation and
 * plan-change-impact payloads GraveLens now self-hosts.
 */

export interface PlanUpsellTarget {
  slug: string;
  name: string;
  tokenAllowance: number;
  priceMonthly: number;
  extraTokenPricePerMillionUsd: number;
  rolloverCap: number | null;
  rolloverUncapped: boolean;
  /** Projected annual savings vs. the current plan at recent usage. */
  annualSavingsUsd: number;
  /** Projected monthly total (base + overage) at recent usage. */
  monthlyTotalProjectedUsd: number;
}

export interface PlanRecommendation {
  currentTier: number;
  recentAvgTokensMonthly: number;
  daysOfHistory: number;
  currentOverageUsdMonthly: number;
  upsellTargets: PlanUpsellTarget[];
}

export interface PlanChangeImpact {
  targetPlanSlug: string;
  targetPlanName: string;
  targetTierLevel: number;
  direction: "upgrade" | "downgrade" | "same";
  /** Monthly token allowance delta; positive = gain. */
  tokenDelta: number;
  loyaltyGrantsLostMonthly: number;
  rolloverBankAtRisk: number;
  topUpRateDeltaUsd: number;
  priceDeltaMonthlyUsd: number;
  nearestMilestone: {
    name: string;
    daysRemaining: number;
    wouldBeLost: boolean;
  } | null;
}

export type { UsageAverage } from "./usageGroups";
