import React from "react";

/**
 * Inline status banner (gold = success, stone = neutral/info). Lifted from
 * billing/page.tsx so the pricing page and the purchase confirmation page share
 * one implementation.
 */

export function Banner({ children, tone }: { children: React.ReactNode; tone: "gold" | "stone" }) {
  return (
    <div
      className="rounded-xl px-4 py-3 mb-4 text-sm backdrop-blur-xl"
      style={
        tone === "gold"
          ? { background: "var(--t-gold-500)", color: "#1a1917" }
          : {
              background: "rgba(var(--glass-bg-rgb), 0.6)",
              color: "var(--t-stone-300)",
              border: "1px solid var(--t-stone-700)",
            }
      }
    >
      {children}
    </div>
  );
}
