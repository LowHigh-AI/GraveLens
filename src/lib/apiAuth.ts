import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

/**
 * Validates the Supabase session from the incoming request cookies.
 * Returns { userId, accessToken } on success, or a 401 NextResponse on failure.
 *
 * `accessToken` is the user's Supabase JWT, read from the session cookie. It is
 * forwarded as a Bearer token when calling LowHigh's cross-origin endpoints
 * (e.g. /api/usage/log). It may be null if only a stale cookie is present;
 * callers that need it should treat null as "skip the LowHigh call".
 *
 * Usage in a route handler:
 *   const auth = await requireAuth();
 *   if (auth instanceof NextResponse) return auth;
 *   // auth.userId, auth.accessToken
 */
export async function requireAuth(): Promise<
  { userId: string; accessToken: string | null } | NextResponse
> {
  const supabase = await createClient();
  // getUser() verifies the token server-side (authoritative).
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // getSession() is a cookie read (no network) — used only to obtain the JWT to
  // forward to LowHigh. Identity is already established via getUser() above.
  const { data: { session } } = await supabase.auth.getSession();
  return { userId: user.id, accessToken: session?.access_token ?? null };
}
