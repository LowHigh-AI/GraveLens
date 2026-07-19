import type { NextConfig } from "next";
import { readFileSync } from "node:fs";

// Semantic version, single source of truth = package.json. Bump the patch/minor
// there on each publish (full major numbers are reserved for major releases).
const { version: appVersion } = JSON.parse(readFileSync("./package.json", "utf8"));

// Browser-facing origins the app legitimately connects to. The genealogical /
// AI APIs are all called server-side, so they are NOT listed here.
const supabaseOrigin = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const supabaseWs = supabaseOrigin.replace(/^https/, "wss");
const lowhighOrigin = (process.env.NEXT_PUBLIC_LOWHIGH_API_BASE || "").replace(/\/$/, "");

// sha256 of the static inline theme/font bootstrap script in src/app/layout.tsx.
// Recompute with: node -e '...' (see SECURITY notes) if that script changes.
const INLINE_BOOTSTRAP_HASH = "'sha256-DsEh7DU/1jed4fqaUbs/1438BRdH/2HftzmbTT2TTVk='";

const csp = [
  `default-src 'self'`,
  `script-src 'self' ${INLINE_BOOTSTRAP_HASH}`,
  // Leaflet and next/font inject inline styles.
  `style-src 'self' 'unsafe-inline'`,
  // data:/blob: for camera captures + thumbnails; https: for OSM map tiles and storage.
  `img-src 'self' data: blob: https:`,
  `font-src 'self'`,
  `connect-src 'self' ${supabaseOrigin} ${supabaseWs} ${lowhighOrigin}`.trim(),
  `frame-ancestors 'none'`,
  `base-uri 'self'`,
  `form-action 'self'`,
  `object-src 'none'`,
].join("; ");

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(self), browsing-topics=()" },
  // Report-Only for now: observe violations against the real origins (Supabase,
  // LowHigh, OSM tiles, Next streaming scripts) before flipping to enforcing
  // `Content-Security-Policy`.
  { key: "Content-Security-Policy-Report-Only", value: csp },
];

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  // Stamp every build with a unique timestamp so the running app can
  // detect when a newer version has been deployed on the server.
  env: {
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
    NEXT_PUBLIC_APP_VERSION: appVersion,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
