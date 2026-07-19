"use client";

import { useEffect, useRef, useState } from "react";
import {
  loadSettings,
  patchSettings,
  type AppSettings,
  type FontSize,
  type Theme,
  type MapStyle,
  type SearchRadius,
  type LocationPref,
  type AnalysisMode,
  type PhotoSaveTarget,
} from "@/lib/settings";
import { getAllGraves, getAllCemeteries } from "@/lib/storage";
import { useAuth } from "@/lib/auth";
import { createClient } from "@/lib/supabase/browser";
import {
  fetchOwnProfile,
  upsertUserProfile,
  bulkSetGravesPublic,
} from "@/lib/community";
import { SHOW_COMMUNITY_FEATURES } from "@/lib/config";
import UserAvatar from "./UserAvatar";
import { useModalA11y } from "@/lib/useModalA11y";
import { openLowHighSupport } from "@/components/ecosystem/lowhighShell";
import {
  ALLOWED_AVATAR_TYPES,
  MAX_AVATAR_INPUT_BYTES,
  MAX_AVATAR_BYTES,
  resizeAvatar,
  uploadAvatar,
  updateAccountProfile,
  updatePassword,
  resendEmailChange,
  meetsPasswordRequirements,
  passwordStrength,
  passwordStrengthLabel,
} from "@/lib/account";

const PENDING_EMAIL_KEY = "gl_pending_email_change";

interface Props {
  onClose: () => void;
}

// ── Small reusable primitives ─────────────────────────────────────────────────

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 px-5 pt-5 pb-2">
      <div
        aria-hidden="true"
        className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: "rgba(201,168,76,0.12)", border: "1px solid rgba(201,168,76,0.2)" }}
      >
        {icon}
      </div>
      <p className="text-[0.8rem] uppercase tracking-widest font-semibold text-stone-500">{title}</p>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-center justify-between px-5 py-3.5 border-b border-stone-800/60 last:border-0"
      style={{ background: "rgba(var(--glass-bg-rgb), 0.6)" }}
    >
      {children}
    </div>
  );
}

function Label({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex-1 min-w-0 pr-3">
      <p className="text-stone-200 text-sm font-medium">{title}</p>
      {sub && <p className="text-stone-500 text-[0.8rem] mt-0.5 leading-relaxed">{sub}</p>}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="shrink-0 w-11 h-6 rounded-full relative transition-all duration-200 overflow-hidden focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-900 focus-visible:ring-stone-400 focus-visible:outline-none"
      style={{ background: on ? "var(--t-gold-500)" : "var(--t-stone-800)" }}
      role="switch"
      aria-checked={on}
      aria-label={label}
    >
      <span
        className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200"
        style={{ transform: on ? "translateX(1.25rem)" : "translateX(0)" }}
      />
    </button>
  );
}

function SegmentControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex rounded-xl overflow-hidden shrink-0"
      style={{ background: "var(--t-stone-900)", border: "1px solid var(--t-stone-700)" }}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          role="radio"
          aria-checked={value === opt.value}
          className="px-3 py-1.5 text-xs font-semibold transition-colors hover:brightness-110 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stone-400 focus-visible:outline-none"
          style={
            value === opt.value
              ? { background: "var(--t-gold-500)", color: "#1a1917" }
              : { color: "var(--t-stone-500)" }
          }
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

import { createPortal } from "react-dom";

