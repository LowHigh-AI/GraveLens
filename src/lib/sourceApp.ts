/**
 * Detect the app a user navigated from, ported from LowHigh's src/utils/sourceApp.ts.
 * In GraveLens this normally resolves to "gravelens" and lets the top-up page
 * personalize its estimate ("Covers ~N additional scans").
 */

import { APP_LABELS } from "./usageLabels";

const KNOWN_SLUGS = new Set(Object.keys(APP_LABELS));

const fromUrlParam = (): string | null => {
  if (typeof window === "undefined") return null;
  const param = new URLSearchParams(window.location.search).get("app");
  if (!param) return null;
  const cleaned = param.trim().toLowerCase();
  return KNOWN_SLUGS.has(cleaned) ? cleaned : null;
};

const fromReferrer = (): string | null => {
  if (typeof document === "undefined") return null;
  const ref = document.referrer;
  if (!ref) return null;
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return null;
  }
  const hostSegments = url.hostname.split(".");
  const pathSegments = url.pathname.split("/").filter(Boolean);
  for (const seg of [...hostSegments, ...pathSegments]) {
    const cleaned = seg.toLowerCase();
    if (KNOWN_SLUGS.has(cleaned)) return cleaned;
  }
  return null;
};

/**
 * Returns the source app slug from `?app=<slug>` or document.referrer, or null.
 */
export const detectSourceApp = (): string | null => {
  return fromUrlParam() ?? fromReferrer();
};
