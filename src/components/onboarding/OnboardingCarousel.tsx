"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import BrandLogo from "@/components/ui/BrandLogo";

const STORAGE_KEY = "gl_onboarding_seen";

const SLIDES = [
  {
    icon: (
      <div className="relative flex items-center justify-center w-20 h-20">
        <div className="absolute inset-0 rounded-full bg-[var(--t-gold-500)]/10 blur-2xl animate-pulse" />
        <BrandLogo size={64} color="var(--t-gold-500)" />
      </div>
    ),
    headline: "Point. Scan. Discover.",
    body: "Photograph any headstone and GraveLens reads the inscription — even worn, weathered, or hard-to-read markers.",
  },
  {
    icon: (
      <div className="flex flex-wrap gap-2 justify-center w-56">
        {["Newspapers", "Census", "Military", "Immigration", "Land Records", "Wikipedia"].map((label) => (
          <span
            key={label}
            className="px-2.5 py-1 rounded-full text-xs font-medium border"
            style={{ borderColor: "rgba(201,168,76,0.35)", color: "var(--t-gold-400)", background: "rgba(201,168,76,0.08)" }}
          >
            {label}
          </span>
        ))}
      </div>
    ),
    headline: "18+ sources. One scan.",
    body: "Census records, military service, immigration manifests, historical newspapers — assembled automatically in seconds.",
  },
  {
    icon: (
      <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        <polyline points="9 22 9 12 15 12 15 22"/>
      </svg>
    ),
    headline: "Your archive, forever.",
    body: "Every scan is saved to your personal archive — browseable on a map, accessible offline, and yours to keep. Sign in with a free LowHigh account to scan and sync across your devices.",
  },
];

export default function OnboardingCarousel() {
  const [visible, setVisible] = useState(false);
  const [idx, setIdx] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTimeout(() => {
      setMounted(true);
      if (!localStorage.getItem(STORAGE_KEY)) {
        setVisible(true);
      }
    }, 0);
  }, []);

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, "1");
    setVisible(false);
  };

  const next = () => {
    if (idx < SLIDES.length - 1) {
      setIdx(idx + 1);
    } else {
      dismiss();
    }
  };

  if (!mounted || !visible) return null;

  const slide = SLIDES[idx];
  const isLast = idx === SLIDES.length - 1;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center"
      style={{
        // Semi-transparent so the app is visible above the sheet
        background: "rgba(10, 9, 8, 0.55)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        // Push the sheet above the bottom nav (72px bar + safe area)
        paddingBottom: "calc(80px + env(safe-area-inset-bottom, 16px))",
      }}
    >
      <div
        className="relative w-full sm:max-w-sm mx-auto rounded-t-3xl sm:rounded-3xl overflow-hidden"
        style={{ background: "#121110", border: "1px solid rgba(255,255,255,0.07)" }}
      >
        {/* Gold top accent */}
        <div className="h-px w-full" style={{ background: "linear-gradient(90deg, transparent, var(--t-gold-500), transparent)" }} />

        <div className="px-7 pt-8 pb-7 flex flex-col items-center gap-6 text-center">
          {/* Slide icon */}
          <div className="flex items-center justify-center min-h-[80px]">
            {slide.icon}
          </div>

          {/* Text */}
          <div className="flex flex-col gap-2">
            <h2 className="font-serif text-2xl font-semibold text-stone-100 leading-snug">
              {slide.headline}
            </h2>
            <p className="text-stone-400 text-sm leading-relaxed">
              {slide.body}
            </p>
          </div>

          {/* Dot indicators */}
          <div className="flex gap-1.5">
            {SLIDES.map((_, i) => (
              <button
                key={i}
                onClick={() => setIdx(i)}
                className="rounded-full transition-all"
                style={{
                  width: i === idx ? 20 : 6,
                  height: 6,
                  background: i === idx ? "var(--t-gold-500)" : "rgba(255,255,255,0.15)",
                }}
                aria-label={`Go to slide ${i + 1}`}
              />
            ))}
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2 w-full">
            <button
              onClick={next}
              className="w-full py-3 rounded-2xl text-sm font-semibold transition-all active:scale-[0.98]"
              style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
            >
              {isLast ? "Get Started" : "Next"}
            </button>
            {!isLast && (
              <button
                onClick={dismiss}
                className="w-full py-2 text-sm text-stone-500 active:text-stone-300 transition-colors"
              >
                Skip
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
