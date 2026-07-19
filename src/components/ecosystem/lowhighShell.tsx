"use client";

import React, { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/browser";
import { captureViewport } from "./captureScreenshot";

/**
 * GraveLens host bindings for the shared LowHigh shell web components
 * (<lowhigh-launcher> and <lowhigh-support>), served from
 * /public/lowhigh-shell.js (built once in Shared/lowhigh-shell and copied
 * into every LowHigh app; see that package's README for the contract).
 *
 * The components talk directly to the shared Supabase project with the
 * user's JWT (RLS-scoped), so all this file does is: load the bundle, keep
 * the session config in sync, and map GraveLens theme tokens onto the
 * shell's CSS variables.
 */

interface ShellConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  accessToken?: string | null;
  userId?: string | null;
  appSlug: string;
  hubUrl?: string;
}

/** Mirrors the shell's PendingAttachment contract (Shared/lowhigh-shell/src/types.ts). */
interface PendingAttachment {
  previewUrl: string;
  name: string;
  upload: () => Promise<{ name: string; url: string; size: number }>;
}

interface ShellElement extends HTMLElement {
  config: ShellConfig | null;
  /** Optional host-provided attachment offered on the New Ticket form. */
  pendingAttachment?: PendingAttachment | null;
}

const OPEN_SUPPORT_EVENT = "lowhigh:open-support";

/**
 * Uploads a captured screenshot to the shared, private `ticket-attachments`
 * bucket and returns the persisted attachment record. The stored `url` is the
 * storage PATH (not a public URL) because the bucket is private — the admin
 * ticket API signs it on read.
 */
async function uploadCapture(
  blob: Blob,
  userId: string,
): Promise<{ name: string; url: string; size: number }> {
  const supabase = createClient();
  const path = `${userId}/${crypto.randomUUID()}.webp`;
  const { error } = await supabase.storage
    .from("ticket-attachments")
    .upload(path, blob, { contentType: "image/webp", upsert: false });
  if (error) throw new Error(error.message);
  return { name: "screenshot.webp", url: path, size: blob.size };
}

/** Open the in-app LowHigh support sheet from anywhere (e.g. SettingsPanel). */
export function openLowHighSupport(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SUPPORT_EVENT));
}

/** GraveLens design tokens mapped onto the shell theme contract.
 *  CSS variables pierce the shadow boundary, so var(--t-*) keeps the shell
 *  in sync with light/dark inversion. #1a1917 on gold matches the host's
 *  own on-gold text (deliberately fixed across modes). */
const THEME_STYLE: React.CSSProperties = {
  "--lhs-bg-override": "var(--t-stone-900)",
  "--lhs-surface-override": "var(--t-stone-800)",
  "--lhs-border-override": "var(--t-stone-700)",
  "--lhs-text-override": "var(--t-stone-50)",
  "--lhs-muted-override": "var(--t-stone-500)",
  "--lhs-accent-override": "var(--t-gold-500)",
  "--lhs-accent-contrast-override": "#1a1917",
  "--lhs-z-override": "3000",
} as React.CSSProperties;

/** Loads the shell bundle once; resolves true when elements are defined. */
function useShellReady(): boolean {
  // Lazy init covers the "element already defined" case (e.g. remount within the
  // same session) without a synchronous setState inside the effect.
  const [ready, setReady] = useState(
    () => typeof window !== "undefined" && !!window.customElements?.get("lowhigh-support"),
  );

  useEffect(() => {
    if (typeof window === "undefined" || ready) return;
    let script = document.querySelector<HTMLScriptElement>("script[data-lowhigh-shell]");
    if (!script) {
      script = document.createElement("script");
      script.src = "/lowhigh-shell.js";
      script.defer = true;
      script.dataset.lowhighShell = "";
      document.head.appendChild(script);
    }
    const onLoad = () => setReady(true);
    const onError = (err: Event) =>
      console.error("[lowhigh-shell] bundle failed to load", err);
    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);
    return () => {
      script?.removeEventListener("load", onLoad);
      script?.removeEventListener("error", onError);
    };
  }, [ready]);

  return ready;
}

/** Tracks the Supabase session and yields the shared shell config. */
function useShellConfig(): ShellConfig {
  const [session, setSession] = useState<{ token: string | null; userId: string | null }>({
    token: null,
    userId: null,
  });

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;
    supabase.auth
      .getSession()
      .then(({ data }: { data: { session: Session | null } }) => {
        if (!mounted) return;
        setSession({
          token: data.session?.access_token ?? null,
          userId: data.session?.user?.id ?? null,
        });
      })
      .catch((err: unknown) => {
        console.error("[lowhigh-shell] getSession failed", err);
      });
    const { data: sub } = supabase.auth.onAuthStateChange(
      (_event: string, s: Session | null) => {
        setSession({ token: s?.access_token ?? null, userId: s?.user?.id ?? null });
      },
    );
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    accessToken: session.token,
    userId: session.userId,
    appSlug: "gravelens",
    hubUrl: process.env.NEXT_PUBLIC_LOWHIGH_API_BASE || "https://www.lowhigh.ai",
  };
}

/** Persistent ecosystem app switcher; mount inline in the PageShell header. */
export function EcosystemLauncher() {
  const ready = useShellReady();
  const config = useShellConfig();
  const ref = useRef<ShellElement | null>(null);

  useEffect(() => {
    if (ready && ref.current) ref.current.config = config;
    // Keyed on the primitives that can actually change at runtime; the
    // element also self-guards against no-op config re-sets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, config.accessToken, config.userId]);

  return React.createElement("lowhigh-launcher", {
    ref,
    style: THEME_STYLE,
    "aria-hidden": ready ? undefined : "true",
  });
}

/** Support sheet host; mount once at the layout root (never inside a
 *  transformed/backdrop-filtered ancestor, which would break position:fixed). */
export function LowHighSupportHost() {
  const ready = useShellReady();
  const config = useShellConfig();
  const ref = useRef<ShellElement | null>(null);

  useEffect(() => {
    if (ready && ref.current) ref.current.config = config;
    // Keyed on the primitives that can actually change at runtime; the
    // element also self-guards against no-op config re-sets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, config.accessToken, config.userId]);

  // Revoke the previous preview object URL when a new capture replaces it.
  const lastPreviewUrl = useRef<string | null>(null);

  useEffect(() => {
    const onOpen = () => {
      const el = ref.current;
      if (!el) return;

      // Clear any stale screenshot from a prior open before capturing fresh.
      if (lastPreviewUrl.current) URL.revokeObjectURL(lastPreviewUrl.current);
      lastPreviewUrl.current = null;
      el.pendingAttachment = null;

      el.setAttribute("open", "");

      // Capture the page beneath the popups (async; the widget shows the
      // thumbnail once ready). Upload is lazy — only on submit. Silent on
      // failure so support is never blocked.
      const userId = el.config?.userId ?? null;
      if (!userId) return;
      void captureViewport().then((res) => {
        if (!res) return;
        if (!el.isConnected) {
          URL.revokeObjectURL(res.previewUrl);
          return;
        }
        lastPreviewUrl.current = res.previewUrl;
        el.pendingAttachment = {
          previewUrl: res.previewUrl,
          name: "screenshot.webp",
          upload: () => uploadCapture(res.blob, userId),
        };
      });
    };
    window.addEventListener(OPEN_SUPPORT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SUPPORT_EVENT, onOpen);
  }, []);

  return React.createElement("lowhigh-support", { ref, style: THEME_STYLE });
}
