"use client";

// Auth callback page — the single return point for every cross-domain / email
// auth round-trip:
//   1. OAuth (Google), magic link, email confirmation, recovery — exchange the
//      code/token_hash for a session, then push it up to the central LowHigh SSO
//      cookie so lowhigh.ai is signed in too.
//   2. SSO restore (?sso_code=...) — trade the one-time code for a session that
//      already exists on lowhigh.ai; do NOT push it back up.
//   3. SSO miss (?sso=none) — the central session was empty; proceed anonymously.
// iOS PWA popup flow is preserved: we still try window.close() + a visible
// fallback button when no SSO redirect is in flight.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import BrandLogo from "@/components/ui/BrandLogo";
import { createClient } from "@/lib/supabase/browser";
import { exchangeSsoCode, establishCentralSession, markSsoTried } from "@/lib/ssoClient";

type Status = "loading" | "success" | "error";

export default function AuthCallbackPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ssoCode = params.get("sso_code");
    const ssoMiss = params.get("sso");
    const code = params.get("code");
    const tokenHash = params.get("token_hash");
    const type = params.get("type") ?? "signup";
    // Only allow same-origin relative paths — reject absolute ("https://evil.com")
    // and protocol-relative ("//evil.com") values to prevent an open redirect.
    const rawNext = params.get("next") ?? "/";
    const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";
    const oauthError = params.get("error");

    if (oauthError) {
      setErrorMsg(oauthError.replace(/_/g, " "));
      setStatus("error");
      return;
    }

    // SSO silent-check came back empty — no central session. Proceed anonymously
    // to the originally requested page (gated pages will route to /login).
    if (!ssoCode && ssoMiss === "none") {
      markSsoTried();
      router.replace(next);
      return;
    }

    // SSO restore: trade the one-time code for a native session. The session
    // originates from the central cookie, so we do NOT push it back up.
    if (ssoCode) {
      exchangeSsoCode(ssoCode).then((ok: boolean) => {
        if (!ok) {
          markSsoTried();
          router.replace(`/login?next=${encodeURIComponent(next)}`);
          return;
        }
        setStatus("success");
        setTimeout(() => router.replace(next), 200);
      });
      return;
    }

    if (!code && !tokenHash) {
      setErrorMsg("No authentication code received.");
      setStatus("error");
      return;
    }

    const supabase = createClient();

    const onError = (message: string) => {
      setErrorMsg(message);
      setStatus("error");
    };

    const onSuccess = async () => {
      setStatus("success");

      // Fresh login — push the session up to the central SSO cookie so lowhigh.ai
      // is signed in too. If this performs a top-level redirect we're done.
      const navigating = await establishCentralSession(next);
      if (navigating) return;

      // Popup flow: try to close this tab so the user lands back in the PWA.
      try {
        window.close();
      } catch {
        // Blocked — fall through to the redirect/button below.
      }

      // Redirect flow (or if window.close() was blocked): navigate to the app.
      setTimeout(() => {
        router.replace(next);
      }, 400);
    };

    // token_hash is used by all email links (confirmation, recovery, magic link,
    // email change). verifyOtp requires no stored PKCE verifier, so it works even
    // when the link is opened on a different device/browser than started signup.
    if (tokenHash) {
      supabase.auth
        .verifyOtp({ token_hash: tokenHash, type: type as "signup" | "magiclink" | "recovery" | "email_change" | "email" })
        .then(({ error }: { error: import("@supabase/supabase-js").AuthError | null }) =>
          error ? onError(error.message) : onSuccess()
        );
      return;
    }

    // OAuth / PKCE (?code=). @supabase/ssr's createBrowserClient forces
    // detectSessionInUrl: true (un-overridable), so the client already redeems the
    // code on init. Calling exchangeCodeForSession here too would double-spend the
    // one-time verifier and throw "PKCE code verifier not found in storage". Instead,
    // wait for the session detectSessionInUrl establishes (it resolves asynchronously).
    (async () => {
      for (let i = 0; i < 20; i++) {
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          onSuccess();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      onError("Sign-in timed out. Please try again.");
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="flex flex-col items-center justify-center h-full bg-stone-900 px-6 text-center"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div className="flex items-center gap-2.5 mb-10">
        <BrandLogo size={28} color="var(--t-gold-500)" />
        <span className="font-serif text-2xl font-semibold tracking-wide">
          <span className="text-stone-50">Grave</span><span style={{ color: "var(--t-gold-500)" }}>Lens</span>
        </span>
      </div>

      {status === "loading" && (
        <>
          <div className="w-5 h-5 border-2 border-stone-600 border-t-stone-200 rounded-full animate-spin mb-4" />
          <p className="text-stone-400 text-sm">Signing you in…</p>
        </>
      )}

      {status === "success" && (
        <>
          <p className="text-stone-200 text-base font-medium mb-1">Signed in</p>
          <p className="text-stone-500 text-sm mb-8">Taking you back to the app…</p>
          {/* Visible button in case auto-redirect or window.close() both fail */}
          <Link
            href="/"
            className="h-12 px-8 rounded-xl font-semibold text-[#1a1917] text-sm flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }}
          >
            Open GraveLens
          </Link>
        </>
      )}

      {status === "error" && (
        <>
          <p className="text-red-400 text-sm mb-6 capitalize">{errorMsg || "Sign-in failed."}</p>
          <Link
            href="/login"
            className="h-12 px-8 rounded-xl border border-stone-700 text-stone-300 text-sm flex items-center justify-center"
          >
            Try Again
          </Link>
        </>
      )}
    </div>
  );
}
