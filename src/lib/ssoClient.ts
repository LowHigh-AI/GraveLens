/**
 * Cross-domain SSO client (GraveLens side).
 *
 * GraveLens (gravelens.com) and the LowHigh account site (lowhigh.ai) are
 * different root domains, so they cannot share a browser session directly. The
 * LowHigh side hosts a redirect-based SSO broker (`/api/sso/*`) backed by a
 * first-party `lh_sso` cookie. This module drives the three GraveLens-side hops:
 *
 *   1. attemptSilentSignIn() — on cold load with no local session, bounce through
 *      the broker once to restore a session that exists on lowhigh.ai.
 *   2. exchangeSsoCode()    — on the return trip (/auth/callback?sso_code=...),
 *      trade the one-time code for a token_hash and establish a native session.
 *   3. establishCentralSession() — after logging in *on GraveLens*, push the
 *      session up to the central cookie so the reverse direction works too.
 *
 * Everything is fail-open: if SSO isn't configured or the broker is unreachable,
 * these no-op and the normal email/password (etc.) login still works.
 */

import { createClient } from "@/lib/supabase/browser";
import type { User } from "@supabase/supabase-js";

const LOWHIGH_BASE = (process.env.NEXT_PUBLIC_LOWHIGH_API_BASE || "").replace(/\/$/, "");

/**
 * SSO redirects to the broker are gated behind their OWN flag, separate from the
 * billing base. This lets GraveLens link to LowHigh billing (base set) without
 * bouncing users to `/api/sso/*` before the broker is actually deployed — a
 * stray redirect would otherwise 404 on lowhigh.ai.
 */
const SSO_ENABLED =
  LOWHIGH_BASE.length > 0 &&
  ["1", "true", "yes"].includes((process.env.NEXT_PUBLIC_LOWHIGH_SSO_ENABLED || "").toLowerCase());

/** Once-per-tab guard so we never bounce through the broker in a loop. */
const TRIED_KEY = "lh_sso_tried";

export const ssoConfigured = () => SSO_ENABLED;

function alreadyTried(): boolean {
  try {
    return sessionStorage.getItem(TRIED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markSsoTried() {
  try {
    sessionStorage.setItem(TRIED_KEY, "1");
  } catch {
    /* sessionStorage unavailable (private mode / SSR) — ignore */
  }
}

/** Auth routes must not auto-bounce, or we'd loop the login/callback screens. */
function onAuthRoute(): boolean {
  const p = window.location.pathname;
  return p.startsWith("/login") || p.startsWith("/auth");
}

/**
 * Confirm the SSO broker is actually deployed + reachable before committing to a
 * top-level redirect. A bare redirect to a missing broker would strand the user
 * on a 404 with no way back, so we probe a cheap CORS endpoint first and treat
 * ANY failure (404, network error, CORS rejection, timeout) as "no SSO now".
 */
async function brokerReachable(): Promise<boolean> {
  try {
    const signal =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(2500)
        : undefined;
    const res = await fetch(`${LOWHIGH_BASE}/api/sso/ping`, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
      signal,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * One-shot cross-domain SSO restore. If the broker is reachable AND a central
 * LowHigh session exists this performs a top-level redirect and never resolves
 * (the page unloads); the return trip lands on /auth/callback with an `sso_code`.
 * Otherwise it no-ops and resolves `null` so the caller proceeds as anonymous.
 *
 * Fail-safe: if the broker isn't deployed/reachable we stay anonymous rather than
 * redirecting into a 404 — so GraveLens keeps working even when SSO is enabled
 * before the broker ships.
 */
export async function attemptSilentSignIn(): Promise<User | null> {
  if (typeof window === "undefined") return null;
  if (!SSO_ENABLED) return null;
  if (alreadyTried()) return null;
  if (onAuthRoute()) return null;

  // One probe/attempt per tab session, regardless of outcome.
  markSsoTried();

  // Only hand the page over to the broker if it actually answers.
  if (!(await brokerReachable())) return null;

  const next = window.location.pathname + window.location.search;
  const ret = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
  window.location.assign(`${LOWHIGH_BASE}/api/sso/check?return=${encodeURIComponent(ret)}`);
  // The page is navigating away; block so the caller never flips to "anonymous"
  // before the redirect takes effect.
  return new Promise<User | null>(() => {});
}

/**
 * Trade a one-time SSO code (from `/auth/callback?sso_code=...`) for a session.
 * Returns true if a native GraveLens session was established.
 */
export async function exchangeSsoCode(code: string): Promise<boolean> {
  if (!SSO_ENABLED) return false;
  try {
    const res = await fetch(`${LOWHIGH_BASE}/api/sso/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) return false;
    const { token_hash } = (await res.json()) as { token_hash?: string };
    if (!token_hash) return false;
    const supabase = createClient();
    const { error } = await supabase.auth.verifyOtp({ token_hash, type: "magiclink" });
    return !error;
  } catch {
    return false;
  }
}

/**
 * After a successful login on GraveLens, push the session up to the central
 * LowHigh cookie so a later visit to lowhigh.ai is already signed in. Mints a
 * one-time establish code (CORS + Bearer) then top-level redirects to set the
 * first-party cookie, returning to `next`. Best-effort: resolves false (without
 * navigating) if SSO isn't configured or the mint fails, so login still completes.
 */
export async function establishCentralSession(next = "/"): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (!SSO_ENABLED) return false;
  try {
    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return false;

    const res = await fetch(`${LOWHIGH_BASE}/api/sso/begin-establish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const { code } = (await res.json()) as { code?: string };
    if (!code) return false;

    const path = next.startsWith("/") ? next : `/${next}`;
    const ret = `${window.location.origin}${path}`;
    window.location.assign(
      `${LOWHIGH_BASE}/api/sso/establish?code=${encodeURIComponent(code)}&return=${encodeURIComponent(ret)}`
    );
    return true;
  } catch {
    return false;
  }
}
