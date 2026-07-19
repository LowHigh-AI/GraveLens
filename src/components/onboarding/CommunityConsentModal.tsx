"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import BrandLogo from "@/components/ui/BrandLogo";
import { useAuth } from "@/lib/auth";
import { createClient } from "@/lib/supabase/browser";
import { upsertUserProfile, fetchOwnProfile, bulkSetGravesPublic } from "@/lib/community";
import { patchSettings } from "@/lib/settings";

// Per-device flag: once the user has answered the community-sharing prompt we
// never show it again on this device. The cross-device source of truth is the
// profile's share_all_by_default column (mirrored into local settings below).
const SEEN_KEY = "gl_community_consent_seen";
// The prompt only makes sense after the intro carousel; keep them from stacking.
const ONBOARDING_KEY = "gl_onboarding_seen";

/**
 * First-run community-sharing consent. Shown once, after sign-in, when the user
 * has not yet answered on this device. "On" is pre-selected — tapping Continue
 * opts in — but it is a visible, consented choice, and can be changed any time
 * in Settings → Privacy & Community.
 */
export default function CommunityConsentModal() {
  const { user, loading } = useAuth();
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [share, setShare] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (loading || !user) return;
    let active = true;

    (async () => {
      // Hydrate the local mirror from the profile so a prior opt-out on another
      // device is respected by this device's sync path — even if we don't
      // re-prompt here.
      try {
        const profile = await fetchOwnProfile(createClient(), user.id);
        if (!active) return;
        if (profile) {
          patchSettings({ shareWithCommunity: profile.shareAllByDefault });
          setShare(profile.shareAllByDefault);
        }
      } catch { /* offline — fall back to local default */ }

      if (!active) return;
      const seen = localStorage.getItem(SEEN_KEY);
      const onboarded = localStorage.getItem(ONBOARDING_KEY);
      if (!seen && onboarded) setVisible(true);
    })();

    return () => { active = false; };
  }, [user, loading]);

  const choose = async (next: boolean) => {
    setSaving(true);
    localStorage.setItem(SEEN_KEY, "1");
    // Local mirror first so the sync path is correct immediately, even offline.
    patchSettings({ shareWithCommunity: next });
    if (user) {
      try {
        const supabase = createClient();
        await Promise.all([
          upsertUserProfile(supabase, user.id, { shareAllByDefault: next }),
          // Apply to anything already scanned before this choice (usually none).
          bulkSetGravesPublic(supabase, user.id, next),
        ]);
      } catch { /* non-fatal — local mirror + flag already persisted */ }
    }
    setVisible(false);
    setSaving(false);
  };

  if (!mounted || !visible) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-end sm:items-center justify-center"
      style={{
        background: "rgba(10, 9, 8, 0.55)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        paddingBottom: "calc(80px + env(safe-area-inset-bottom, 16px))",
      }}
    >
      <div
        className="relative w-full sm:max-w-sm mx-auto rounded-t-3xl sm:rounded-3xl overflow-hidden"
        style={{ background: "#121110", border: "1px solid rgba(255,255,255,0.07)" }}
      >
        <div className="h-px w-full" style={{ background: "linear-gradient(90deg, transparent, var(--t-gold-500), transparent)" }} />

        <div className="px-7 pt-8 pb-7 flex flex-col items-center gap-6 text-center">
          <div className="relative flex items-center justify-center w-20 h-20">
            <div className="absolute inset-0 rounded-full bg-[var(--t-gold-500)]/10 blur-2xl" />
            <BrandLogo size={56} color="var(--t-gold-500)" />
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="font-serif text-2xl font-semibold text-stone-100 leading-snug">
              Share your discoveries?
            </h2>
            <p className="text-stone-400 text-sm leading-relaxed">
              When on, the graves you scan appear on the community map, helping other
              explorers and relatives find them. Your archive stays yours either way.
            </p>
            <p className="text-stone-500 text-xs leading-relaxed mt-1">
              You can change this any time in Settings → Privacy &amp; Community.
            </p>
          </div>

          {/* Choice selector — "On" pre-selected */}
          <div className="flex w-full gap-2 p-1 rounded-2xl" style={{ background: "rgba(255,255,255,0.04)" }}>
            <button
              onClick={() => setShare(true)}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all"
              style={share
                ? { background: "var(--t-gold-500)", color: "#1a1917" }
                : { color: "var(--stone-400, #a8a29e)" }}
              aria-pressed={share}
            >
              Share
            </button>
            <button
              onClick={() => setShare(false)}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all"
              style={!share
                ? { background: "rgba(255,255,255,0.12)", color: "#e7e5e4" }
                : { color: "var(--stone-400, #a8a29e)" }}
              aria-pressed={!share}
            >
              Keep private
            </button>
          </div>

          <button
            onClick={() => choose(share)}
            disabled={saving}
            className="w-full py-3 rounded-2xl text-sm font-semibold transition-all active:scale-[0.98] disabled:opacity-60"
            style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
