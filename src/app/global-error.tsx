"use client";

import { useEffect } from "react";

/**
 * Root-level error boundary. Unlike error.tsx, this catches failures thrown by
 * the root layout itself and its providers (AuthProvider, EcosystemProvider,
 * ServiceWorkerRegister) — cases where error.tsx never mounts. It must render
 * its own <html>/<body> because it replaces the whole document tree.
 *
 * Kept deliberately dependency-free (inline styles, no imported components) so
 * it can render even if the failure is in the shared UI/provider layer.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[Global Error Boundary]:", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: "3rem 1.5rem",
          background: "#0c0a09",
          color: "#fafaf9",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <div style={{ maxWidth: "28rem", width: "100%" }}>
          <div
            style={{
              fontFamily: "Playfair Display, Georgia, serif",
              fontSize: "1.5rem",
              fontWeight: 600,
              letterSpacing: "0.02em",
              marginBottom: "2rem",
            }}
          >
            <span>Grave</span>
            <span style={{ color: "#c9a84c" }}>Lens</span>
          </div>

          <h1
            style={{
              fontSize: "1.5rem",
              fontWeight: 600,
              lineHeight: 1.3,
              margin: "0 0 0.75rem",
            }}
          >
            Something went wrong
          </h1>
          <p
            style={{
              color: "#a8a29e",
              fontSize: "0.875rem",
              lineHeight: 1.6,
              margin: "0 0 1.75rem",
            }}
          >
            An unexpected error occurred. Your saved data and scan queue remain
            secure on this device.
          </p>

          {error.digest && (
            <p
              style={{
                color: "#78716c",
                fontSize: "0.65rem",
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                marginBottom: "1.75rem",
              }}
            >
              Digest: {error.digest}
            </p>
          )}

          <button
            onClick={() => reset()}
            style={{
              width: "100%",
              height: "3rem",
              border: "none",
              borderRadius: "0.75rem",
              fontWeight: 600,
              fontSize: "0.875rem",
              color: "#1a1917",
              cursor: "pointer",
              background: "linear-gradient(135deg, #c9a84c, #d9bd63)",
            }}
          >
            Try Again
          </button>
        </div>
      </body>
    </html>
  );
}
