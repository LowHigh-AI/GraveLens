"use client";

/**
 * Shared auth context for GraveLens.
 *
 * One `getUser()` + one `onAuthStateChange` subscription for the whole app, so
 * every consumer reads a single source of truth and we never flash the wrong
 * logged-in/out state (a binary token check would — see the LowHigh
 * auth-loading-tristate note). This is also the single place that hosts the
 * cross-domain SSO silent-check (see ssoClient.attemptSilentSignIn).
 *
 * `useAuth()` keeps the historical `{ user, loading }` shape so existing callers
 * (ProfileBadge, EcosystemProvider, billing, settings, etc.) work unchanged.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/browser";
import { attemptSilentSignIn } from "@/lib/ssoClient";

interface AuthValue {
  user: User | null;
  /** True until the initial session has been resolved. Gate auth decisions on this. */
  loading: boolean;
}

const AuthContext = createContext<AuthValue>({ user: null, loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    let active = true;

    supabase.auth.getUser().then(async ({ data }: { data: { user: User | null } }) => {
      if (!active) return;
      if (data.user) {
        setUser(data.user);
        setLoading(false);
        return;
      }
      // No local session — try a one-shot cross-domain SSO restore against the
      // LowHigh authority before declaring the user signed out. Fail-open: if it
      // can't restore (no central session / broker down / already tried), we just
      // resolve as anonymous and the normal login flow takes over. This may
      // navigate away (top-level redirect), in which case the resolve below is moot.
      const restored = await attemptSilentSignIn();
      if (!active) return;
      setUser(restored);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      (_event: import("@supabase/supabase-js").AuthChangeEvent, session: import("@supabase/supabase-js").Session | null) => {
        setUser(session?.user ?? null);
      }
    );

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  // Memoize so consumers don't re-render on every provider render — only when
  // user/loading actually change.
  const value = useMemo(() => ({ user, loading }), [user, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
