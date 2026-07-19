import { domToBlob } from "modern-screenshot";

/**
 * Silently rasterizes the current page to a WebP screenshot for support tickets.
 *
 * Why DOM rasterization (not the native Screen Capture API): GraveLens is
 * mobile-first, and getDisplayMedia is unsupported on iOS Safari and always
 * prompts. domToBlob runs with no permission prompt on mobile + desktop.
 *
 * Overlays the user went *through* to reach support (the settings panel, the
 * support drawer, the ecosystem launcher) are excluded so the capture shows the
 * app screen that is actually causing the issue. Tag any host overlay you want
 * omitted with `data-lh-capture-ignore`.
 *
 * Caveat: rasterization is imperfect on <canvas>/WebGL and cross-origin-tainted
 * images (e.g. the live photo editor). Any failure returns null — the caller
 * degrades to a text-only ticket rather than blocking support.
 */

/** Longest edge of the output, in CSS px; keeps uploads small. */
const MAX_EDGE = 1600;

/** Nodes excluded from the capture (the popups, not the page beneath them). */
const IGNORE_SELECTOR = "lowhigh-support, lowhigh-launcher, [data-lh-capture-ignore]";

export interface CaptureResult {
  blob: Blob;
  /** Object URL for a thumbnail preview; caller must revoke it when done. */
  previewUrl: string;
}

export async function captureViewport(): Promise<CaptureResult | null> {
  if (typeof window === "undefined" || typeof document === "undefined") return null;

  const target = document.body;
  if (!target) return null;

  try {
    const rawW = target.scrollWidth || window.innerWidth;
    const rawH = target.scrollHeight || window.innerHeight;
    const scale = Math.min(1, MAX_EDGE / Math.max(rawW, rawH));

    // Solid backdrop so transparent regions don't rasterize to black.
    const backgroundColor =
      getComputedStyle(document.body).backgroundColor || "#1c1917";

    const blob = await domToBlob(target, {
      type: "image/webp",
      quality: 0.8,
      scale,
      backgroundColor,
      filter: (node: Node) => {
        if (node instanceof Element && node.matches(IGNORE_SELECTOR)) return false;
        return true;
      },
    });

    if (!blob) return null;
    return { blob, previewUrl: URL.createObjectURL(blob) };
  } catch (err) {
    console.warn("[gravelens] support screenshot capture failed:", err);
    return null;
  }
}
