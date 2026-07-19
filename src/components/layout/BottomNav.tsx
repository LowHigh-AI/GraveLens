"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { haptic } from "@/lib/haptic";
import { recordActiveDay, unseenCount, ACHIEVEMENT_UNSEEN_EVENT } from "@/lib/achievements";
import { getQueueCount } from "@/lib/storage";
import { startQueueProcessor, QUEUE_CHANGED_EVENT } from "@/lib/queue";
import { setPendingCaptureFile } from "@/lib/pendingCapture";

const leftTabs = [
  {
    href: "/",
    label: "Home",
    icon: (active: boolean) => (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke={active ? "var(--t-gold-500)" : "var(--t-stone-500)"}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9.5z" />
        <path d="M9 21V12h6v9" />
      </svg>
    ),
  },
  {
    href: "/archive",
    label: "Archive",
    icon: (active: boolean) => (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke={active ? "var(--t-gold-500)" : "var(--t-stone-500)"}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6z" />
        <path d="M3 12h18M3 18h18M7 12v6M12 12v6M17 12v6" />
      </svg>
    ),
  },
];

const rightTabs = [
  {
    href: "/map",
    label: "Map",
    icon: (active: boolean) => (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke={active ? "var(--t-gold-500)" : "var(--t-stone-500)"}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 11 7 11s7-5.75 7-11c0-3.87-3.13-7-7-7z" strokeLinejoin="round" />
        <circle cx="12" cy="9" r="2.5" />
      </svg>
    ),
  },
  {
    href: "/explorer",
    label: "Explorer",
    icon: (active: boolean) => (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke={active ? "var(--t-gold-500)" : "var(--t-stone-500)"}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
      </svg>
    ),
  },
];

export default function BottomNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [queueCount, setQueueCount] = useState(0);
  const [unseen, setUnseen] = useState(0);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    recordActiveDay();

    getQueueCount().then(setQueueCount).catch(() => {});

    const onQueueChanged = () => {
      getQueueCount().then(setQueueCount).catch(() => {});
    };
    window.addEventListener(QUEUE_CHANGED_EVENT, onQueueChanged);

    // Explorer "unseen unlocks" badge — recompute on unlock/view/cloud-merge.
    const refreshUnseen = () => setUnseen(unseenCount());
    refreshUnseen();
    window.addEventListener(ACHIEVEMENT_UNSEEN_EVENT, refreshUnseen);

    const cleanup = startQueueProcessor();

    return () => {
      window.removeEventListener(QUEUE_CHANGED_EVENT, onQueueChanged);
      window.removeEventListener(ACHIEVEMENT_UNSEEN_EVENT, refreshUnseen);
      cleanup();
    };
  }, []);

  const handleCameraClick = () => {
    haptic("medium");
    if (pathname === "/") {
      window.dispatchEvent(new Event("gravelens:open-camera"));
    } else {
      cameraInputRef.current?.click();
    }
  };

  const handleFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPendingCaptureFile(file);
    router.push("/");
  };

  return (
    <div className="lg:hidden fixed bottom-0 left-0 right-0 z-50 flex justify-center px-4 pointer-events-none" style={{ paddingBottom: "max(calc(env(safe-area-inset-bottom) + 0.5rem), 1rem)" }}>
      <nav className="glass relative pointer-events-auto flex items-center justify-between w-full max-w-[400px] h-[72px] rounded-[36px] border border-stone-700/50 bg-stone-950/85 backdrop-blur-2xl shadow-[0_20px_40px_-8px_rgba(0,0,0,0.8)] px-2">
        
        {/* Left tabs */}
        <div className="flex items-center justify-around flex-1 h-full">
          {leftTabs.map((tab) => {
            const isActive =
              tab.href === "/"
                ? pathname === "/" || pathname.startsWith("/result")
                : pathname === tab.href || pathname.startsWith(tab.href + "/");

            const showBadge = tab.href === "/" && queueCount > 0;

            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-label={tab.label}
                aria-current={isActive ? "page" : undefined}
                className={`relative flex flex-col items-center justify-center w-[64px] h-[64px] rounded-[32px] transition-all duration-300 active:scale-95 ${isActive ? 'bg-white/10 shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]' : 'hover:bg-white/5'}`}
              >
                {tab.icon(isActive)}
                {showBadge && (
                  <span
                    className="absolute top-1 right-1 min-w-[16px] h-4 rounded-full text-[0.75rem] font-bold flex items-center justify-center px-1"
                    style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
                  >
                    {queueCount > 9 ? "9+" : queueCount}
                  </span>
                )}
                <span
                  className="text-[0.75rem] font-bold tracking-wide uppercase mt-1 transition-colors"
                  style={{ color: isActive ? "var(--t-gold-500)" : "var(--t-stone-500)", textShadow: "none" }}
                >
                  {tab.label}
                </span>
              </Link>
            );
          })}
        </div>

        {/* Center Action FAB */}
        <div className="flex-shrink-0 mx-1 -mt-8 relative z-10 transition-transform active:scale-[0.92]">
          <div className="p-1.5 rounded-full bg-stone-950/60 backdrop-blur-md shadow-[0_8px_16px_rgba(0,0,0,0.4)]">
            <button
              onClick={handleCameraClick}
              className="relative w-[64px] h-[64px] rounded-full flex items-center justify-center overflow-hidden"
              style={{
                background: "linear-gradient(135deg, #eadd9a 0%, var(--t-gold-500) 50%, #9e7f33 100%)",
                boxShadow: "0 8px 24px rgba(201, 168, 76, 0.4), inset 0 2px 4px rgba(255,255,255,0.4), inset 0 -2px 8px rgba(0,0,0,0.2)",
              }}
              aria-label="Take a photo"
            >
              <div className="absolute inset-[1px] rounded-full border border-white/30 pointer-events-none" />
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#1a1917" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ filter: "drop-shadow(0 2px 2px rgba(255,255,255,0.4))" }}>
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                <circle cx="12" cy="13" r="4"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Right tabs */}
        <div className="flex items-center justify-around flex-1 h-full">
          {rightTabs.map((tab) => {
            const isActive =
              pathname === tab.href || pathname.startsWith(tab.href + "/");

            const showBadge = tab.href === "/explorer" && unseen > 0;

            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-label={showBadge ? `${tab.label}, ${unseen} new` : tab.label}
                aria-current={isActive ? "page" : undefined}
                className={`relative flex flex-col items-center justify-center w-[64px] h-[64px] rounded-[32px] transition-all duration-300 active:scale-95 ${isActive ? 'bg-white/10 shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]' : 'hover:bg-white/5'}`}
              >
                {tab.icon(isActive)}
                {showBadge && (
                  <span
                    className="absolute top-1 right-1 min-w-[16px] h-4 rounded-full text-[0.75rem] font-bold flex items-center justify-center px-1"
                    style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
                  >
                    {unseen > 9 ? "9+" : unseen}
                  </span>
                )}
                <span
                  className="text-[0.75rem] font-bold tracking-wide uppercase mt-1 transition-colors"
                  style={{ color: isActive ? "var(--t-gold-500)" : "var(--t-stone-500)", textShadow: "none" }}
                >
                  {tab.label}
                </span>
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Hidden camera input — used when FAB is tapped from non-capture pages */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFileChosen}
      />
    </div>
  );
}

// Exporting the event name so CapturePage can listen for it
export const OPEN_CAMERA_EVENT = "gravelens:open-camera";
