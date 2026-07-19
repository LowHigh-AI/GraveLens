"use client";

import { useState } from "react";

interface Props {
  /** Public avatar URL from the shared account (user_metadata.avatar_url). */
  avatarUrl?: string | null;
  /** Initials fallback when no photo is set or the photo fails to load. */
  initials: string | null;
  /** Diameter in px. */
  size: number;
  /** Display name, used to make the photo's alt text descriptive. */
  name?: string;
  className?: string;
}

/**
 * The signed-in user's avatar: their profile photo when set, otherwise the gold
 * initials circle GraveLens has always used. Single source of truth so the badge,
 * the account modal, and the settings panel all render identically and fall back
 * the same way on a broken image.
 */
export default function UserAvatar({ avatarUrl, initials, size, name, className = "" }: Props) {
  // Track the URL that failed to load rather than a boolean, so a new photo URL
  // automatically re-enables the image without needing an effect to reset state.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const showPhoto = !!avatarUrl && failedUrl !== avatarUrl;
  const fontSize = Math.round(size * 0.4);

  return (
    <div
      className={`rounded-full flex items-center justify-center overflow-hidden shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))",
      }}
    >
      {showPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl as string}
          alt={name ? `${name}'s profile photo` : "Profile photo"}
          className="w-full h-full object-cover"
          onError={() => setFailedUrl(avatarUrl ?? null)}
        />
      ) : (
        <span className="font-bold text-[#1a1917]" style={{ fontSize }}>
          {initials}
        </span>
      )}
    </div>
  );
}
