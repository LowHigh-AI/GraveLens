"use client";

import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import PageShell from "@/components/layout/PageShell";
import { getAllGraves } from "@/lib/storage";
import type { CommunityGraveRecord, GraveRecord } from "@/types";
import { loadSettings } from "@/lib/settings";
import { useAuth } from "@/lib/auth";
import { createClient } from "@/lib/supabase/browser";
import { fetchCommunityGravesInBounds } from "@/lib/community";
import { SHOW_COMMUNITY_FEATURES } from "@/lib/config";
import { TourMode, type TourEvent } from "@/lib/tourMode";

const ArchiveMap = dynamic(() => import("./ArchiveMap"), { ssr: false });

export default function MapPage() {
  const { user } = useAuth();
  const [graves, setGraves] = useState<GraveRecord[]>([]);
  const [communityGraves, setCommunityGraves] = useState<CommunityGraveRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  // Discovery State — default radius seeded from settings (miles)
  const [findRadius, setFindRadius] = useState(() => {
    const miles = loadSettings().defaultSearchRadius;
    // Map to closest available mile option: 1→5, 5→5, 10→15, 25→50
    if (miles <= 5) return 5;
    if (miles <= 10) return 15;
    return 50;
  });
  const [findTrigger, setFindTrigger] = useState(0);
  const [hasManualResults, setHasManualResults] = useState(false);
  const [searchToast, setSearchToast] = useState<string | null>(null);
  const searchToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showSearchToast = useCallback((msg: string) => {
    setSearchToast(msg);
    if (searchToastTimerRef.current) clearTimeout(searchToastTimerRef.current);
    searchToastTimerRef.current = setTimeout(() => setSearchToast(null), 4000);
  }, []);

  // Geolocation & Ghost Tour State
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
  const [tourActive, setTourActive] = useState(false);
  const [tourError, setTourError] = useState<string | null>(null);
  const [tourToast, setTourToast] = useState<{ grave: GraveRecord; status: TourEvent["type"] } | null>(null);
  const tourRef = useRef<TourMode | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Central Geolocation Watcher
  useEffect(() => {
    if (typeof window === "undefined" || !("geolocation" in navigator)) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setUserLocation([lat, lng]);
        tourRef.current?.updateLocation(lat, lng);
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  const handleTourEvent = useCallback((e: TourEvent) => {
    if (e.type === "finished") {
      setTourToast(null);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      return;
    }
    setTourToast({ grave: e.grave, status: e.type });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    if (e.type !== "playing") {
      toastTimerRef.current = setTimeout(() => setTourToast(null), 8000);
    }
  }, []);

  const toggleTour = useCallback(async () => {
    if (tourActive) {
      tourRef.current?.stop();
      tourRef.current = null;
      setTourActive(false);
      setTourToast(null);
      setTourError(null);
      return;
    }
    setTourError(null);
    const tour = new TourMode(handleTourEvent);
    tour.updateGraves(graves);
    try {
      await tour.start();
      if (userLocation) {
        tour.updateLocation(userLocation[0], userLocation[1]);
      }
      tourRef.current = tour;
      setTourActive(true);
    } catch {
      setTourError("Location access is required for Ghost Tour.");
    }
  }, [tourActive, graves, handleTourEvent, userLocation]);

  // Keep tour's grave list fresh
  useEffect(() => {
    tourRef.current?.updateGraves(graves);
  }, [graves]);

  // Clean up tour on unmount
  useEffect(() => {
    return () => { tourRef.current?.stop(); if (toastTimerRef.current) clearTimeout(toastTimerRef.current); };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 2000);
    getAllGraves().then((g) => {
      setGraves(g);
      setLoading(false);
      clearTimeout(timer);
    }).catch(() => {
      setLoading(false);
      clearTimeout(timer);
    });
    return () => clearTimeout(timer);
  }, []);

  // Fetch community graves when the user is signed in and community features enabled.
  useEffect(() => {
    if (!user || !SHOW_COMMUNITY_FEATURES) return;
    const supabase = createClient();
    fetchCommunityGravesInBounds(supabase, user.id, 24, -125, 50, -66)
      .then(setCommunityGraves)
      .catch(() => {});
  }, [user]);

  const filteredGraves = useMemo(() => {
    return graves.filter((g) => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      const name = g.extracted.name?.toLowerCase() || "";
      const cemetery = g.location?.cemetery?.toLowerCase() || "";
      const city = g.location?.city?.toLowerCase() || "";
      const state = g.location?.state?.toLowerCase() || "";
      return name.includes(q) || cemetery.includes(q) || city.includes(q) || state.includes(q);
    });
  }, [graves, searchQuery]);

  return (
    <PageShell
      noScroll={true}
      title="Discovery Map"
      icon={
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
        </svg>
      }
      customMainClasses="w-full h-full relative"
      headerTitleActions={null}
      headerActions={
        <div className="flex items-center gap-2">
          {/* Ghost Tour toggle */}
          <button
            onClick={toggleTour}
            title={tourActive ? "Stop Ghost Tour" : "Start Ghost Tour — plays audio as you walk"}
            className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
            style={{
              background: tourActive ? "rgba(201,168,76,0.2)" : "rgba(42,40,38,1)",
              border: tourActive ? "1px solid rgba(201,168,76,0.5)" : "1px solid transparent",
            }}
            aria-label="Ghost Tour mode"
          >
            {tourActive ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6a6560" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
              </svg>
            )}
          </button>

          <button
            onClick={() => setMenuOpen((o) => !o)}
            className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${
              menuOpen ? "bg-stone-700" : "bg-stone-800"
            }`}
            aria-label="Discovery and Search"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={menuOpen ? "var(--t-gold-500)" : "var(--t-stone-500)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </button>
        </div>
      }
      headerPanels={
        menuOpen && (
          <div className="px-4 pb-3 border-t border-stone-800 pt-3 flex flex-col gap-3">

            {/* Archive search */}
            <div className="relative">
              <input
                autoFocus
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search name, cemetery, or city..."
                className="w-full bg-stone-800 text-stone-200 text-sm rounded-lg pl-9 pr-4 py-1.5 border border-stone-700 focus:outline-none focus:border-gold-500/50"
              />
              <div className="absolute left-3 top-2 text-stone-500">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
              </div>
            </div>

            {/* Discovery settings */}
            <div className="flex gap-2">
              <div className="flex items-center rounded-lg overflow-hidden border border-stone-700 bg-stone-800">
                {[5, 15, 50].map((r) => (
                  <button
                    key={r}
                    onClick={() => setFindRadius(r)}
                    className="w-12 h-8 text-xs transition-colors font-medium"
                    style={{ color: findRadius === r ? "var(--t-gold-500)" : "#6a6560", background: findRadius === r ? "rgba(201,168,76,0.12)" : "transparent" }}
                  >
                    {r === 50 ? "50+" : `${r}mi`}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                id="execute-map-search"
                onClick={() => {
                  setFindTrigger(Date.now());
                  setMenuOpen(false);
                }}
                className="flex-1 py-2 rounded-lg font-semibold text-sm active:scale-[0.97] transition-all"
                style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
              >
                Search
              </button>
              {hasManualResults && (
                <button
                  onClick={() => {
                    setFindTrigger(-1);
                    setMenuOpen(false);
                  }}
                  className="px-4 rounded-lg bg-stone-800 text-stone-500 border border-stone-700 active:bg-stone-700 transition-colors flex items-center justify-center hover:text-stone-200"
                  aria-label="Clear results"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              )}
            </div>
          </div>
        )
      }
    >
      {/* Main Map Background */}
      {loading ? (
        <div className="w-full h-full flex items-center justify-center bg-stone-950">
          <div className="flex flex-col items-center gap-4">
            <div className="w-10 h-10 border-2 border-gold-500 border-t-transparent rounded-full animate-spin" />
            <p className="font-serif italic text-stone-500 text-sm tracking-widest animate-pulse">Initializing Archive...</p>
          </div>
        </div>
      ) : (
        <ArchiveMap
          graves={filteredGraves}
          allGraves={graves}
          communityGraves={communityGraves}
          findRadius={findRadius}
          findTrigger={findTrigger}
          userLocation={userLocation}
          onSearchStateChange={(_searching, hasResults) => setHasManualResults(hasResults)}
          // All post-search messaging (failure / cap / clamp / empty) is owned by
          // ArchiveMap's handleSearchHere and routed through this single channel so
          // the messages don't clobber each other in the shared one-slot toast.
          onSearchNotice={(msg) => (msg ? showSearchToast(msg) : setSearchToast(null))}
          onClearFind={() => setFindTrigger(0)}
        />
      )}

      {/* Ghost Tour: active banner */}
      {tourActive && !tourToast && (
        <div
          className="absolute bottom-24 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-medium animate-fade-in"
          style={{ background: "rgba(10,9,8,0.88)", border: "1px solid rgba(201,168,76,0.4)", color: "var(--t-gold-400)", backdropFilter: "blur(8px)" }}
        >
          <span className="w-2 h-2 rounded-full bg-[var(--t-gold-500)] animate-pulse" />
          Ghost Tour active — walk to a grave
        </div>
      )}

      {/* Ghost Tour: grave entered toast */}
      {tourToast && (
        <div
          className="absolute bottom-24 left-4 right-4 z-40 flex items-center gap-3 px-4 py-3 rounded-2xl animate-fade-in"
          style={{ background: "rgba(10,9,8,0.92)", border: "1px solid rgba(201,168,76,0.3)", backdropFilter: "blur(12px)" }}
        >
          <span className="text-2xl shrink-0">
            {tourToast.status === "playing" ? "🔊" : tourToast.status === "no_audio" ? "🔇" : "⚠️"}
          </span>
          <div className="flex-1 min-w-0">
            <p className="font-serif text-stone-100 text-sm font-semibold truncate">
              {tourToast.grave.extracted.name || "Unknown"}
            </p>
            <p className="text-stone-400 text-xs mt-0.5">
              {tourToast.status === "playing" ? "Now playing their story…"
               : tourToast.status === "no_audio" ? "No story recorded — tap the grave to generate one"
               : "Playback error — try tapping the grave"}
            </p>
          </div>
          <button onClick={() => setTourToast(null)} className="w-6 h-6 flex items-center justify-center text-stone-500 shrink-0">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      )}

      {/* Search: transient notice (no results / clamped to center) */}
      {searchToast && (
        <div
          className="absolute bottom-24 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-medium animate-fade-in"
          style={{ background: "rgba(10,9,8,0.88)", border: "1px solid rgba(201,168,76,0.3)", color: "var(--t-stone-300)", backdropFilter: "blur(8px)" }}
        >
          {searchToast}
        </div>
      )}

      {/* Ghost Tour: permission error */}
      {tourError && (
        <div
          className="absolute bottom-24 left-4 right-4 z-40 px-4 py-3 rounded-2xl animate-fade-in text-sm text-red-300"
          style={{ background: "rgba(10,9,8,0.92)", border: "1px solid rgba(220,60,60,0.3)", backdropFilter: "blur(8px)" }}
        >
          {tourError}
        </div>
      )}
    </PageShell>
  );
}
