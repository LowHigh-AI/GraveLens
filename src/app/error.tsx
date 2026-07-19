"use client";

import { useEffect } from "react";
import Link from "next/link";
import BrandLogo from "@/components/ui/BrandLogo";

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function RootError({ error, reset }: ErrorProps) {
  useEffect(() => {
    // Log the error to console or error reporting services
    console.error("[Uncaught Exception Boundary]:", error);
  }, [error]);

  return (
    <div
      className="flex flex-col items-center justify-center min-h-screen bg-stone-950 text-stone-50 px-6 py-12 text-center"
      style={{
        paddingTop: "max(3rem, env(safe-area-inset-top))",
        paddingBottom: "max(3rem, env(safe-area-inset-bottom))",
      }}
    >
      {/* Brand logo & header */}
      <div className="flex items-center gap-2.5 mb-10 select-none">
        <BrandLogo size={28} color="var(--t-gold-500)" />
        <span className="font-serif text-2xl font-semibold tracking-wide">
          <span className="text-stone-50">Grave</span>
          <span style={{ color: "var(--t-gold-500)" }}>Lens</span>
        </span>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center max-w-md w-full">
        {/* Warning Icon Container */}
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center mb-6 relative"
          style={{
            background: "rgba(239, 68, 68, 0.08)",
            border: "1px solid rgba(239, 68, 68, 0.25)",
            boxShadow: "0 0 15px rgba(239, 68, 68, 0.15)",
          }}
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#ef4444"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>

        <h1 className="font-serif text-2xl sm:text-3xl font-semibold text-stone-100 mb-3 leading-snug">
          Something went wrong
        </h1>
        
        <p className="text-stone-400 text-sm leading-relaxed mb-6">
          An unexpected error occurred while processing this page. The scan queue and your saved data remain secure.
        </p>

        {/* Error Details Card (Glassmorphism). The raw message can leak internal
            strings, so it is dev-only; the digest is safe and stays for support. */}
        {((process.env.NODE_ENV !== "production" && error.message) || error.digest) && (
          <div
            className="w-full text-left rounded-xl p-4 mb-8 font-mono text-xs text-red-300 leading-relaxed overflow-x-auto max-h-36"
            style={{
              background: "rgba(255, 255, 255, 0.03)",
              border: "1px solid rgba(255, 255, 255, 0.06)",
              scrollbarWidth: "none",
            }}
          >
            <p className="font-semibold text-red-400 mb-1">Details:</p>
            {process.env.NODE_ENV !== "production" && error.message && (
              <p className="whitespace-pre-wrap">{error.message}</p>
            )}
            {error.digest && (
              <p className="text-stone-500 mt-2 text-[0.65rem]">Digest: {error.digest}</p>
            )}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-col gap-3 w-full">
          <button
            onClick={() => reset()}
            className="w-full h-12 rounded-xl font-semibold text-[#1a1917] text-sm transition-all active:scale-[0.97]"
            style={{
              background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))",
              boxShadow: "0 4px 15px rgba(201, 168, 76, 0.25)",
            }}
          >
            Try Again
          </button>
          
          <Link
            href="/"
            className="w-full h-12 rounded-xl border border-stone-800 hover:border-stone-700 text-stone-300 text-sm flex items-center justify-center transition-all active:scale-[0.97]"
            style={{
              background: "rgba(255, 255, 255, 0.02)",
            }}
          >
            Return to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