export default function SettingsPanel({ onClose }: Props) {
  const { user } = useAuth();
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [clearDone, setClearDone] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);

  // Community profile state. `showName` = show my Display Name on the community
  // map (reuses the legacy `show_username` column); when off, I appear anonymous.
  const [showName, setShowName] = useState(false);
  const [shareAll, setShareAll] = useState(false);
  const [shareAllConfirm, setShareAllConfirm] = useState(false);

  // Account (shared LowHigh) state
  const [displayName, setDisplayName] = useState("");
  const [emailNotifications, setEmailNotifications] = useState(true);
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const [accountSavedMsg, setAccountSavedMsg] = useState("");
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  // Email change
  const [emailExpanded, setEmailExpanded] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [emailPending, setEmailPending] = useState(false);
  // Password change
  const [pwExpanded, setPwExpanded] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwError, setPwError] = useState("");
  const [pwSavedOk, setPwSavedOk] = useState(false);

  // Keep settings in sync with any changes from this session and lock scroll
  useEffect(() => {
    setSettings(loadSettings());
    setMounted(true);
    
    // Lock the scroll container while the panel is open.
    // Avoid touching body position — it breaks fixed-portal placement on iOS PWA.
    const style = document.createElement("style");
    style.innerHTML = `.scroll-container:not(.settings-scroll) { overflow-y: hidden !important; }`;
    document.head.appendChild(style);

    return () => {
      document.head.removeChild(style);
    };
  }, []);

  // Load community profile when signed in — depend on user.id only to avoid
  // re-fetching (and overwriting edits) when the auth object re-references.
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    const supabase = createClient();
    fetchOwnProfile(supabase, userId)
      .then((p) => {
        if (p) {
          setShowName(p.showUsername);
          setShareAll(p.shareAllByDefault);
        }
      })
      .catch(() => {});
  }, [userId]);

  // Seed account fields from the shared account metadata. Keyed on user id so we
  // don't clobber in-progress edits when the auth object re-references.
  useEffect(() => {
    if (!user) return;
    const meta = user.user_metadata ?? {};
    setDisplayName((meta.display_name as string) ?? "");
    setEmailNotifications((meta.email_notifications as boolean) ?? true);
    setAvatarUrl((meta.avatar_url as string) ?? undefined);
    // Restore a pending email-change banner across reloads.
    const pending = localStorage.getItem(PENDING_EMAIL_KEY);
    if (pending && pending !== user.email) {
      setNewEmail(pending);
      setEmailPending(true);
    }
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear the pending-email banner once Supabase confirms the new address.
  useEffect(() => {
    if (!emailPending || !user) return;
    if (newEmail && user.email === newEmail) {
      setEmailPending(false);
      localStorage.removeItem(PENDING_EMAIL_KEY);
      return;
    }
    const supabase = createClient();
    const id = setInterval(() => {
      supabase.auth.getUser().then(({ data }: { data: { user: { email?: string } | null } }) => {
        if (data.user?.email === newEmail) {
          setEmailPending(false);
          localStorage.removeItem(PENDING_EMAIL_KEY);
          clearInterval(id);
        }
      }).catch(() => {});
    }, 15000);
    return () => clearInterval(id);
  }, [emailPending, newEmail, user?.email]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dialog a11y: focus trap, Escape to close, return focus to the opener.
  useModalA11y(sheetRef, onClose, mounted);

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      patchSettings(settings);
      if (user) {
        const supabase = createClient();
        await upsertUserProfile(supabase, user.id, {
          showUsername: showName,
          // Mirror the account Display Name into the public profile only while
          // shown; clear it when hidden so anonymous names never reach others.
          displayName: showName ? (displayName.trim() || null) : null,
          shareAllByDefault: shareAll,
        });
        // Account-level fields (display name, notifications) auto-save on their
        // own; this button owns only GraveLens app settings + the community profile.
      }
    } catch { /* non-fatal */ }
    finally {
      setSaving(false);
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 3000);
    }
  };

  // ── Account actions ─────────────────────────────────────────────────────────

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
      setAvatarError("Profile photo must be a JPG, PNG, or WebP image.");
      e.target.value = "";
      return;
    }
    if (file.size > MAX_AVATAR_INPUT_BYTES) {
      setAvatarError("Profile photo must be 8MB or smaller.");
      e.target.value = "";
      return;
    }
    setAvatarError("");
    setAvatarUploading(true);
    try {
      const resized = await resizeAvatar(file);
      if (resized.size > MAX_AVATAR_BYTES) {
        setAvatarError("Profile photo must be 2MB or smaller.");
        return;
      }
      const supabase = createClient();
      const url = await uploadAvatar(supabase, user.id, resized);
      await updateAccountProfile(supabase, { avatarUrl: url });
      setAvatarUrl(url);
    } catch {
      setAvatarError("Could not upload photo. Please try again.");
    } finally {
      setAvatarUploading(false);
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    }
  };

  const handleSaveEmail = async () => {
    const trimmed = newEmail.trim();
    if (!user) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
      setEmailError("Enter a valid email address.");
      return;
    }
    if (trimmed === user.email) {
      setEmailExpanded(false);
      return;
    }
    setEmailError("");
    setEmailSaving(true);
    try {
      const supabase = createClient();
      await updateAccountProfile(supabase, { email: trimmed });
      await resendEmailChange(supabase, trimmed);
      localStorage.setItem(PENDING_EMAIL_KEY, trimmed);
      setEmailPending(true);
      setEmailExpanded(false);
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : "Could not update email.");
    } finally {
      setEmailSaving(false);
    }
  };

  const handleUpdatePassword = async () => {
    if (!meetsPasswordRequirements(newPassword)) {
      setPwError("Password must be 8+ characters with a lowercase, uppercase, number, and symbol.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError("Passwords do not match.");
      return;
    }
    setPwError("");
    setPwSaving(true);
    try {
      const supabase = createClient();
      await updatePassword(supabase, newPassword);
      setNewPassword("");
      setConfirmPassword("");
      setPwExpanded(false);
      setPwSavedOk(true);
      setTimeout(() => setPwSavedOk(false), 3000);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Could not update password.");
    } finally {
      setPwSaving(false);
    }
  };

  // Auto-save the display name on blur (skip if unchanged from the stored value).
  const flashAccountSaved = () => {
    setAccountSavedMsg("Saved");
    setTimeout(() => setAccountSavedMsg(""), 2500);
  };

  const handleDisplayNameBlur = async () => {
    if (!user) return;
    const trimmed = displayName.trim();
    if (trimmed === ((user.user_metadata?.display_name as string) ?? "")) return;
    try {
      const supabase = createClient();
      await updateAccountProfile(supabase, { displayName: trimmed });
      // Keep the public community label in sync while the user shows their name.
      if (showName) {
        await upsertUserProfile(supabase, user.id, { displayName: trimmed || null });
      }
      flashAccountSaved();
    } catch { /* non-fatal; value stays in the field for retry */ }
  };

  // "Show my name on the community map" saves immediately, mirroring (or clearing)
  // the account Display Name in the public profile.
  const handleShowNameToggle = async (next: boolean) => {
    setShowName(next);
    if (!user) return;
    try {
      await upsertUserProfile(createClient(), user.id, {
        showUsername: next,
        displayName: next ? (displayName.trim() || null) : null,
      });
    } catch {
      setShowName(!next); // revert on failure
    }
  };

  // Email notifications save immediately on toggle.
  const handleNotificationsToggle = async (next: boolean) => {
    setEmailNotifications(next);
    if (!user) return;
    try {
      await updateAccountProfile(createClient(), { emailNotifications: next });
      flashAccountSaved();
    } catch {
      setEmailNotifications(!next); // revert on failure
    }
  };

  const handleResendEmail = async () => {
    if (!newEmail) return;
    try {
      await resendEmailChange(createClient(), newEmail);
    } catch { /* non-fatal */ }
  };

  const handleCancelEmailChange = () => {
    localStorage.removeItem(PENDING_EMAIL_KEY);
    setEmailPending(false);
    setNewEmail("");
  };

  const initials = (displayName || user?.email || "EX").slice(0, 2).toUpperCase();
  const strength = passwordStrength(newPassword);
  const strengthColors = ["bg-stone-700", "bg-red-500", "bg-orange-500", "bg-yellow-500", "bg-lime-500", "bg-green-500"];
  // Live password requirement checks (reuse the same tests as meetsPasswordRequirements).
  const pwChecks = [
    { label: "8+ characters", ok: newPassword.length >= 8 },
    { label: "Lowercase letter", ok: /[a-z]/.test(newPassword) },
    { label: "Uppercase letter", ok: /[A-Z]/.test(newPassword) },
    { label: "Number", ok: /[0-9]/.test(newPassword) },
    { label: "Symbol", ok: /[^A-Za-z0-9]/.test(newPassword) },
  ];

  const handleShareAllToggle = async (next: boolean) => {
    if (next && !shareAllConfirm) {
      setShareAllConfirm(true);
      return;
    }
    setShareAll(next);
    setShareAllConfirm(false);
    if (!user) return;
    try {
      const supabase = createClient();
      await Promise.all([
        upsertUserProfile(supabase, user.id, { shareAllByDefault: next }),
        bulkSetGravesPublic(supabase, user.id, next),
      ]);
    } catch { /* non-fatal */ }
  };

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  // ── Privacy actions ───────────────────────────────────────────────────────

  const handleClearData = async () => {
    setClearing(true);
    try {
      // Delete the IndexedDB database entirely then reload
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase("gravelens");
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
      localStorage.removeItem("gl_settings");
      localStorage.removeItem("gl_viewed_ids");
      setClearDone(true);
      setTimeout(() => window.location.reload(), 1200);
    } catch {
      setClearing(false);
      setClearConfirm(false);
    }
  };

  const handleExportCsv = async () => {
    setExportingCsv(true);
    try {
      const graves = await getAllGraves();
      const header = ["Name", "Birth Year", "Death Year", "Age at Death", "Cemetery", "City", "State", "Latitude", "Longitude", "Inscription"];
      const escape = (v: string | number | null | undefined) => {
        const s = String(v ?? "");
        return s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s.replace(/"/g, '""')}"`
          : s;
      };
      const rows = graves.map((g) => [
        escape(g.extracted?.name),
        escape(g.extracted?.birthYear),
        escape(g.extracted?.deathYear),
        escape(g.extracted?.ageAtDeath),
        escape(g.location?.cemetery),
        escape(g.location?.city),
        escape(g.location?.state),
        escape(g.location?.lat),
        escape(g.location?.lng),
        escape(g.extracted?.inscription?.slice(0, 200)),
      ]);
      const csv = [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gravelens-archive-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExportingCsv(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const [graves, cemeteries] = await Promise.all([
        getAllGraves(),
        getAllCemeteries(),
      ]);
      const blob = new Blob(
        [JSON.stringify({ exportedAt: new Date().toISOString(), graves, cemeteries }, null, 2)],
        { type: "application/json" }
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gravelens-archive-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (!mounted) return null;

  return createPortal(
    <div data-lh-capture-ignore className="settings-portal fixed inset-0 z-[2000] flex items-end sm:items-center justify-center p-0 sm:p-6 pb-0">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-stone-950/80 backdrop-blur-md"
        style={{ backfaceVisibility: "hidden", transform: "translateZ(0)" }}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet / Modal */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        className="relative w-full max-w-lg flex flex-col rounded-t-[32px] sm:rounded-[32px] overflow-hidden shadow-2xl focus:outline-none"
        style={{
          background: "linear-gradient(180deg, var(--t-stone-800), var(--t-stone-900))",
          border: "1px solid rgba(var(--glass-bg-rgb), 0.08)",
          maxHeight: "92dvh",
          backfaceVisibility: "hidden",
          transform: "translateZ(0)",
        }}
      >
        {/* Handle + header */}
        <div className="shrink-0 flex flex-col">
          <div className="flex justify-center pt-3 pb-1">
            <div className="w-10 h-1 rounded-full bg-stone-700" />
          </div>
          <div className="flex items-center justify-between px-5 pt-2 pb-3 border-b border-stone-800">
            <div className="flex items-center gap-2.5">
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
              <span id="settings-title" className="font-serif text-stone-100 text-lg font-semibold">Settings</span>
            </div>
            <button
              onClick={onClose}
              aria-label="Close settings"
              className="w-11 h-11 flex items-center justify-center rounded-full text-stone-500 hover:text-stone-300 hover:bg-stone-800/60 active:text-stone-300 transition-colors focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:outline-none"
            >
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="scroll-container settings-scroll flex-1 overflow-y-auto">

          {/* ── ACCOUNT ─────────────────────────────────────────────────── */}
          {user && (
            <>
              <SectionHeader
                title="Account"
                icon={
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                }
              />
              <div className="mx-5 rounded-2xl overflow-hidden border border-stone-800/80 mb-1">
                {/* Profile photo */}
                <div className="px-5 py-4 border-b border-stone-800/60" style={{ background: "rgba(var(--glass-bg-rgb), 0.6)" }}>
                  <div className="flex items-center gap-4">
                    <UserAvatar avatarUrl={avatarUrl} initials={initials} name={displayName} size={64} />
                    <div className="flex-1 min-w-0">
                      <p className="text-stone-200 text-sm font-medium">Profile Photo</p>
                      <p className="text-stone-400 text-[0.8rem] mt-0.5 leading-relaxed">Shown across your LowHigh account. JPG, PNG, or WebP.</p>
                      <button
                        onClick={() => avatarInputRef.current?.click()}
                        disabled={avatarUploading}
                        aria-label={avatarUploading ? "Uploading profile photo" : "Change profile photo"}
                        aria-busy={avatarUploading}
                        className="mt-2.5 inline-flex items-center justify-center gap-1.5 min-h-11 px-4 py-2 rounded-xl text-xs font-semibold transition-all active:scale-95 hover:brightness-110 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:outline-none"
                        style={{ background: "rgba(201,168,76,0.12)", color: "var(--t-gold-500)", border: "1px solid rgba(201,168,76,0.25)" }}
                      >
                        {avatarUploading ? (
                          <div className="w-3 h-3 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: "var(--t-gold-500) transparent var(--t-gold-500) var(--t-gold-500)" }} />
                        ) : (
                          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                          </svg>
                        )}
                        {avatarUploading ? "Uploading…" : "Change Photo"}
                      </button>
                      {avatarError && <p role="alert" className="text-red-400 text-[0.8rem] mt-2">{avatarError}</p>}
                    </div>
                    <input
                      ref={avatarInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={handleAvatarChange}
                      className="hidden"
                    />
                  </div>
                </div>

                {/* Display name */}
                <div className="px-5 py-3.5 border-b border-stone-800/60" style={{ background: "rgba(var(--glass-bg-rgb), 0.6)" }}>
                  <div className="flex items-center justify-between gap-2">
                    <Label title="Display Name" sub="Shared across LowHigh apps and used to connect with friends" />
                    {accountSavedMsg && (
                      <span role="status" aria-live="polite" className="shrink-0 inline-flex items-center gap-1 text-green-400 text-[0.78rem] font-medium">
                        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                        {accountSavedMsg}
                      </span>
                    )}
                  </div>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value.slice(0, 50))}
                    onBlur={handleDisplayNameBlur}
                    placeholder="e.g. Jane Doe…"
                    maxLength={50}
                    aria-label="Display name"
                    autoComplete="name"
                    className="w-full mt-2.5 bg-stone-800 text-stone-200 text-base rounded-lg px-3 py-2.5 border border-stone-700 focus:outline-none focus:border-stone-500 focus-visible:ring-2 focus-visible:ring-stone-500 placeholder:text-stone-600"
                  />
                </div>

                {/* Email */}
                <div className="px-5 py-3.5 border-b border-stone-800/60" style={{ background: "rgba(var(--glass-bg-rgb), 0.6)" }}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-stone-200 text-sm font-medium">Email</p>
                        {emailPending && (
                          <span className="shrink-0 px-2 py-0.5 rounded-full text-[0.68rem] font-semibold text-yellow-300 bg-yellow-500/10 border border-yellow-500/25">
                            Pending confirmation
                          </span>
                        )}
                      </div>
                      <p className="text-stone-500 text-[0.8rem] mt-0.5 truncate">{user.email}</p>
                    </div>
                    {!emailExpanded && !emailPending && (
                      <button
                        onClick={() => { setEmailExpanded(true); setNewEmail(""); setEmailError(""); }}
                        className="shrink-0 min-h-11 px-3.5 rounded-lg text-xs font-semibold text-stone-300 border border-stone-700 bg-stone-800 hover:bg-stone-700/60 active:scale-95 transition-all focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:outline-none"
                      >
                        Change
                      </button>
                    )}
                  </div>
                  {emailExpanded && (
                    <div className="mt-2.5 flex flex-col gap-2">
                      <p className="text-stone-400 text-[0.78rem] leading-relaxed">This changes your shared LowHigh account email everywhere. We will send a confirmation link to the new address.</p>
                      <input
                        type="email"
                        value={newEmail}
                        onChange={(e) => setNewEmail(e.target.value)}
                        placeholder="name@example.com…"
                        aria-label="New email address"
                        autoComplete="email"
                        spellCheck={false}
                        autoCapitalize="off"
                        className="w-full bg-stone-800 text-stone-200 text-base rounded-lg px-3 py-2.5 border border-stone-700 focus:outline-none focus:border-stone-500 focus-visible:ring-2 focus-visible:ring-stone-500 placeholder:text-stone-600"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => { setEmailExpanded(false); setEmailError(""); }}
                          className="flex-1 min-h-11 py-3 rounded-xl text-sm text-stone-400 border border-stone-700 bg-stone-800 hover:bg-stone-700/60 transition-colors focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:outline-none"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleSaveEmail}
                          disabled={emailSaving}
                          className="flex-1 min-h-11 py-3 rounded-xl text-sm font-semibold transition-all hover:brightness-110 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:outline-none"
                          style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
                        >
                          {emailSaving ? "Saving…" : "Update Email"}
                        </button>
                      </div>
                    </div>
                  )}
                  {emailError && <p role="alert" className="text-red-400 text-[0.8rem] mt-2">{emailError}</p>}
                  {emailPending && (
                    <div role="status" aria-live="polite" className="mt-2.5 px-3 py-2.5 rounded-xl text-[0.8rem] text-stone-300 border border-stone-700/50 bg-stone-800/80">
                      <p>Confirmation sent to <strong className="text-stone-200">{newEmail}</strong>. Click the link in that inbox to finish the change.</p>
                      <div className="flex gap-3 mt-2">
                        <button
                          onClick={handleResendEmail}
                          className="text-[0.78rem] font-semibold underline underline-offset-2 hover:text-stone-100 transition-colors"
                          style={{ color: "var(--t-gold-500)" }}
                        >
                          Resend email
                        </button>
                        <button
                          onClick={handleCancelEmailChange}
                          className="text-[0.78rem] font-medium text-stone-400 underline underline-offset-2 hover:text-stone-200 transition-colors"
                        >
                          Cancel change
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Password */}
                <div className="px-5 py-3.5 border-b border-stone-800/60" style={{ background: "rgba(var(--glass-bg-rgb), 0.6)" }}>
                  <div className="flex items-center justify-between gap-3">
                    <Label title="Password" sub="Used to sign in to your LowHigh account" />
                    {!pwExpanded && (
                      <button
                        onClick={() => { setPwExpanded(true); setPwError(""); }}
                        className="shrink-0 min-h-11 px-3.5 rounded-lg text-xs font-semibold text-stone-300 border border-stone-700 bg-stone-800 hover:bg-stone-700/60 active:scale-95 transition-all focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:outline-none"
                      >
                        Change
                      </button>
                    )}
                  </div>
                  {pwSavedOk && !pwExpanded && (
                    <p role="status" aria-live="polite" className="text-green-400 text-[0.8rem] mt-2">Password updated.</p>
                  )}
                  {pwExpanded && (
                    <div className="mt-2.5 flex flex-col gap-2">
                      <input
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="New password…"
                        aria-label="New password"
                        autoComplete="new-password"
                        className="w-full bg-stone-800 text-stone-200 text-base rounded-lg px-3 py-2.5 border border-stone-700 focus:outline-none focus:border-stone-500 focus-visible:ring-2 focus-visible:ring-stone-500 placeholder:text-stone-600"
                      />
                      {newPassword.length > 0 && (
                        <div
                          className="flex items-center gap-2"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={5}
                          aria-valuenow={strength}
                          aria-label={`Password strength: ${passwordStrengthLabel(strength) || "none"}`}
                        >
                          <div className="flex-1 flex gap-1">
                            {[1, 2, 3, 4, 5].map((i) => (
                              <div
                                key={i}
                                className={`h-1.5 flex-1 rounded-full transition-colors ${i <= strength ? strengthColors[strength] : "bg-stone-700"}`}
                              />
                            ))}
                          </div>
                          <span className="text-[0.72rem] text-stone-300 w-12 text-right">{passwordStrengthLabel(strength)}</span>
                        </div>
                      )}
                      {/* Live requirement checklist */}
                      <ul aria-live="polite" className="grid grid-cols-2 gap-x-3 gap-y-1 mt-0.5">
                        {pwChecks.map((c) => (
                          <li key={c.label} className={`flex items-center gap-1.5 text-[0.74rem] ${c.ok ? "text-green-400" : "text-stone-500"}`}>
                            {c.ok ? (
                              <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                            ) : (
                              <span aria-hidden="true" className="w-2.75 h-2.75 flex items-center justify-center"><span className="w-1 h-1 rounded-full bg-stone-600" /></span>
                            )}
                            <span>{c.ok ? "Met: " : "Needs: "}{c.label}</span>
                          </li>
                        ))}
                      </ul>
                      <input
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Confirm new password…"
                        aria-label="Confirm new password"
                        autoComplete="new-password"
                        className="w-full bg-stone-800 text-stone-200 text-base rounded-lg px-3 py-2.5 border border-stone-700 focus:outline-none focus:border-stone-500 focus-visible:ring-2 focus-visible:ring-stone-500 placeholder:text-stone-600"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => { setPwExpanded(false); setNewPassword(""); setConfirmPassword(""); setPwError(""); }}
                          className="flex-1 min-h-11 py-3 rounded-xl text-sm text-stone-400 border border-stone-700 bg-stone-800 hover:bg-stone-700/60 transition-colors focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:outline-none"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleUpdatePassword}
                          disabled={pwSaving}
                          className="flex-1 min-h-11 py-3 rounded-xl text-sm font-semibold transition-all hover:brightness-110 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:outline-none"
                          style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
                        >
                          {pwSaving ? "Saving…" : "Update Password"}
                        </button>
                      </div>
                    </div>
                  )}
                  {pwError && <p role="alert" className="text-red-400 text-[0.8rem] mt-2">{pwError}</p>}
                </div>

                {/* Email notifications */}
                <Row>
                  <Label title="Email Notifications" sub="Product updates and account emails from LowHigh" />
                  <Toggle on={emailNotifications} onChange={handleNotificationsToggle} label="Email notifications" />
                </Row>
              </div>
            </>
          )}

          {/* ── DISPLAY ─────────────────────────────────────────────────── */}
          <SectionHeader
            title="Display"
            icon={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5"/><line x1="12" y1="2" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="22"/>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                <line x1="2" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="22" y2="12"/>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
              </svg>
            }
          />
          <div className="mx-5 rounded-2xl overflow-hidden border border-stone-800/80 mb-1">
            <Row>
              <Label title="Font Size" sub="Adjusts text size throughout the app" />
              <SegmentControl<FontSize>
                value={settings.fontSize}
                onChange={(v) => update("fontSize", v)}
                options={[
                  { value: "small", label: "S" },
                  { value: "medium", label: "M" },
                  { value: "large", label: "L" },
                  { value: "xl", label: "XL" },
                ]}
              />
            </Row>
            <Row>
              <Label title="Theme" sub="Controls the app's colour scheme" />
              <SegmentControl<Theme>
                value={settings.theme}
                onChange={(v) => update("theme", v)}
                options={[
                  { value: "dark", label: "Dark" },
                  { value: "system", label: "Auto" },
                  { value: "light", label: "Light" },
                ]}
              />
            </Row>
            <Row>
              <Label title="High Contrast" sub="Boosts text contrast for readability" />
              <Toggle on={settings.highContrast} onChange={(v) => update("highContrast", v)} />
            </Row>
          </div>

          {/* ── MAP ─────────────────────────────────────────────────────── */}
          <SectionHeader
            title="Map"
            icon={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/>
                <line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/>
              </svg>
            }
          />
          <div className="mx-5 rounded-2xl overflow-hidden border border-stone-800/80 mb-1">
            <Row>
              <Label title="Map Style" sub="Visual style of the background map" />
              <SegmentControl<MapStyle>
                value={settings.mapStyle}
                onChange={(v) => update("mapStyle", v)}
                options={[
                  { value: "standard", label: "Street" },
                  { value: "satellite", label: "Satellite" },
                  { value: "terrain", label: "Terrain" },
                ]}
              />
            </Row>
            <Row>
              <Label title="Default Search Radius" sub="Pre-fills Local Discovery radius" />
              <SegmentControl<string>
                value={String(settings.defaultSearchRadius)}
                onChange={(v) => update("defaultSearchRadius", Number(v) as SearchRadius)}
                options={[
                  { value: "1", label: "1 mi" },
                  { value: "5", label: "5 mi" },
                  { value: "10", label: "10 mi" },
                  { value: "25", label: "25 mi" },
                ]}
              />
            </Row>
            <Row>
              <Label title="Auto-discover on Open" sub="Runs discovery when the map loads" />
              <Toggle on={settings.autoDiscover} onChange={(v) => update("autoDiscover", v)} />
            </Row>
          </div>

          {/* ── SCAN ─────────────────────────────────────────────────────── */}
          <SectionHeader
            title="Scan"
            icon={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                <circle cx="12" cy="13" r="4"/>
              </svg>
            }
          />
          <div className="mx-5 rounded-2xl overflow-hidden border border-stone-800/80 mb-1">
            <Row>
              <Label title="Save Location with Scans" sub="Tags grave records with GPS coordinates" />
              <SegmentControl<LocationPref>
                value={settings.saveLocation}
                onChange={(v) => update("saveLocation", v)}
                options={[
                  { value: "always", label: "Always" },
                  { value: "ask", label: "Ask" },
                  { value: "never", label: "Never" },
                ]}
              />
            </Row>
          </div>

          {/* ── COMMUNITY ────────────────────────────────────────────── */}
          {user && SHOW_COMMUNITY_FEATURES && (
            <>
              <SectionHeader
                title="Community"
                icon={
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                  </svg>
                }
              />
              <div className="mx-5 rounded-2xl overflow-hidden border border-stone-800/80 mb-1">
                {/* Show my name publicly */}
                <Row>
                  <Label title="Show my name on the community map" sub="When on, other explorers see your Display Name. When off, you appear as 'Community Member'." />
                  <Toggle on={showName} onChange={handleShowNameToggle} label="Show my name on the community map" />
                </Row>

                {/* Share all graves */}
                <div className="border-t border-stone-800/60">
                  <Row>
                    <Label
                      title="Share all my discoveries"
                      sub="Public graves appear on the community map for other users"
                    />
                    <Toggle on={shareAll} onChange={handleShareAllToggle} />
                  </Row>
                  {shareAllConfirm && (
                    <div className="px-5 pb-4 pt-1" style={{ background: "rgba(var(--glass-bg-rgb), 0.6)" }}>
                      <p className="text-stone-300 text-sm mb-3">
                        This will make <strong>all your existing graves</strong> visible on the community map. You can hide individual graves from their detail page.
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setShareAllConfirm(false)}
                          className="flex-1 py-2 rounded-xl text-sm text-stone-400 border border-stone-700 bg-stone-800"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleShareAllToggle(true)}
                          className="flex-1 py-2 rounded-xl text-sm font-semibold"
                          style={{ background: "var(--t-gold-500)", color: "#1a1510" }}
                        >
                          Share All
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* ── CAPTURE ──────────────────────────────────────────────── */}
          <SectionHeader
            title="Capture"
            icon={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="13" r="4"/>
                <path d="M5 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-1"/>
                <path d="M9 7l1-3h4l1 3"/>
              </svg>
            }
          />
          <div className="mx-5 rounded-2xl overflow-hidden border border-stone-800/80 mb-1">
            <Row>
              <Label title="Show Photo Tips" sub="Display lighting & framing hints on the scan screen" />
              <Toggle on={settings.showPhotoTips} onChange={(v) => update("showPhotoTips", v)} />
            </Row>
            <Row>
              <Label title="Auto-Save Scans" sub="Save every scan to your archive without prompting" />
              <Toggle on={settings.autoSaveToArchive} onChange={(v) => update("autoSaveToArchive", v)} />
            </Row>
            <Row>
              <Label title="Analysis Mode" sub="Fast uses less AI cost; Thorough always escalates to the best model" />
              <SegmentControl<AnalysisMode>
                value={settings.analysisMode}
                onChange={(v) => update("analysisMode", v)}
                options={[
                  { value: "fast", label: "Fast" },
                  { value: "thorough", label: "Thorough" },
                ]}
              />
            </Row>
            <Row>
              <Label title="Save to Device" sub="Also copy each photo to your camera roll or downloads folder" />
              <SegmentControl<PhotoSaveTarget>
                value={settings.photoSaveTarget ?? "app-only"}
                onChange={(v) => update("photoSaveTarget", v)}
                options={[
                  { value: "app-only", label: "App Only" },
                  { value: "app-and-device", label: "Both" },
                ]}
              />
            </Row>
          </div>

          {/* ── HELP & SUPPORT ────────────────────────────────────────── */}
          <SectionHeader
            title="Help & Support"
            icon={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            }
          />
          <div className="mx-5 rounded-2xl overflow-hidden border border-stone-800/80 mb-1">
            <Row>
              <Label
                title="Support Tickets"
                sub="Report a problem or ask a question. Tickets follow your LowHigh account across every app."
              />
              <button
                onClick={() => {
                  onClose();
                  openLowHighSupport();
                }}
                className="shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all active:scale-95"
                style={{ background: "rgba(201,168,76,0.12)", color: "var(--t-gold-500)", border: "1px solid rgba(201,168,76,0.25)" }}
              >
                Open
              </button>
            </Row>
            <Row>
              <Label
                title="Additional Resources"
                sub="Guides, FAQs, and more on the LowHigh website."
              />
              <a
                href="https://www.lowhigh.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all active:scale-95"
                style={{ background: "rgba(201,168,76,0.12)", color: "var(--t-gold-500)", border: "1px solid rgba(201,168,76,0.25)" }}
              >
                Visit
              </a>
            </Row>
          </div>

          {/* ── PRIVACY & DATA ────────────────────────────────────────── */}
          <SectionHeader
            title="Privacy & Data"
            icon={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
            }
          />
          <div className="mx-5 rounded-2xl overflow-hidden border border-stone-800/80 mb-6">
            {/* Export JSON */}
            <Row>
              <Label
                title="Export Archive"
                sub="Download all graves & cemeteries as JSON"
              />
              <button
                onClick={handleExport}
                disabled={exporting}
                className="shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all active:scale-95 disabled:opacity-50"
                style={{ background: "rgba(201,168,76,0.12)", color: "var(--t-gold-500)", border: "1px solid rgba(201,168,76,0.25)" }}
              >
                {exporting ? (
                  <div className="w-3 h-3 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: "var(--t-gold-500) transparent var(--t-gold-500) var(--t-gold-500)" }} />
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                )}
                JSON
              </button>
            </Row>

            {/* Export CSV */}
            <Row>
              <Label
                title="Export as Spreadsheet"
                sub="Download graves as CSV for Excel or Sheets"
              />
              <button
                onClick={handleExportCsv}
                disabled={exportingCsv}
                className="shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all active:scale-95 disabled:opacity-50"
                style={{ background: "rgba(201,168,76,0.12)", color: "var(--t-gold-500)", border: "1px solid rgba(201,168,76,0.25)" }}
              >
                {exportingCsv ? (
                  <div className="w-3 h-3 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: "var(--t-gold-500) transparent var(--t-gold-500) var(--t-gold-500)" }} />
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                )}
                CSV
              </button>
            </Row>

            {/* Clear data */}
            <div
              className="px-5 py-4"
              style={{ background: "rgba(var(--glass-bg-rgb), 0.6)" }}
            >
              {clearDone ? (
                <div className="flex items-center gap-2 text-green-400 text-sm">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  Data cleared — reloading…
                </div>
              ) : !clearConfirm ? (
                <button
                  onClick={() => setClearConfirm(true)}
                  className="w-full py-2.5 rounded-xl text-sm font-medium text-red-400 border border-red-500/20 bg-red-500/5 active:bg-red-500/10 transition-colors"
                >
                  Clear All Local Data
                </button>
              ) : (
                <div className="flex flex-col gap-3">
                  <p className="text-stone-300 text-sm text-center font-medium">
                    This will permanently delete all locally stored graves, cemeteries, and settings. Cloud data is unaffected.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setClearConfirm(false)}
                      className="flex-1 py-2.5 rounded-xl text-sm text-stone-400 border border-stone-700 bg-stone-800"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleClearData}
                      disabled={clearing}
                      className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white bg-red-600 active:bg-red-700 disabled:opacity-60"
                    >
                      {clearing ? "Clearing…" : "Yes, Clear All"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* App version */}
          <p className="text-center text-[0.75rem] text-stone-500 pt-2 pb-4">
            GraveLens · v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}
          </p>

          {/* ── Save button (sticky footer so it stays reachable with the keyboard up) ── */}
          <div
            className="sticky bottom-0 px-5 pt-3 pb-safe border-t border-stone-800"
            style={{ background: "linear-gradient(180deg, rgba(var(--glass-bg-rgb),0), var(--t-stone-900) 28%)" }}
          >
            {savedOk && (
              <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 mb-3 py-2.5 rounded-xl text-sm font-medium text-green-400 border border-green-500/20 bg-green-500/8">
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                Settings saved
              </div>
            )}
            <button
              onClick={handleSaveAll}
              disabled={saving}
              className="w-full min-h-11 py-3 mb-3 rounded-2xl text-sm font-semibold transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:outline-none"
              style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
            >
              {saving ? "Saving…" : "Save Settings"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
