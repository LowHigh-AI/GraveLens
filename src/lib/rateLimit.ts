import "server-only";
import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase/service";

/**
 * Supabase-backed sliding-window rate limiter for GraveLens API routes.
 *
 * SECURITY: writes go through the SERVICE-ROLE client, not the user's session
 * client. The `gravelens_rate_limits` table is locked down from the
 * authenticated/anon roles (see the gravelens security migration), so a user
 * cannot read or reset their own counter to bypass the limit — only this
 * server-side code (which bypasses RLS) can touch it.
 *
 * State persists across cold starts and server instances. A single row per
 * user holds one timestamp array per bucket, so multiple route limits coexist:
 *   requests jsonb = { "analyze": [<ms>, ...], "tts": [...], ... }
 *
 * Fails OPEN on any DB error (mirrors the token gate): better to under-limit
 * than to break a legitimate request on an infra fault.
 */

interface BucketLimit {
  windowMs: number;
  max: number;
  /** Seconds to advertise in the Retry-After header on a 429. */
  retryAfter: number;
}

const HOUR = 60 * 60 * 1000;

/**
 * Per-bucket limits. AI routes are the costly ones; the two heavy external
 * fan-out routes (lookup, enrich-cemetery) get looser limits to prevent using
 * GraveLens as an amplifier against Overpass/Wikipedia/Nominatim.
 */
export const RATE_LIMITS = {
  analyze:   { windowMs: HOUR, max: 20,  retryAfter: 60 },
  story:     { windowMs: HOUR, max: 40,  retryAfter: 60 },
  narrative: { windowMs: HOUR, max: 40,  retryAfter: 60 },
  cultural:  { windowMs: HOUR, max: 40,  retryAfter: 60 },
  tts:       { windowMs: HOUR, max: 60,  retryAfter: 60 },
  lookup:    { windowMs: HOUR, max: 120, retryAfter: 30 },
  enrich:    { windowMs: HOUR, max: 60,  retryAfter: 30 },
  // Tighter sub-limit for the cache-bypassing force-refresh path.
  "enrich-force": { windowMs: HOUR, max: 10, retryAfter: 60 },
  // Shared bucket for the direct external genealogy record routes
  // (NARA, SSDI, FamilySearch, newspapers) so an authed user cannot loop
  // GraveLens as an amplifier against those upstreams. Generous, since a
  // result page can legitimately trigger several per visit.
  genealogy: { windowMs: HOUR, max: 150, retryAfter: 30 },
} as const satisfies Record<string, BucketLimit>;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

/**
 * Core check. Returns true if the request should be BLOCKED (limit exceeded).
 * Records the request when allowed. Fails open (returns false) on any error.
 */
export async function checkRateLimit(userId: string, bucket: RateLimitBucket): Promise<boolean> {
  const { windowMs, max } = RATE_LIMITS[bucket];
  try {
    const supabase = getServiceClient();
    if (!supabase) return false; // no service client configured — fail open

    const now = Date.now();
    const cutoff = now - windowMs;

    const { data } = await supabase
      .from("gravelens_rate_limits")
      .select("requests")
      .eq("user_id", userId)
      .maybeSingle();

    // requests is a jsonb object keyed by bucket → number[] of epoch-ms stamps.
    const all = (data?.requests ?? {}) as Record<string, number[]>;
    const recent = (all[bucket] ?? []).filter((t) => t > cutoff);

    if (recent.length >= max) return true;

    recent.push(now);
    const next = { ...all, [bucket]: recent };

    await supabase
      .from("gravelens_rate_limits")
      .upsert({ user_id: userId, requests: next, updated_at: new Date().toISOString() });

    return false;
  } catch {
    // If Supabase is unavailable, fail open (allow the request).
    return false;
  }
}

/**
 * Route guard. Returns a 429 NextResponse when the limit is exceeded, otherwise
 * null (proceed). Mirrors requireTokens()'s shape.
 */
export async function requireRateLimit(
  userId: string,
  bucket: RateLimitBucket
): Promise<NextResponse | null> {
  const blocked = await checkRateLimit(userId, bucket);
  if (!blocked) return null;
  return NextResponse.json(
    { error: "Too many requests. Please try again later." },
    { status: 429, headers: { "Retry-After": String(RATE_LIMITS[bucket].retryAfter) } }
  );
}
