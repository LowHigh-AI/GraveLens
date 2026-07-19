import React from "react";

/**
 * Shared card container + section label for the billing/rewards surfaces.
 * Lifted from rewards/page.tsx so rewards, transaction history, and the purchase
 * confirmation page render the same chrome. Markup kept identical to avoid any
 * visual regression on the Rewards page.
 */

export function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-stone-700/70 bg-stone-900/65 backdrop-blur-xl p-5">
      {children}
    </div>
  );
}

export function CardLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-400 mb-4">
      {children}
    </h2>
  );
}
