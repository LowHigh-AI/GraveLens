/**
 * Account-level personal settings for GraveLens.
 *
 * These operate on the SHARED LowHigh account (one Supabase project across all
 * LowHigh apps), so changes here propagate to the LowHigh website and back:
 *  - display name / avatar / email-notification preference live in
 *    `auth.users.user_metadata` (display_name / avatar_url / email_notifications)
 *  - the profile photo file lives in the shared `avatars` Storage bucket at
 *    `{userId}/{file}`
 *  - email + password are handled by Supabase Auth
 *
 * Mirrors the proven LowHigh website implementation
 * (LowHigh Website/src/context/AuthContext.tsx + UnifiedSettingsModal.tsx) so the
 * two apps stay behaviourally in sync.
 */

import type { SupabaseClient, User } from "@supabase/supabase-js";

// ── Avatar constraints ──────────────────────────────────────────────────────
export const ALLOWED_AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_AVATAR_INPUT_BYTES = 8 * 1024 * 1024; // 8 MB before resize
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB after resize
export const MAX_AVATAR_DIM = 512; // px (longest edge)

// ── Password rules (shared with LowHigh) ────────────────────────────────────

/** 8+ chars with lower, upper, number and symbol. */
export function meetsPasswordRequirements(pass: string): boolean {
  return (
    pass.length >= 8 &&
    /[a-z]/.test(pass) &&
    /[A-Z]/.test(pass) &&
    /[0-9]/.test(pass) &&
    /[^A-Za-z0-9]/.test(pass)
  );
}

/** 0–5 strength score; one point per satisfied requirement. */
export function passwordStrength(pass: string): number {
  if (!pass) return 0;
  let score = 0;
  if (pass.length >= 8) score++;
  if (/[a-z]/.test(pass)) score++;
  if (/[A-Z]/.test(pass)) score++;
  if (/[0-9]/.test(pass)) score++;
  if (/[^A-Za-z0-9]/.test(pass)) score++;
  return score;
}

export function passwordStrengthLabel(score: number): string {
  if (score === 0) return "";
  if (score <= 1) return "Weak";
  if (score === 2) return "Fair";
  if (score === 3) return "Good";
  if (score === 4) return "Great";
  return "Strong";
}

// ── Avatar resize + upload ──────────────────────────────────────────────────

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image"));
    };
    img.src = url;
  });
}

/**
 * Downscale an avatar to at most MAX_AVATAR_DIM on its longest edge, preserving
 * PNG/WebP/JPEG format. Returns the original file unchanged if no canvas context.
 */
export async function resizeAvatar(file: File): Promise<File> {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_AVATAR_DIM / Math.max(img.width, img.height));
  const width = Math.round(img.width * scale);
  const height = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(img, 0, 0, width, height);

  const targetType =
    file.type === "image/png"
      ? "image/png"
      : file.type === "image/webp"
      ? "image/webp"
      : "image/jpeg";
  const quality = targetType === "image/png" ? 0.92 : 0.85;

  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (!result) {
          reject(new Error("Failed to resize image"));
          return;
        }
        resolve(result);
      },
      targetType,
      quality
    );
  });

  return new File([blob], file.name, { type: targetType });
}

/**
 * Upload a (already resized) avatar to the shared `avatars` bucket and return
 * its public URL. Path is namespaced by user id so Storage RLS can scope writes.
 */
export async function uploadAvatar(
  supabase: SupabaseClient,
  userId: string,
  file: File
): Promise<string> {
  const fileExt = file.name.split(".").pop() || "png";
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${fileExt}`;
  const filePath = `${userId}/${fileName}`;

  const { error } = await supabase.storage
    .from("avatars")
    .upload(filePath, file, { upsert: true });
  if (error) throw error;

  const { data } = supabase.storage.from("avatars").getPublicUrl(filePath);
  return data.publicUrl;
}

// ── Account profile / credentials ───────────────────────────────────────────

export interface AccountProfilePatch {
  displayName?: string;
  email?: string;
  emailNotifications?: boolean;
  avatarUrl?: string;
}

/**
 * Update account-level profile fields in one auth call. Only the provided keys
 * are written. Returns the updated user (or throws on error).
 *
 * Changing `email` triggers Supabase's email-change confirmation flow (a
 * verification link is sent to the new address; the change only takes effect
 * once confirmed). Because this is the shared LowHigh account, the change
 * applies across every LowHigh app.
 */
export async function updateAccountProfile(
  supabase: SupabaseClient,
  patch: AccountProfilePatch
): Promise<User> {
  const data: Record<string, unknown> = {};
  if (patch.displayName !== undefined) data.display_name = patch.displayName;
  if (patch.emailNotifications !== undefined)
    data.email_notifications = patch.emailNotifications;
  if (patch.avatarUrl !== undefined) data.avatar_url = patch.avatarUrl;

  const payload: { email?: string; data?: Record<string, unknown> } = {};
  if (Object.keys(data).length > 0) payload.data = data;
  if (patch.email) payload.email = patch.email;

  const { data: result, error } = await supabase.auth.updateUser(payload);
  if (error) throw error;
  if (!result.user) throw new Error("No user returned from update");
  return result.user;
}

/** Change the shared account password. */
export async function updatePassword(
  supabase: SupabaseClient,
  newPassword: string
): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

/** Re-send the email-change confirmation to the pending new address. */
export async function resendEmailChange(
  supabase: SupabaseClient,
  email: string
): Promise<void> {
  const { error } = await supabase.auth.resend({ type: "email_change", email });
  if (error) throw error;
}
