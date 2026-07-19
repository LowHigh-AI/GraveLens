"use client";

import { useEffect, useState } from "react";

// Build time stamped at deploy by next.config.ts → NEXT_PUBLIC_BUILD_TIME
const CLIENT_BUILD_TIME = process.env.NEXT_PUBLIC_BUILD_TIME ?? "dev";

// Minimum gap between version-poll requests (ms). Prevents hammering the
// server when the user rapidly switches in and out of the app.
const POLL_THROTTLE_MS = 60_000;

// How long (ms) to show the "Updated to latest version" confirmation toast
const TOAST_DURATION_MS = 3500;

// sessionStorage key: set after an auto-reload so the toast shows on the
// fresh page load instead of the old one.
const RELOADED_KEY = "gl_just_updated";

export default function ServiceWorkerRegister() {
  const [showToast, setShowToast] = useState(false);

  useEffect(() => {
    // ── Show "Updated" toast if we just auto-reloaded ───────────────────────
    if (sessionStorage.getItem(RELOADED_KEY)) {
      sessionStorage.removeItem(RELOADED_KEY);
      setTimeout(() => {
        setShowToast(true);
        setTimeout(() => setShowToast(false), TOAST_DURATION_MS);
      }, 0);
    }

    // ── 1. Register service worker ──────────────────────────────────────────
    if (!("serviceWorker" in navigator)) return;

    // Never run the caching SW in local dev. It serves /_next/static chunks
    // cache-first, but `next dev` recompiles fresh chunk hashes constantly, so
    // the stale cache makes the dev runtime detect a version mismatch and hard
    // reload — re-serving the same stale assets in an infinite reload loop.
    // Tear down any SW + caches left over from a prior prod/PWA visit so a
    // developer who hit the loop is freed on the next load, then bail.
    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
      if (typeof caches !== "undefined") {
        caches
          .keys()
          .then((keys) => keys.forEach((k) => caches.delete(k)))
          .catch(() => {});
      }
      return;
    }

    navigator.serviceWorker
      .register("/sw.js")
      .catch((err) => console.error("SW registration failed:", err));

    // ── 2. SW-based update notification ────────────────────────────────────
    // When a new SW takes control, reload immediately — but only if there was
    // already a controller (i.e. this is a SW swap/update, not a first install).
    const hadController = !!navigator.serviceWorker.controller;
    const onControllerChange = () => {
      if (!hadController) return;
      sessionStorage.setItem(RELOADED_KEY, "1");
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    // ── 3. Build-version polling on visibility ──────────────────────────────
    // Catches deploys where sw.js itself didn't change but Next.js JS bundles
    // did. Runs every time the user brings the app back into focus, but no
    // more than once per POLL_THROTTLE_MS.
    let lastPoll = 0;

    const checkVersion = async () => {
      if (CLIENT_BUILD_TIME === "dev") return; // skip in local dev
      const now = Date.now();
      if (now - lastPoll < POLL_THROTTLE_MS) return;
      lastPoll = now;

      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const { buildTime } = await res.json();
        if (buildTime && buildTime !== CLIENT_BUILD_TIME) {
          sessionStorage.setItem(RELOADED_KEY, "1");
          window.location.reload();
        }
      } catch {
        // Network unavailable — silently ignore
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") checkVersion();
    };

    document.addEventListener("visibilitychange", onVisibility);

    // Also check once shortly after mount (covers first open from home screen)
    const initialCheck = setTimeout(checkVersion, 3000);

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimeout(initialCheck);
    };
  }, []);

  if (!showToast) return null;

  return (
    <div
      className="fixed z-100 flex items-center gap-3 px-4 py-3 rounded-2xl shadow-2xl animate-fade-up"
      style={{
        bottom: "calc(5.5rem + env(safe-area-inset-bottom, 0px))",
        left: "50%",
        transform: "translateX(-50%)",
        whiteSpace: "nowrap",
        background: "linear-gradient(135deg, var(--t-stone-800), var(--t-stone-900))",
        border: "1px solid rgba(201,168,76,0.4)",
        boxShadow: "0 4px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(201,168,76,0.1)",
      }}
    >
      <div
        className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: "rgba(201,168,76,0.15)" }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--t-gold-500)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <p className="text-sm font-medium text-stone-100">
        GraveLens updated to the latest version
      </p>
    </div>
  );
}
