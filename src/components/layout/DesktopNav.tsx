"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import BrandLogo from "@/components/ui/BrandLogo";
import { getQueueCount } from "@/lib/storage";
import { QUEUE_CHANGED_EVENT } from "@/lib/queue";
import { useAuth } from "@/lib/auth";
import { unseenCount, ACHIEVEMENT_UNSEEN_EVENT } from "@/lib/achievements";

const navItems = [
  {
    href: "/",
    label: "Home",
    matchFn: (p: string) => p === "/" || p.startsWith("/result"),
    icon: (active: boolean) => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
        stroke={active ? "var(--t-gold-500)" : "var(--t-stone-400)"}
        strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9.5z" />
        <path d="M9 21V12h6v9" />
      </svg>
    ),
  },
  {
    href: "/archive",
    label: "Archive",
    matchFn: (p: string) => p === "/archive" || p.startsWith("/archive/"),
    icon: (active: boolean) => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
        stroke={active ? "var(--t-gold-500)" : "var(--t-stone-400)"}
        strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6z" />
        <path d="M3 12h18M3 18h18M7 12v6M12 12v6M17 12v6" />
      </svg>
    ),
  },
  {
    href: "/map",
    label: "Map",
    matchFn: (p: string) => p === "/map" || p.startsWith("/map/"),
    icon: (active: boolean) => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
        stroke={active ? "var(--t-gold-500)" : "var(--t-stone-400)"}
        strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 11 7 11s7-5.75 7-11c0-3.87-3.13-7-7-7z" />
        <circle cx="12" cy="9" r="2.5" />
      </svg>
    ),
  },
  {
    href: "/explorer",
    label: "Explorer",
    matchFn: (p: string) => p === "/explorer" || p.startsWith("/explorer/"),
    icon: (active: boolean) => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
        stroke={active ? "var(--t-gold-500)" : "var(--t-stone-400)"}
        strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
      </svg>
    ),
  },
];

export default function DesktopNav() {
  const pathname = usePathname();
  const { user, loading: authLoading } = useAuth();
  const [queueCount, setQueueCount] = useState(0);
  const [unseen, setUnseen] = useState(0);

  // Gate on the resolved auth state (tri-state) so we never flash "Sign In" at an
  // already-signed-in user during the brief auth-loading window.
  const signedOut = !authLoading && !user;

  useEffect(() => {
    getQueueCount().then(setQueueCount).catch(() => {});
    const onQueueChanged = () => getQueueCount().then(setQueueCount).catch(() => {});
    window.addEventListener(QUEUE_CHANGED_EVENT, onQueueChanged);

    // Explorer "unseen unlocks" badge — recompute on unlock/view/cloud-merge.
    const refreshUnseen = () => setUnseen(unseenCount());
    refreshUnseen();
    window.addEventListener(ACHIEVEMENT_UNSEEN_EVENT, refreshUnseen);

    return () => {
      window.removeEventListener(QUEUE_CHANGED_EVENT, onQueueChanged);
      window.removeEventListener(ACHIEVEMENT_UNSEEN_EVENT, refreshUnseen);
    };
  }, []);

  const isScanActive = pathname === "/" || pathname.startsWith("/result");

  return (
    <aside
      className="fixed left-0 top-0 bottom-0 w-56 z-40 flex flex-col bg-stone-950/80 backdrop-blur-2xl"
      style={{ paddingTop: "max(1.25rem, env(safe-area-inset-top))", paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
    >
      {/* Brand */}
      <div className="px-5 pb-5">
        <div className="flex items-center gap-2">
          <BrandLogo size={20} color="var(--t-gold-500)" />
          <span className="font-serif font-semibold text-[1.25rem] leading-none">
            <span className="text-stone-50">Grave</span>
            <span style={{ color: "var(--t-gold-500)" }}>Lens</span>
          </span>
        </div>
        <span className="italic text-white text-[0.6rem] leading-none opacity-50 mt-1 ml-7 block">
          By <a href="https://www.lowhigh.ai" target="_blank" rel="noopener noreferrer" className="hover:opacity-80">LowHigh</a>
        </span>
      </div>

      {/* Nav links */}
      <nav className="flex flex-col gap-0.5 px-3 pt-4 flex-1">
        {navItems.map((item) => {
          const active = item.matchFn(pathname);
          const badgeCount =
            item.href === "/" ? queueCount : item.href === "/explorer" ? unseen : 0;
          const showBadge = badgeCount > 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors"
              style={{
                background: active ? "rgba(201,168,76,0.1)" : "transparent",
                color: active ? "var(--t-gold-500)" : "var(--t-stone-400)",
              }}
              onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)"; }}
              onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              {item.icon(active)}
              <span className="text-sm font-medium">{item.label}</span>
              {showBadge && (
                <span
                  className="ml-auto min-w-[18px] h-[18px] rounded-full text-[0.7rem] font-bold flex items-center justify-center px-1"
                  style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
                >
                  {badgeCount > 9 ? "9+" : badgeCount}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Upload / Sign In button — scanning needs a LowHigh login, so signed-out
          users are routed to sign in rather than into the (gated) upload flow. */}
      <div className="px-3 pb-4">
        <Link
          href={signedOut ? "/login?next=/" : "/"}
          className="flex items-center justify-center gap-2 w-full h-10 rounded-xl text-sm font-semibold transition-opacity hover:opacity-90"
          style={{
            background: isScanActive
              ? "linear-gradient(135deg, #eadd9a 0%, var(--t-gold-500) 50%, #9e7f33 100%)"
              : "linear-gradient(135deg, #c9a84c 0%, #a07830 100%)",
            color: "#1a1917",
          }}
        >
          {signedOut ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
              <polyline points="10 17 15 12 10 7"/>
              <line x1="15" y1="12" x2="3" y2="12"/>
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          )}
          {signedOut ? "Sign In" : "Upload a Photo"}
        </Link>
      </div>
    </aside>
  );
}
