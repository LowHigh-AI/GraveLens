/**
 * Referral helpers (browser-side).
 *
 * A referred visitor lands on GraveLens with `?ref=<code>`. We persist the code
 * immediately (even while signed out, so it survives the sign-up flow), then
 * attribute it once the user is authenticated. Reads/writes go through
 * GraveLens's own same-origin /api/referrals routes (service role server-side).
 */

const REF_KEY = "gl_ref_code";

export interface ReferralConversion {
  firstName: string | null;
  tierLevel: number | null;
  goalSlug: string | null;
  status: string;
  paidAt: string | null;
  attributedAt: string | null;
}

export interface ReferralData {
  code: string;
  /** Shareable link into GraveLens, built from the current origin. */
  url: string;
  stats: { paid: number; pending: number };
  conversions: ReferralConversion[];
}

/** Capture a `?ref=` param into localStorage. Safe to call on every load. */
export function captureRefFromUrl(): void {
  if (typeof window === "undefined") return;
  try {
    const code = new URLSearchParams(window.location.search).get("ref")?.trim();
    if (code && /^[A-Za-z0-9-]{3,32}$/.test(code)) {
      localStorage.setItem(REF_KEY, code);
    }
  } catch {
    /* ignore */
  }
}

/**
 * If a referral code was captured, attribute it for the now-signed-in user.
 * Clears the stored code once the server has processed it (success path); leaves
 * it in place on network failure so a later load can retry.
 */
export async function attributeStoredRef(): Promise<void> {
  if (typeof window === "undefined") return;
  let code: string | null = null;
  try {
    code = localStorage.getItem(REF_KEY);
  } catch {
    return;
  }
  if (!code) return;

  try {
    const res = await fetch("/api/referrals/attribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    // Processed (attributed or rejected) — don't keep retrying a known outcome.
    if (res.ok || res.status === 400) {
      try {
        localStorage.removeItem(REF_KEY);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* network error — keep the code for a later retry */
  }
}

/** Fetch the user's referral code + conversions, building the shareable URL. */
export async function fetchReferral(): Promise<ReferralData | null> {
  try {
    const res = await fetch("/api/referrals", { method: "GET" });
    if (!res.ok) return null;
    const data = (await res.json()) as Omit<ReferralData, "url">;
    if (!data?.code) return null;
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return { ...data, url: `${origin}/?ref=${encodeURIComponent(data.code)}` };
  } catch {
    return null;
  }
}
