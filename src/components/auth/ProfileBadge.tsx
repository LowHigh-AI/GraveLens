"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { createClient } from "@/lib/supabase/browser";
import { syncLocalToCloud, pushExplorerPoints, notifyArchiveSynced, ARCHIVE_SYNCED_EVENT } from "@/lib/cloudSync";
import { countUnsyncedGraves } from "@/lib/storage";
import { loadUnlocks, totalXP, getRank } from "@/lib/achievements";
import { useModalA11y } from "@/lib/useModalA11y";
import SettingsPanel from "./SettingsPanel";
import UserAvatar from "./UserAvatar";
import { RankInsignia, getRankColor } from "@/components/ui/RankInsignia";
import { fetchOwnProfile } from "@/lib/community";
import { useEcosystem } from "@/components/ecosystem/EcosystemProvider";
import { formatTokens } from "@/lib/lowhighClient";
import { Check, CloudOff, CloudUpload, Gift, Tag, X } from "lucide-react";

import { createPortal } from "react-dom";

export default function ProfileBadge() {
  const { user, loading } = useAuth();
  const eco = useEcosystem();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rankLevel, setRankLevel] = useState(1);
  const [rankTitle, setRankTitle] = useState("The Wanderer");
  const [profileUsername, setProfileUsername] = useState<string | undefined>(undefined);
  const [mounted, setMounted] = useState(false);
  const [unsyncedCount, setUnsyncedCount] = useState(0);
  const [online, setOnline] = useState(true);
  const accountModalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Track connectivity so the backlog row can offer "Back up now" only when it
  // can actually succeed, and reassure ("uploads when you're back online")
  // otherwise. Auto-backup already retries on reconnect.
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  // Track how many local scans still need backing up (offline / signed-out
  // captures with no syncedAt). Refresh on sign-in and whenever the menu opens.
  useEffect(() => {
    if (!user) { setUnsyncedCount(0); return; }
    const refresh = () => { countUnsyncedGraves().then(setUnsyncedCount).catch(() => {}); };
    refresh();
    // Background auto-backup dispatches this when it clears the backlog.
    window.addEventListener(ARCHIVE_SYNCED_EVENT, refresh);
    return () => window.removeEventListener(ARCHIVE_SYNCED_EVENT, refresh);
  }, [user?.id, open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const unlocks = loadUnlocks();
    const xp = totalXP(unlocks);
    const rank = getRank(xp);
    setRankLevel(rank.level);
    setRankTitle(rank.title);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    fetchOwnProfile(supabase, user.id)
      .then((p) => { if (p?.username) setProfileUsername(p.username); })
      .catch(() => {});
  }, [user]);

  // Dialog a11y for the account modal: focus trap, Escape to close, return focus.
  useModalA11y(accountModalRef, close, open && mounted);

  if (loading) {
    return <div className="w-8 h-8 rounded-full bg-stone-800 animate-pulse" />;
  }

  const accountDisplayName = user?.user_metadata?.display_name as string | undefined;
  const avatarUrl = user?.user_metadata?.avatar_url as string | undefined;
  const displayName = profileUsername ||
                      accountDisplayName ||
                      user?.email?.split("@")[0] ||
                      "Explorer";
  const initials = user
    ? (profileUsername || accountDisplayName || user.email || "EX").slice(0, 2).toUpperCase()
    : null;

  function close() {
    setOpen(false);
    setSyncResult(null);
  }

  const handleSync = async () => {
    if (!user) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const supabase = createClient();
      const [{ failed, firstError }] = await Promise.all([
        syncLocalToCloud(supabase, user.id),
        pushExplorerPoints(supabase, user.id).catch(() => {}),
      ]);
      // Success needs no message — the row flips to the "all backed up" state.
      // Only a failure leaves a backlog, so only then do we surface a reason.
      setSyncResult(
        failed > 0
          ? {
              text: firstError
                ? `Couldn't back up ${failed}: ${firstError}`
                : `${failed} scan${failed !== 1 ? "s" : ""} couldn't back up. Please try again.`,
              tone: "warn",
            }
          : null
      );
      // Refresh the pending count (badge + row state) everywhere.
      notifyArchiveSynced();
    } finally {
      setSyncing(false);
    }
  };

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    close();
    router.push("/");
  };

  const openSettings = () => {
    close();
    setSettingsOpen(true);
  };

  return (
    <>
      {/* Avatar button (signed in) / Sign In pill (signed out) */}
      {user && initials ? (
        <button
          onClick={() => { setOpen((o) => !o); setSyncResult(null); }}
          className="rounded-full transition-all active:scale-95"
          aria-label={unsyncedCount > 0 ? `Account — ${unsyncedCount} scan${unsyncedCount !== 1 ? "s" : ""} need backup` : "Account"}
          aria-expanded={open}
          aria-haspopup="dialog"
        >
          <span className="relative inline-flex shrink-0">
            <UserAvatar avatarUrl={avatarUrl} initials={initials} name={displayName} size={32} />
            {unsyncedCount > 0 && (
              <span
                className="absolute -top-1 -right-1 min-w-4.5 h-4.5 px-1 rounded-full flex items-center justify-center text-[0.62rem] font-bold leading-none text-[#1a1917] ring-2 ring-stone-900"
                style={{ background: "var(--t-gold-500)" }}
                aria-hidden="true"
              >
                {unsyncedCount > 99 ? "99+" : unsyncedCount}
              </span>
            )}
            {/* Persistent low/out-of-tokens dot (shows when the header bar was dismissed). */}
            {eco?.tokenAlert?.dotVisible && (
              <span
                className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-stone-900"
                style={{ background: eco.tokenAlert.level === "out" ? "#f59e0b" : "var(--t-gold-500)" }}
                aria-hidden="true"
              />
            )}
            {/* Redeemable-reward dot — guides the user into the account menu.
                Green = a good thing waiting. Hidden while the numeric backup
                badge occupies the same top-right corner (both point to the menu). */}
            {eco?.claimableRewards?.dotVisible && unsyncedCount === 0 && (
              <span
                className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-stone-900"
                style={{ background: "#10b981" }}
              >
                <span className="sr-only">You have rewards to claim</span>
              </span>
            )}
            {/* Plan-ending dot — final week before a cancellation takes effect.
                Red = needs attention. Follow into the menu to reach /plan. */}
            {eco?.subscriptionAlert?.expiringSoon && (
              <span
                className="absolute -top-0.5 -left-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-stone-900"
                style={{ background: "#ef4444" }}
              >
                <span className="sr-only">Your plan is ending soon</span>
              </span>
            )}
          </span>
        </button>
      ) : (
        <div className="flex items-center gap-2">
          {/* Prospect pricing link (no balance to show yet). Signed-in users
              reach Balance & Rewards from inside the account menu instead. */}
          <Link
            href="/billing"
            aria-label="Pricing"
            title="Pricing"
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-stone-800 text-[var(--t-stone-500)] hover:text-stone-300 hover:bg-stone-700 transition-colors active:scale-95"
          >
            <Tag size={15} strokeWidth={2} />
          </Link>
          <button
            onClick={() => { setOpen((o) => !o); setSyncResult(null); }}
            className="h-8 pl-2 pr-3 rounded-full flex items-center gap-1.5 transition-all active:scale-90 shrink-0"
            style={{ background: "var(--t-stone-700)", border: "1px solid var(--t-stone-600)" }}
            aria-label="Sign in"
            aria-expanded={open}
            aria-haspopup="dialog"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--t-stone-400)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
            </svg>
            <span className="text-[0.78rem] font-semibold text-stone-200">Sign In</span>
          </button>
        </div>
      )}

      {mounted && open && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6">
          {/* Backdrop — pointerdown closes immediately on first touch */}
          <div
            className="absolute inset-0 bg-stone-950/70 backdrop-blur-sm transition-opacity"
            onPointerDown={close}
            aria-hidden="true"
          />

          {/* Modal Box */}
          <div
            ref={accountModalRef}
            role="dialog"
            aria-modal="true"
            aria-label="Account"
            tabIndex={-1}
            className="relative w-full max-w-sm flex flex-col rounded-3xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-200 focus:outline-none"
            style={{
              background: "linear-gradient(180deg, var(--t-stone-800), var(--t-stone-900))",
              border: "1px solid rgba(var(--glass-bg-rgb), 0.08)",
              maxHeight: "90dvh",
            }}
          >
            {/* Subtle close affordance, top-right (in addition to backdrop/Escape). */}
            <button
              onClick={close}
              aria-label="Close"
              className="absolute top-3 right-3 z-10 w-8 h-8 inline-flex items-center justify-center rounded-full text-stone-500 hover:text-stone-200 hover:bg-stone-800/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-500"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="overflow-y-auto flex-1 p-5">
              {user ? (
                <div className="flex flex-col gap-3">
                  {/* User info */}
                  <div className="flex items-center gap-3 py-2">
                    <UserAvatar avatarUrl={avatarUrl} initials={initials} name={displayName} size={48} />
                    <div className="min-w-0 flex-1">
                      <p className="text-stone-100 font-semibold text-base truncate">{displayName}</p>
                      <p className="text-stone-500 text-xs mt-0.5 truncate">{user.email}</p>
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <RankInsignia level={rankLevel} size={15} />
                        <span className="text-[0.75rem] font-medium" style={{ color: getRankColor(rankLevel) }}>
                          {rankTitle}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="h-px bg-stone-800 my-1" />

                  {/* Single row = the labeled destination + a glanceable balance. */}
                  <button
                    onClick={() => { close(); router.push("/rewards"); }}
                    className="w-full h-12 px-4 rounded-2xl border border-stone-700 bg-stone-800 text-stone-200 text-sm font-medium flex items-center justify-between gap-2.5 transition-all active:scale-[0.97]"
                  >
                    <span className="flex items-center gap-2.5">
                      <Gift size={15} strokeWidth={2} />
                      Balance &amp; Rewards
                      {eco?.claimableRewards?.dotVisible && (
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ background: "#10b981" }}
                          aria-hidden="true"
                        />
                      )}
                    </span>
                    {eco && eco.availableTokens != null && (
                      <span className="text-sm font-semibold tabular-nums" style={{ color: "var(--t-gold-500)" }}>
                        {formatTokens(eco.availableTokens)} tokens
                      </span>
                    )}
                  </button>

                  {eco?.subscriptionAlert?.expiringSoon && (
                    <button
                      onClick={() => { close(); router.push("/plan"); }}
                      className="w-full h-12 px-4 rounded-2xl border border-red-500/40 bg-red-500/10 text-stone-100 text-sm font-medium flex items-center justify-between gap-2.5 transition-all active:scale-[0.97]"
                    >
                      <span className="flex items-center gap-2.5">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#ef4444" }} aria-hidden="true" />
                        Your plan is ending
                      </span>
                      <span className="text-xs font-semibold text-red-300">Manage</span>
                    </button>
                  )}

                  <button
                    onClick={openSettings}
                    className="w-full h-12 rounded-2xl border border-stone-700 bg-stone-800 text-stone-200 text-sm font-medium flex items-center justify-center gap-2.5 transition-all active:scale-[0.97]"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3"/>
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                    </svg>
                    Settings
                  </button>

                  <button
                    onClick={handleSignOut}
                    className="w-full h-12 rounded-2xl border border-stone-700 text-stone-400 text-sm font-medium transition-all active:scale-[0.97]"
                  >
                    Sign Out
                  </button>

                  {/* ── Backup status (meta zone) ──────────────────────────────
                      Deliberately below the action stack, paired with the footer
                      as quiet account metadata — backups are automatic (see
                      AutoBackup), so the resting state is a reassurance, not a
                      button. A compact "Back up now" appears ONLY when there's a
                      backlog that can be cleared right now. */}
                  <div className="pt-1 flex flex-col items-center gap-1.5 text-xs">
                    {syncing ? (
                      <span role="status" aria-live="polite" className="flex items-center gap-2 text-stone-500">
                        <span className="w-3 h-3 border-2 border-stone-600 border-t-transparent rounded-full animate-spin" />
                        Backing up…
                      </span>
                    ) : unsyncedCount === 0 ? (
                      <span role="status" className="flex items-center gap-1.5 text-stone-500">
                        <Check size={13} strokeWidth={2.5} />
                        All scans backed up
                      </span>
                    ) : (
                      <>
                        <span
                          role="status"
                          aria-live="polite"
                          className="flex items-center gap-1.5 text-center"
                          style={{ color: "var(--t-gold-400)" }}
                        >
                          {online ? (
                            <CloudUpload size={13} strokeWidth={2} className="shrink-0" />
                          ) : (
                            <CloudOff size={13} strokeWidth={2} className="shrink-0" />
                          )}
                          {unsyncedCount} scan{unsyncedCount !== 1 ? "s" : ""} waiting
                          {online ? " to back up" : " — uploads when you're back online"}
                        </span>

                        {syncResult?.tone === "warn" && (
                          <span
                            className="px-2 text-center wrap-break-word"
                            style={{ color: "var(--t-gold-400)" }}
                          >
                            {syncResult.text}
                          </span>
                        )}

                        {/* Manual action only when it can actually succeed. */}
                        {online && (
                          <button
                            onClick={handleSync}
                            aria-label={`Back up ${unsyncedCount} scan${unsyncedCount !== 1 ? "s" : ""} now`}
                            className="mt-0.5 h-8 px-4 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-all active:scale-[0.97]"
                            style={{ border: "1px solid var(--t-gold-500)", color: "var(--t-gold-400)" }}
                          >
                            <CloudUpload size={13} strokeWidth={2} />
                            Back up now
                          </button>
                        )}
                      </>
                    )}
                  </div>

                  <p className="text-center text-xs text-stone-600 pt-2">
                    © 2026{" "}
                    <a href="https://www.lowhigh.ai" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-stone-400 transition-colors">
                      LowHigh LLC
                    </a>
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="py-2 text-center">
                    <p className="font-serif text-stone-100 font-semibold text-lg mb-2">Sign in to start scanning</p>
                    <p className="text-stone-400 text-sm leading-relaxed px-2">
                      Scanning and AI features run on your LowHigh account. Sign in to capture
                      headstones, sync your archive across devices, and use your shared tokens.
                    </p>
                  </div>
                  <button
                    onClick={() => { close(); router.push("/login"); }}
                    className="w-full h-12 rounded-2xl font-semibold text-[#1a1917] text-sm transition-all active:scale-[0.97] mt-2"
                    style={{ background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }}
                  >
                    Sign In or Create Account
                  </button>
                  <button
                    onClick={openSettings}
                    className="w-full h-12 rounded-2xl border border-stone-700 bg-stone-800 text-stone-200 text-sm font-medium flex items-center justify-center gap-2.5 transition-all active:scale-[0.97]"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3"/>
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                    </svg>
                    Settings
                  </button>

                  <p className="text-center text-xs text-stone-600 pt-2">
                    © 2026{" "}
                    <a href="https://www.lowhigh.ai" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-stone-400 transition-colors">
                      LowHigh LLC
                    </a>
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Settings panel — rendered at root level so it overlays everything */}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
