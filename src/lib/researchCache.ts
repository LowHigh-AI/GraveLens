/**
 * Shared cache for AI-generated derivative content (narrative / story / cultural).
 *
 * These routes call Claude, which costs tokens on every invocation. Because the
 * output is a pure function of the request inputs (and those inputs derive from
 * public-record research, never from a user's private notes), identical requests
 * from any authenticated user can safely reuse a single cached result.
 *
 * SERVER-ONLY: this module imports node:crypto and must never be pulled into a
 * client bundle. Keep it out of files imported by "use client" components (that
 * is why these helpers live here and not in src/lib/community.ts).
 */

import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type AiContentKind = "narrative" | "story" | "cultural";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Deterministic JSON serialization with sorted object keys, so equivalent
 *  inputs produce an identical string regardless of property insertion order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * Build a stable cache key from the request inputs.
 * Callers should strip volatile fields (e.g. promptId) before passing the input.
 */
export function aiContentCacheKey(input: unknown): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

/**
 * Read a cached AI payload. Returns null on miss or when the entry has expired.
 * Non-fatal — callers should treat a thrown/absent result as a cache miss and
 * generate fresh content.
 */
export async function getAiContentCache(
  supabase: SupabaseClient,
  kind: AiContentKind,
  cacheKey: string
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from("gravelens_ai_content_cache")
    .select("payload, expires_at")
    .eq("kind", kind)
    .eq("cache_key", cacheKey)
    .maybeSingle();

  if (error || !data) return null;
  if (new Date(data.expires_at) < new Date()) return null; // stale
  return data.payload as Record<string, unknown>;
}

/**
 * Write a generated AI payload to the shared cache (fire-and-forget; errors
 * are non-fatal). Only public-record-derived content should be stored here.
 */
export async function saveAiContentCache(
  supabase: SupabaseClient,
  kind: AiContentKind,
  cacheKey: string,
  payload: unknown
): Promise<void> {
  await supabase.from("gravelens_ai_content_cache").upsert({
    kind,
    cache_key: cacheKey,
    payload,
    generated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ONE_YEAR_MS).toISOString(),
  });
}
