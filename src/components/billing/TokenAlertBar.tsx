"use client";

/**
 * Global token-alert header bar. Reads like a system bar at the very top of the
 * app chrome and warns when the user is running low on tokens (gold) or out
 * (deeper burnt-amber — present but understated, true to the memorial theme).
 * Dismissible; a persistent dot on the account badge remains while the condition
 * holds (see ProfileBadge + EcosystemProvider.tokenAlert).
 */

import Link from "next/link";
import { X, Coins, TriangleAlert } from "lucide-react";
import { useEcosystem } from "@/components/ecosystem/EcosystemProvider";

const ACTIVE_STATUSES = ["active", "trialing", "lifetime"];

export default function TokenAlertBar() {
  const eco = useEcosystem();
  const alert = eco?.tokenAlert;
  if (!alert?.barVisible || !alert.level) return null;

  const isOut = alert.level === "out";
  const sub = eco?.billing?.subscription ?? null;
  const isSubscriber = !!sub && ACTIVE_STATUSES.includes(sub.status);

  const ctaHref = isSubscriber ? "/topup" : "/billing";
  const ctaLabel = isSubscriber ? "Buy more tokens" : "See plans";
  const message = isOut
    ? isSubscriber
      ? "You're out of tokens. AI features pause until you top up."
      : "You're out of tokens. Add a plan to keep using AI features."
    : "You're running low on tokens.";

  // Low = gold tint; Out = deeper burnt-amber (not alarming red).
  const tone = isOut
    ? { bg: "rgba(146, 64, 14, 0.24)", border: "rgba(180, 83, 9, 0.55)", fg: "#f7e6c4", icon: "#f59e0b" }
    : { bg: "rgba(201, 168, 76, 0.12)", border: "rgba(201, 168, 76, 0.35)", fg: "var(--t-stone-100)", icon: "var(--t-gold-500)" };
  const Icon = isOut ? TriangleAlert : Coins;

  return (
    <div
      role="status"
      className="flex-shrink-0 z-40 w-full flex items-center gap-3 px-4 py-2 text-sm backdrop-blur-sm animate-in fade-in slide-in-from-top-1 duration-300"
      style={{ background: tone.bg, borderBottom: `1px solid ${tone.border}`, paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
    >
      <Icon className="w-4 h-4 shrink-0" style={{ color: tone.icon }} aria-hidden="true" />
      <p className="min-w-0 flex-1 font-medium leading-snug" style={{ color: tone.fg }}>
        {message}
      </p>
      <Link
        href={ctaHref}
        className="shrink-0 inline-flex items-center rounded-md px-2.5 py-1 text-xs font-semibold transition-all active:scale-[0.97]"
        style={
          isOut
            ? { background: "var(--t-gold-500)", color: "#1a1917" }
            : { border: "1px solid var(--t-gold-600)", color: "var(--t-gold-400)" }
        }
      >
        {ctaLabel}
      </Link>
      <button
        type="button"
        onClick={() => alert.dismiss()}
        aria-label="Dismiss token notice"
        className="shrink-0 w-6 h-6 -mr-1 inline-flex items-center justify-center rounded-md text-stone-400 hover:text-stone-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)]"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
