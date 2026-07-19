import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Shared service-role Supabase client factory (server-only).
 *
 * The service-role key bypasses RLS, so this MUST never be imported into client
 * code. Used for trusted server-side operations that must not be forgeable by
 * the end user — e.g. the token gate (v_token_balances) and the rate limiter
 * (gravelens_rate_limits, which is otherwise locked down from the authenticated
 * role so a user cannot reset their own counter).
 *
 * Returns null when the env vars are absent so callers can degrade gracefully.
 */
export function getServiceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
