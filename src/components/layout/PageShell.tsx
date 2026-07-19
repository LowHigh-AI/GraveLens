"use client";

import React, { ReactNode, useEffect, useState } from "react";
import BottomNav from "@/components/layout/BottomNav";
import DesktopNav from "@/components/layout/DesktopNav";
import ProfileBadge from "@/components/auth/ProfileBadge";
import BrandLogo from "@/components/ui/BrandLogo";
import { EcosystemLauncher } from "@/components/ecosystem/lowhighShell";
import { useIsDesktop } from "@/hooks/useIsDesktop";
import TokenAlertBar from "@/components/billing/TokenAlertBar";

interface PageShellProps {
  children: ReactNode;
  title?: string;
  icon?: ReactNode;
  showLogo?: boolean;
  headerActions?: ReactNode;
  headerTitleActions?: ReactNode;
  headerBottomRow?: ReactNode;
  headerPanels?: ReactNode;
  noScroll?: boolean;
  customMainClasses?: string;
  absoluteOverlays?: ReactNode;
  backgroundClass?: string;
}

export default function PageShell({
  children,
  title,
  icon,
  showLogo = false,
  headerActions,
  headerTitleActions,
  headerBottomRow,
  headerPanels,
  noScroll = false,
  customMainClasses,
  absoluteOverlays,
  backgroundClass = "bg-stone-900",
}: PageShellProps) {
  const [offline, setOffline] = useState(false);
  const isDesktop = useIsDesktop();

  useEffect(() => {
    setTimeout(() => {
      setOffline(!navigator.onLine);
    }, 0);
    const onOnline  = () => setOffline(false);
    const onOffline = () => setOffline(true);
    window.addEventListener("online",  onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online",  onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return (
    <div className={`flex flex-col h-full ${backgroundClass} overflow-hidden relative w-full lg:pl-56`}>
      {isDesktop && <DesktopNav />}
      {/* Running-low / out-of-tokens system bar (dismissible; dot persists on the badge). */}
      <TokenAlertBar />
      {/* Offline banner */}
      {offline && (
        <div
          className="flex-shrink-0 flex items-center justify-center gap-2 py-1.5 text-xs font-medium z-40"
          style={{
            background: "rgba(180, 120, 20, 0.15)",
            borderBottom: "1px solid rgba(201, 168, 76, 0.25)",
            color: "var(--t-gold-500)",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.56 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01" />
          </svg>
          No connection — scans will queue automatically
        </div>
      )}

      {/* Header */}
      <header
        className="flex-shrink-0 z-30 bg-stone-950/80 backdrop-blur-2xl"
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        <div className="flex flex-col gap-3 px-4 pb-3 pt-1">
          {/* Top Row: Brand & Core Actions */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex flex-col min-w-0">
                {showLogo && !isDesktop ? (
                  <div className="flex flex-col">
                    <div className="flex items-center gap-2">
                      <BrandLogo size={22} color="var(--t-gold-500)" />
                      <span className="font-serif font-semibold tracking-wide text-[1.5rem] leading-none">
                        <span className="text-stone-50">Grave</span><span style={{ color: "var(--t-gold-500)" }}>Lens</span>
                      </span>
                    </div>
                    <span className="italic text-white text-[0.65rem] leading-none opacity-60 mt-1 ml-7">
                      By <a href="https://www.lowhigh.ai" target="_blank" rel="noopener noreferrer" className="hover:text-gold-400">LowHigh</a>
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2.5 py-1">
                    {icon && <div className="text-gold-400 shrink-0">{icon}</div>}
                    <h1 className="font-serif font-bold text-xl tracking-tight text-stone-50 truncate">
                      {title}
                    </h1>
                  </div>
                )}
              </div>
              {headerTitleActions}
            </div>

            <div className="flex items-center gap-3 min-w-0">
              {headerActions}
              {/* Ecosystem app switcher (shared LowHigh shell). Renders from
                  the central app catalog; anchored dropdown, safe inside the
                  header. */}
              <EcosystemLauncher />
              {/* Profile/account control lives top-right in the header on both
                  desktop and mobile, mirroring the LowHigh global header. */}
              <ProfileBadge />
            </div>
          </div>

          {/* Bottom Row: Tab Segments & View Modes */}
          {headerBottomRow && (
            <div className="flex items-center justify-between">
              {headerBottomRow}
            </div>
          )}
        </div>

        {/* Floating/Expanding Panels (Search, Filter, Map settings) */}
        {headerPanels}
      </header>

      {/* Main Content */}
      <main
        className={`flex-1 flex flex-col ${
          noScroll ? "overflow-hidden" : "scroll-container overflow-y-auto overflow-x-hidden"
        } ${customMainClasses !== undefined ? customMainClasses : "pb-44 lg:pb-8"}`}
        style={{ scrollbarWidth: "none" }}
      >
        {children}
      </main>

      {absoluteOverlays}

      {/* Bottom Navigation */}
      <div className="absolute bottom-0 left-0 right-0 z-[1001] pointer-events-none">
        <div className="pointer-events-auto">
          <BottomNav />
        </div>
      </div>
    </div>
  );
}
