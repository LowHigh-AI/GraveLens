"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import BrandLogo from "@/components/ui/BrandLogo";
import { createClient } from "@/lib/supabase/browser";
import { establishCentralSession } from "@/lib/ssoClient";
import { syncLocalToCloud, hasEverSynced, pullExplorerPoints } from "@/lib/cloudSync";

type Mode = "signin" | "signup" | "confirm";

// This app's brand + canonical base URL, stashed in user metadata at signup so the
// shared Supabase Auth emails render the right brand ({{ .Data.app_name }}) and route
// the confirmation link back to the right domain ({{ .Data.app_base_url }}).
const APP_NAME = "GraveLens";
const APP_BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (typeof window !== "undefined" ? window.location.origin : "");

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/";
  const authError = searchParams.get("error");

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [resent, setResent] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState(
    authError === "auth_failed" ? "Sign-in failed. Please try again." : ""
  );

  // Redirect away if already signed in
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }: { data: { user: import("@supabase/supabase-js").User | null } }) => {
      if (data?.user) router.replace(next);
    });
  }, [next, router]);

  const callbackUrl = useCallback(
    () => `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
    [next]
  );

  // After a local session is established, push it up to the shared LowHigh SSO
  // cookie so a later visit to lowhigh.ai is already signed in. If SSO isn't
  // enabled this no-ops and we navigate to `next` ourselves.
  const finishLogin = useCallback(async () => {
    const navigating = await establishCentralSession(next);
    if (!navigating) router.replace(next);
  }, [next, router]);

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setNotice("");

    const supabase = createClient();
    try {
      if (mode === "signin") {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) { setError(error.message); return; }
        if (data.user) await runPostLoginSync(supabase, data.user.id);
        await finishLogin();
      } else {
        // Sign up — if "Confirm email" is enabled in Supabase, this sends a
        // confirmation email with an 8-character OTP and session is null. We show
        // the in-app verify screen. If confirmation is disabled, Supabase
        // returns a session immediately and we sign the user in directly.
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            // Seed the display_name metadata shape LowHigh's UI expects, so a
            // user who first signs up via GraveLens has a usable LowHigh profile.
            // app_base_url / app_name drive the shared Supabase Auth email links + copy.
            data: {
              display_name: email.split("@")[0],
              app_base_url: APP_BASE_URL,
              app_name: APP_NAME,
            },
            emailRedirectTo: callbackUrl(),
          },
        });
        if (error) { setError(error.message); return; }
        // Supabase returns a user with empty identities when the email is
        // already registered — it won't send an email and won't error (by design).
        if (data.user && (data.user.identities?.length ?? 0) === 0) {
          setError("An account with this email already exists. Please sign in instead.");
          return;
        }
        if (data.session) {
          // Email confirmation is disabled — signed in immediately
          await runPostLoginSync(supabase, data.session.user.id);
          await finishLogin();
        } else {
          // Email confirmation is enabled — tell user to check their email
          setMode("confirm");
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setError("");
    setNotice("");
    setOauthLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: callbackUrl() },
    });
    // On success the browser navigates to Google; only reached on error.
    if (error) { setError(error.message); setOauthLoading(false); }
  };

  const handleMagicLink = async () => {
    if (!email) { setError("Enter your email first, then request a magic link."); return; }
    setError("");
    setNotice("");
    setLoading(true);
    const supabase = createClient();
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: callbackUrl() },
      });
      if (error) { setError(error.message); return; }
      setNotice(`We emailed a sign-in link to ${email}. Open it on this device to continue.`);
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email) { setError("Enter your email first, then reset your password."); return; }
    setError("");
    setNotice("");
    setLoading(true);
    const supabase = createClient();
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      });
      if (error) { setError(error.message); return; }
      setNotice(`Password reset link sent to ${email}. Open it to get back into your account.`);
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setResent(false);
    setError("");
    const supabase = createClient();
    await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: callbackUrl() },
    });
    setResent(true);
  };

  // ── Confirm email screen ───────────────────────────────────────────────────
  if (mode === "confirm") {
    return (
      <div
        className="flex flex-col h-full bg-stone-900"
        style={{
          paddingTop: "max(2.5rem, env(safe-area-inset-top))",
          paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
        }}
      >
        <div className="px-5 mb-6">
          <button
            onClick={() => { setMode("signup"); setError(""); setResent(false); }}
            className="flex items-center gap-1.5 text-stone-500 active:text-stone-300 text-sm"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
            Back
          </button>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-6 max-w-sm mx-auto w-full">
          <div className="w-16 h-16 rounded-2xl bg-stone-800 border border-stone-700 flex items-center justify-center mb-6">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
          </div>

          <h1 className="font-serif text-xl text-stone-100 font-semibold text-center mb-2">
            Check your email
          </h1>
          <p className="text-stone-400 text-sm text-center mb-8 leading-relaxed">
            We sent a confirmation link to{" "}
            <span className="text-stone-200">{email}</span>.
            Click the link in that email to activate your account.
          </p>

          {resent && (
            <div className="w-full mb-4 px-4 py-3 rounded-xl text-sm text-stone-300 bg-stone-800 border border-stone-700">
              Confirmation email resent.
            </div>
          )}

          <div className="w-full flex flex-col gap-3">
            <button
              onClick={() => { setMode("signin"); setError(""); setResent(false); }}
              className="w-full h-12 rounded-xl font-semibold text-[#1a1917] text-sm transition-all active:scale-[0.97]"
              style={{ background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }}
            >
              Back to Sign In
            </button>
            <button
              onClick={handleResend}
              className="w-full h-10 rounded-xl border border-stone-700 text-stone-400 text-sm transition-all active:scale-[0.97]"
            >
              Resend confirmation email
            </button>
          </div>

          <p className="text-stone-600 text-xs text-center mt-6">
            {"Can't find it? Check your "}<span className="text-stone-400">spam or junk</span> folder.
          </p>
        </div>
      </div>
    );
  }

  // ── Sign in / Sign up screen ───────────────────────────────────────────────
  return (
    <div
      className="flex flex-col h-full bg-stone-900"
      style={{
        paddingTop: "max(2.5rem, env(safe-area-inset-top))",
        paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
      }}
    >
      <div className="px-5 mb-6">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1.5 text-stone-500 active:text-stone-300 text-sm"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
          Back
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 max-w-sm mx-auto w-full">
        <div className="flex items-center gap-2.5 mb-8">
          <BrandLogo size={28} color="var(--t-gold-500)" />
          <span className="font-serif text-2xl font-semibold tracking-wide">
            <span className="text-stone-50">Grave</span><span style={{ color: "var(--t-gold-500)" }}>Lens</span>
          </span>
        </div>

        <h1 className="font-serif text-xl text-stone-100 font-semibold text-center mb-1">
          {mode === "signin" ? "Welcome back" : "Create your LowHigh account"}
        </h1>
        <p className="text-stone-400 text-sm text-center mb-8">
          {mode === "signin"
            ? "Sign in with your LowHigh account to scan and sync your archive."
            : "One LowHigh account works across GraveLens and LowHigh."}
        </p>

        {error && (
          <div className="w-full mb-4 px-4 py-3 rounded-xl text-sm text-red-300 bg-red-900/20 border border-red-800/40">
            {error}
          </div>
        )}
        {notice && (
          <div className="w-full mb-4 px-4 py-3 rounded-xl text-sm text-stone-200 bg-stone-800 border border-stone-700">
            {notice}
          </div>
        )}

        {/* Google OAuth */}
        <button
          onClick={handleGoogle}
          disabled={oauthLoading || loading}
          className="w-full h-12 rounded-xl border border-stone-700 bg-stone-800 text-stone-100 text-sm font-medium flex items-center justify-center gap-2.5 transition-all active:scale-[0.97] disabled:opacity-60"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.24 1.4-1 2.6-2.1 3.4l3.4 2.6c2-1.8 3.1-4.5 3.1-7.7 0-.7-.06-1.4-.18-2z" transform="translate(0 -1)" />
            <path fill="#4285F4" d="M12 22c2.7 0 5-1 6.6-2.6l-3.4-2.6c-.95.64-2.16 1-3.2 1-2.5 0-4.6-1.7-5.3-4H3.2v2.5C4.9 19.8 8.2 22 12 22z" />
            <path fill="#FBBC05" d="M6.7 13.8c-.2-.6-.3-1.2-.3-1.8s.1-1.2.3-1.8V7.7H3.2C2.6 9 2.2 10.4 2.2 12s.4 3 .999 4.3z" />
            <path fill="#34A853" d="M12 6.4c1.5 0 2.8.5 3.8 1.5l2.9-2.9C16.97 3.4 14.7 2.4 12 2.4 8.2 2.4 4.9 4.6 3.2 7.7l3.5 2.7c.7-2.3 2.8-4 5.3-4z" />
          </svg>
          {oauthLoading ? "Redirecting…" : "Continue with Google"}
        </button>

        <div className="w-full flex items-center gap-3 my-4">
          <div className="h-px flex-1 bg-stone-800" />
          <span className="text-stone-600 text-xs">or</span>
          <div className="h-px flex-1 bg-stone-800" />
        </div>

        <form onSubmit={handleEmailAuth} className="w-full flex flex-col gap-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email address"
            required
            autoComplete="email"
            className="w-full h-12 rounded-xl bg-stone-800 border border-stone-700 px-4 text-stone-100 text-base placeholder-stone-500 focus:outline-none focus:border-stone-500"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            required
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            className="w-full h-12 rounded-xl bg-stone-800 border border-stone-700 px-4 text-stone-100 text-base placeholder-stone-500 focus:outline-none focus:border-stone-500"
          />
          <button
            type="submit"
            disabled={loading || oauthLoading}
            className="w-full h-12 rounded-xl font-semibold text-[#1a1917] text-sm transition-all active:scale-[0.97] disabled:opacity-60"
            style={{ background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }}
          >
            {loading ? "Please wait…" : mode === "signin" ? "Sign In" : "Create Account"}
          </button>
        </form>

        {/* Secondary email options */}
        <div className="w-full flex items-center justify-between mt-3 text-sm">
          <button
            onClick={handleMagicLink}
            disabled={loading || oauthLoading}
            className="text-stone-400 active:text-stone-200 disabled:opacity-60"
          >
            Email me a magic link
          </button>
          {mode === "signin" && (
            <button
              onClick={handleForgotPassword}
              disabled={loading || oauthLoading}
              className="text-stone-400 active:text-stone-200 disabled:opacity-60"
            >
              Forgot password?
            </button>
          )}
        </div>

        <p className="text-stone-500 text-sm mt-6">
          {mode === "signin" ? "Don't have an account? " : "Already have an account? "}
          <button
            onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); setNotice(""); }}
            className="text-stone-300 underline"
          >
            {mode === "signin" ? "Sign up" : "Sign in"}
          </button>
        </p>
      </div>

      <div className="px-6 text-center">
        <button onClick={() => router.back()} className="text-stone-600 text-sm">
          Browse my saved archive
        </button>
      </div>
    </div>
  );
}

async function runPostLoginSync(
  supabase: ReturnType<typeof createClient>,
  userId: string
) {
  // Always pull Explorer points on sign-in so achievements are current on any device
  pullExplorerPoints(supabase, userId).catch((err) =>
    console.warn("[Sync] Explorer points pull failed:", err)
  );

  // Grave migration only runs once (it's a bulk operation)
  if (hasEverSynced()) return;
  syncLocalToCloud(supabase, userId).catch((err) =>
    console.warn("[Sync] Post-login migration failed:", err)
  );
}
