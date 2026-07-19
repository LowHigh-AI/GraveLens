"use client";

import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraveRecord, NotableFigure, CommunityGraveRecord } from "@/types";
import { getNotableFiguresInBounds } from "@/lib/apis/wikidata";
import { formatOpeningHours } from "@/lib/apis/cemetery";
import { SHOW_COMMUNITY_FEATURES } from "@/lib/config";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CemeteryFeature {
  lat: number;
  lng: number;
  name: string;
  osmId?: string;
  openingHours?: string;
  phone?: string;
  website?: string;
  wikipedia?: string;
}

interface HeritagePlace {
  lat: number;
  lng: number;
  name: string;
  type: string;
  wikipedia?: string;
}

export type SearchType = "all" | "cemeteries" | "political" | "military" | "artist" | "musician" | "actor" | "relatives" | "other" | "heritage";
const RELATIVE_TAGS = ["family", "relative", "ancestor", "kin", "grandparent", "parent", "mother", "father"];

const FILTER_OPTIONS = [
  { id: "cemeteries", label: "Cemeteries" },
  { id: "heritage", label: "Heritage Sites" },
  { id: "relatives", label: "Family & Ancestors" },
  { id: "political", label: "Political Heritage" },
  { id: "military", label: "Military Service" },
  { id: "artist", label: "Artists" },
  { id: "musician", label: "Musicians" },
  { id: "actor", label: "Actors" },
  { id: "other", label: "Other Notable Figures" }
];

// ── Icon SVGs ─────────────────────────────────────────────────────────────────

const GRAVE_ICON_HTML = `
<svg width="28" height="36" viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,0.6))">
  <rect x="2" y="14" width="24" height="18" rx="2" fill="var(--t-gold-500)"/>
  <path d="M2 16 Q2 2 14 2 Q26 2 26 16" fill="var(--t-gold-500)"/>
  <line x1="14" y1="6" x2="14" y2="12" stroke="#1a1917" stroke-width="2" stroke-linecap="round"/>
  <line x1="10" y1="9" x2="18" y2="9" stroke="#1a1917" stroke-width="2" stroke-linecap="round"/>
  <rect x="10" y="20" width="8" height="9" rx="1" fill="#1a1917" opacity="0.3"/>
</svg>`.trim();

// Friend tier: Vibrant Purple
const FRIEND_GRAVE_ICON_HTML = `
<svg width="28" height="36" viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,0.6))">
  <rect x="2" y="14" width="24" height="18" rx="2" fill="#a855f7"/>
  <path d="M2 16 Q2 2 14 2 Q26 2 26 16" fill="#a855f7"/>
  <line x1="14" y1="6" x2="14" y2="12" stroke="#1a1917" stroke-width="2" stroke-linecap="round"/>
  <line x1="10" y1="9" x2="18" y2="9" stroke="#1a1917" stroke-width="2" stroke-linecap="round"/>
  <rect x="10" y="20" width="8" height="9" rx="1" fill="#1a1917" opacity="0.3"/>
</svg>`.trim();

// Community tier: Same Vibrant Purple for unified "Shared" identity
const COMMUNITY_GRAVE_ICON_HTML = `
<svg width="28" height="36" viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,0.6))">
  <rect x="2" y="14" width="24" height="18" rx="2" fill="#a855f7"/>
  <path d="M2 16 Q2 2 14 2 Q26 2 26 16" fill="#a855f7"/>
  <line x1="14" y1="6" x2="14" y2="12" stroke="#1a1917" stroke-width="2" stroke-linecap="round"/>
  <line x1="10" y1="9" x2="18" y2="9" stroke="#1a1917" stroke-width="2" stroke-linecap="round"/>
  <rect x="10" y="20" width="8" height="9" rx="1" fill="#1a1917" opacity="0.3"/>
</svg>`.trim();

const VISITED_ICON_HTML = `
<div style="filter:drop-shadow(0 2px 5px rgba(0,0,0,0.4))">
  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="16" cy="16" r="14" fill="#1a1917" stroke="var(--t-gold-500)" stroke-width="2.5"/>
    <path d="M10 16.5L14 20.5L23 11.5" stroke="var(--t-gold-500)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
</div>`.trim();

// ── Zoom-tier helpers ─────────────────────────────────────────────────────────

// Largest bbox (degrees) we'll send to Overpass in one "Search Here". Beyond this
// the cemetery query returns too much and times out, so we clamp to a centered box
// of this size rather than rejecting the search.
const MAX_SEARCH_LAT_DEG = 1.2;
const MAX_SEARCH_LNG_DEG = 1.5;

function wikidataMinSitelinks(zoom: number): number {
  if (zoom >= 13) return 2;
  if (zoom >= 10) return 15;
  if (zoom >= 8)  return 40;
  return 75;
}

// ── Overpass: cemeteries ──────────────────────────────────────────────────────

async function fetchCemeteriesInBounds(
  south: number,
  west: number,
  north: number,
  east: number,
  signal?: AbortSignal
): Promise<CemeteryFeature[]> {
  const query = `
[out:json][timeout:15];
(
  node["landuse"="cemetery"](${south},${west},${north},${east});
  way["landuse"="cemetery"](${south},${west},${north},${east});
  relation["landuse"="cemetery"](${south},${west},${north},${east});
  node["amenity"="grave_yard"](${south},${west},${north},${east});
  way["amenity"="grave_yard"](${south},${west},${north},${east});
  relation["amenity"="grave_yard"](${south},${west},${north},${east});
  node["historic"="cemetery"](${south},${west},${north},${east});
  way["historic"="cemetery"](${south},${west},${north},${east});
  relation["historic"="cemetery"](${south},${west},${north},${east});
);
out center tags 200;
`.trim();

  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: signal ? AbortSignal.any([AbortSignal.timeout(18000), signal]) : AbortSignal.timeout(18000),
    });
    if (!res.ok) return [];

    const data = await res.json();
    const results: CemeteryFeature[] = [];
    for (const el of data.elements ?? []) {
      const name = el.tags?.name;
      if (!name) continue;
      const osmId = `${el.type}/${el.id}`;
      const openingHours = el.tags?.opening_hours;
      const phone = el.tags?.phone ?? el.tags?.["contact:phone"];
      const website = el.tags?.website ?? el.tags?.["contact:website"] ?? el.tags?.url;
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (!lat || !lng) continue;
      const wikiRaw: string | undefined = el.tags?.wikipedia;
      const wikipedia = wikiRaw
        ? `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiRaw.replace(/^en:/, "").replace(/ /g, "_"))}`
        : undefined;
      results.push({ lat, lng, name, osmId, openingHours, phone, website, wikipedia });
    }
    const seen = new Set<string>();
    return results.filter((c) => { if (seen.has(c.name)) return false; seen.add(c.name); return true; });
  } catch (err) {
    // A caller-initiated cancellation must propagate so a superseded search
    // doesn't clobber the newer one's results; timeouts degrade to empty.
    if ((err as Error)?.name === "AbortError") throw err;
    return [];
  }
}

// ── Overpass: heritage/historic sites (zoom-tiered) ──────────────────────────

async function fetchHeritageInBounds(
  south: number,
  west: number,
  north: number,
  east: number,
  zoom: number,
  signal?: AbortSignal
): Promise<HeritagePlace[]> {
  const bb = `(${south},${west},${north},${east})`;

  let filters: string;
  if (zoom >= 13) {
    // Local: all historic tags
    filters = `
      node["historic"]${bb};
      way["historic"]${bb};
      node["memorial"]${bb};`;
  } else if (zoom >= 10) {
    // Regional: named significant sites only
    filters = `
      node["historic"~"battlefield|monument|memorial|fort|castle|ruins"]${bb};
      way["historic"~"battlefield|monument|memorial|fort|castle|ruins"]${bb};
      node["heritage"]${bb};
      way["heritage"]${bb};`;
  } else {
    // State: nationally significant only
    filters = `
      node["historic"="battlefield"]${bb};
      way["historic"="battlefield"]${bb};
      node["heritage"="1"]${bb};
      way["heritage"="1"]${bb};`;
  }

  const query = `[out:json][timeout:12];\n(\n${filters}\n);\nout center tags;`.trim();

  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: signal ? AbortSignal.any([AbortSignal.timeout(15000), signal]) : AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];

    const data = await res.json();
    const results: HeritagePlace[] = [];
    const seen = new Set<string>();

    for (const el of data.elements ?? []) {
      const name = el.tags?.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (!lat || !lng) continue;
      const type = el.tags?.historic ?? el.tags?.memorial ?? "heritage";
      const wikiRaw: string | undefined = el.tags?.wikipedia;
      const wikipedia = wikiRaw
        ? `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiRaw.replace(/^en:/, "").replace(/ /g, "_"))}`
        : undefined;
      results.push({ lat, lng, name, type, wikipedia });
    }
    return results;
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    return [];
  }
}

// ── Geolocation helper ────────────────────────────────────────────────────────

function getUserLocation(): Promise<[number, number] | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve([pos.coords.latitude, pos.coords.longitude]),
      () => resolve(null),
      { timeout: 6000, maximumAge: 60000 }
    );
  });
}

// ── Cluster icon factory ──────────────────────────────────────────────────────
// Builds the divIcon shown for a marker cluster, themed to match the map
// (gold for the user's graves, purple for shared/community graves).
function makeClusterIcon(L: typeof import("leaflet"), accent: string) {
  return (cluster: import("leaflet").MarkerCluster) => {
    const count = cluster.getChildCount();
    const size = count < 10 ? 34 : count < 100 ? 40 : 46;
    const fontSize = count < 100 ? "0.85rem" : "0.72rem";
    return L.divIcon({
      html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:#1a1917;border:2.5px solid ${accent};display:flex;align-items:center;justify-content:center;color:${accent};font-family:system-ui;font-weight:700;font-size:${fontSize};box-shadow:0 2px 8px rgba(0,0,0,0.5);">${count}</div>`,
      className: "",
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  };
}

// ── Lazy popup photo ──────────────────────────────────────────────────────────
// Instead of embedding (often large base64) photos in every bound popup's HTML,
// inject the <img> only when the popup actually opens, and release it on close.
// The popup HTML must contain a `<div class="gl-popup-photo">` placeholder.
function bindLazyPhoto(marker: import("leaflet").Marker, photoSrc?: string) {
  if (!photoSrc) return;
  marker.on("popupopen", (e: import("leaflet").PopupEvent) => {
    const box = e.popup.getElement()?.querySelector<HTMLElement>(".gl-popup-photo");
    if (box && !box.firstChild) {
      const img = document.createElement("img");
      img.src = photoSrc;
      img.loading = "lazy";
      img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
      box.appendChild(img);
    }
  });
  marker.on("popupclose", (e: import("leaflet").PopupEvent) => {
    const box = e.popup.getElement()?.querySelector<HTMLElement>(".gl-popup-photo");
    if (box) box.innerHTML = "";
  });
}

// ── Heritage icon emoji map ───────────────────────────────────────────────────

const HERITAGE_ICONS: Record<string, string> = {
  battlefield: "⚔️",
  monument: "🗿",
  memorial: "🕊️",
  fort: "🏰",
  castle: "🏰",
  ruins: "🏺",
  heritage: "🏛️",
};

function heritageIcon(type: string): string {
  return HERITAGE_ICONS[type.toLowerCase()] ?? "🏛️";
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ArchiveMap({
  graves,
  allGraves,
  communityGraves = [],
  findRadius,
  findTrigger,
  userLocation,
  onSearchStateChange,
  onSearchNotice,
  onClearFind,
}: {
  graves: GraveRecord[];
  allGraves: GraveRecord[];
  /** Public graves from friends and community members. */
  communityGraves?: CommunityGraveRecord[];
  findRadius: number;
  findTrigger: number;
  userLocation: [number, number] | null;
  onSearchStateChange: (searching: boolean, hasResults: boolean) => void;
  /** Transient, non-blocking notice (e.g. clamped-to-center). null clears it. */
  onSearchNotice?: (message: string | null) => void;
  onClearFind: () => void;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<import("leaflet").Map | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const graveLayerRef = useRef<import("leaflet").MarkerClusterGroup | null>(null);
  const communityLayerRef = useRef<import("leaflet").MarkerClusterGroup | null>(null);
  const overlayLayerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const userMarkerRef = useRef<import("leaflet").Marker | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const [mapReady, setMapReady] = useState(false);

  // Search results state
  const [heritagePlaces, setHeritagePlaces] = useState<HeritagePlace[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [manualFigures, setManualFigures] = useState<NotableFigure[] | null>(null);
  const [manualCemeteries, setManualCemeteries] = useState<CemeteryFeature[] | null>(null);
  const [manualRelatives, setManualRelatives] = useState<GraveRecord[] | null>(null);

  const [locating, setLocating] = useState(false);
  const [currentZoom, setCurrentZoom] = useState(13);

  const [activeFilters, setActiveFilters] = useState<Set<string>>(() => new Set(FILTER_OPTIONS.map(o => o.id)));
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);

  // Group graves by cemetery to find visited locations
  const visitedCemeteries = useMemo(() => {
    const stores = new Map<string, { lat: number; lng: number; name: string; count: number }>();
    allGraves.forEach((g) => {
      const cName = g.location.cemetery || "Unknown Location";
      const key = cName.toLowerCase().trim();
      const existing = stores.get(key);
      if (existing) {
        existing.count++;
      } else {
        stores.set(key, {
          lat: g.location.lat,
          lng: g.location.lng,
          name: cName,
          count: 1,
        });
      }
    });
    return Array.from(stores.values());
  }, [allGraves]);

  const hasManualResults = !!(
    manualFigures?.length || manualCemeteries?.length || manualRelatives?.length || heritagePlaces.length
  );

  useEffect(() => { onSearchStateChange(isSearching, hasManualResults); }, [isSearching, hasManualResults, onSearchStateChange]);

  // ── Map initialisation (runs once) ───────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;
    let cancelled = false;

    (async () => {
      const L = (await import("leaflet")).default ?? await import("leaflet");
      // Side-effect import: augments L with L.markerClusterGroup(). Must run in
      // the browser after Leaflet loads, so it lives here rather than at module top.
      await import("leaflet.markercluster");
      leafletRef.current = L;
      if (cancelled || !mapRef.current) return;

      delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
      L.Icon.Default.mergeOptions({ iconUrl: "", shadowUrl: "" });

      const validGraves = graves.filter((g) => g.location?.lat && g.location?.lng);
      let center: [number, number] = [39.8283, -98.5795];
      let zoom = 5;

      const userPos = userLocation || await getUserLocation();
      if (cancelled) return;

      if (userPos) {
        center = userPos;
        zoom = 14;
      } else if (validGraves.length > 0) {
        center = [validGraves[0].location.lat, validGraves[0].location.lng];
        zoom = 14;
      }

      const map = L.map(mapRef.current!, { center, zoom, zoomControl: false });
      mapInstanceRef.current = map;

      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
        maxZoom: 19,
      }).addTo(map);

      const clusterOptions = {
        maxClusterRadius: 50,
        showCoverageOnHover: false,
        spiderfyOnMaxZoom: true,
        chunkedLoading: true,
      };
      graveLayerRef.current = L.markerClusterGroup({
        ...clusterOptions,
        iconCreateFunction: makeClusterIcon(L, "var(--t-gold-500)"),
      }).addTo(map);
      communityLayerRef.current = L.markerClusterGroup({
        ...clusterOptions,
        iconCreateFunction: makeClusterIcon(L, "#a855f7"),
      }).addTo(map);
      overlayLayerRef.current = L.layerGroup().addTo(map);

      map.on("zoomend", () => {
        setCurrentZoom(map.getZoom());
      });

      setMapReady(true); // ← signals layer effects to run
    })();

    return () => {
      cancelled = true;
      if (mapInstanceRef.current) { mapInstanceRef.current.remove(); mapInstanceRef.current = null; }
      graveLayerRef.current = null;
      communityLayerRef.current = null;
      overlayLayerRef.current = null;
      userMarkerRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync user location marker dot from prop
  useEffect(() => {
    const map = mapInstanceRef.current;
    const L = leafletRef.current;
    if (!map || !L || !mapReady) return;

    if (userLocation) {
      const userIcon = L.divIcon({
        html: `<div style="width:18px;height:18px;border-radius:50%;background:#4a90e2;border:3px solid #fff;box-shadow:0 0 0 4px rgba(74,144,226,0.25),0 2px 8px rgba(0,0,0,0.4);"></div>`,
        className: "",
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      if (userMarkerRef.current) {
        userMarkerRef.current.setLatLng(userLocation);
      } else {
        userMarkerRef.current = L.marker(userLocation, { icon: userIcon, zIndexOffset: 500 }).addTo(map);
      }
    } else {
      if (userMarkerRef.current) {
        userMarkerRef.current.remove();
        userMarkerRef.current = null;
      }
    }
  }, [userLocation, mapReady]);

  // Fix initial centering bug when graves load asynchronously
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !mapReady || graves.length === 0) return;

    const center = map.getCenter();
    if (Math.abs(center.lat - 39.8283) < 0.01 && Math.abs(center.lng - (-98.5795)) < 0.01) {
      const valid = graves.find(g => g.location?.lat && g.location?.lng);
      if (valid) {
        map.setView([valid.location.lat, valid.location.lng], 14);
      }
    }
  }, [graves, mapReady]);

  // ── Graves layer (zoom-dependent) ───────────────────────────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current;
    const layer = graveLayerRef.current;
    const L = leafletRef.current;
    if (!map || !layer || !L || !mapReady) return;

    layer.clearLayers();

    if (currentZoom >= 16) {
      // Zoomed in: Show individual gravestones
      const validGraves = graves.filter((g) => g.location?.lat && g.location?.lng);
      const graveIcon = L.divIcon({
        html: GRAVE_ICON_HTML,
        className: "",
        iconSize: [28, 36],
        iconAnchor: [14, 36],
        popupAnchor: [0, -32],
      });

      validGraves.forEach((grave) => {
        const name = grave.extracted.name || "Unknown";
        const dates = [grave.extracted.birthDate, grave.extracted.deathDate].filter(Boolean).join(" – ");
        
        const appleUrl = `https://maps.apple.com/?q=${encodeURIComponent(name)}&ll=${grave.location.lat},${grave.location.lng}`;
        const googleUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}&center=${grave.location.lat},${grave.location.lng}`;
        const wikiUrl = grave.location?.cemeteryWikipedia || (grave.location?.cemetery ? `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(grave.location.cemetery)}` : undefined);

        const popup = `
          <div style="font-family:system-ui;min-width:180px;padding:10px;text-align:center;">
            <a href="/result/${grave.id}" style="text-decoration:none;display:block;">
              <p style="font-family:Georgia,serif;font-size:1rem;font-weight:600;color:var(--t-stone-50);margin:0 0 2px;">${name}</p>
              ${dates ? `<p style="font-size:0.75rem;color:var(--t-gold-500);margin:0 0 6px;">${dates}</p>` : ""}
              <div class="gl-popup-photo" style="width:100%;height:80px;border-radius:8px;margin-bottom:8px;background:var(--t-stone-800);overflow:hidden;"></div>
              <div style="font-size:0.7rem;font-weight:700;color:var(--t-gold-500);text-transform:uppercase;letter-spacing:0.5px;display:flex;align-items:center;justify-content:center;gap:4px;margin-bottom:8px;">
                View Archive Entry
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
              </div>
            </a>
            <div style="display:flex;gap:6px;margin-top:6px;margin-bottom:6px;">
              <a href="${appleUrl}" target="_blank"
                 style="flex:1;display:flex;align-items:center;justify-content:center;gap:4px;padding:6px 2px;background:var(--t-stone-700);color:var(--t-stone-50);border-radius:8px;font-size:0.7rem;font-weight:600;text-decoration:none;border:1px solid #3a3733;">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#007AFF"/><path d="M12 7l4 10-4-2-4 2 4-10z" fill="white"/></svg>
                Apple
              </a>
              <a href="${googleUrl}" target="_blank"
                 style="flex:1;display:flex;align-items:center;justify-content:center;gap:4px;padding:6px 2px;background:var(--t-stone-700);color:var(--t-stone-50);border-radius:8px;font-size:0.7rem;font-weight:600;text-decoration:none;border:1px solid #3a3733;">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#4285F4"/><circle cx="12" cy="9" r="2.5" fill="#FBBC05"/></svg>
                Google
              </a>
            </div>
            ${wikiUrl ? `<a href="${wikiUrl}" target="_blank" style="display:block;padding:6px;background:var(--t-gold-500);color:#1a1917;text-align:center;border-radius:8px;font-size:0.7rem;font-weight:700;text-decoration:none;">Search Wikipedia →</a>` : ""}
          </div>`;
        const marker = L.marker([grave.location.lat, grave.location.lng], { icon: graveIcon })
          .addTo(layer)
          .bindPopup(popup, { autoPan: false });
        bindLazyPhoto(marker, grave.photoDataUrl);
      });

      if (validGraves.length > 1 && map.getZoom() <= 5) {
        const bounds = L.latLngBounds(validGraves.map((g) => [g.location.lat, g.location.lng] as [number, number]));
        map.fitBounds(bounds, { padding: [40, 40] });
      }
    } else {
      // Zoomed out: Show "Visited Cemetery" markers
      const visitedIcon = L.divIcon({
        html: VISITED_ICON_HTML,
        className: "",
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        popupAnchor: [0, -16],
      });

      visitedCemeteries.forEach((c) => {
        const appleUrl = `https://maps.apple.com/?q=${encodeURIComponent(c.name)}&ll=${c.lat},${c.lng}`;
        const googleUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.name)}&center=${c.lat},${c.lng}`;
        const wikiUrl = `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(c.name)}`;

        const popup = `
          <div style="font-family:system-ui;min-width:180px;padding:10px;text-align:center;">
            <p style="font-family:Georgia,serif;font-size:1rem;font-weight:600;color:var(--t-stone-50);margin:0 0 2px;">${c.name}</p>
            <p style="font-size:0.75rem;color:var(--t-gold-500);margin:0 0 4px;">Visited Location</p>
            <p style="font-size:0.7rem;color:var(--t-stone-500);margin-bottom:8px;">${c.count} archive ${c.count === 1 ? 'record' : 'records'}</p>
            <div style="display:flex;gap:6px;margin-bottom:6px;">
              <a href="${appleUrl}" target="_blank"
                 style="flex:1;display:flex;align-items:center;justify-content:center;gap:4px;padding:6px 2px;background:var(--t-stone-700);color:var(--t-stone-50);border-radius:8px;font-size:0.7rem;font-weight:600;text-decoration:none;border:1px solid #3a3733;">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#007AFF"/><path d="M12 7l4 10-4-2-4 2 4-10z" fill="white"/></svg>
                Apple
              </a>
              <a href="${googleUrl}" target="_blank"
                 style="flex:1;display:flex;align-items:center;justify-content:center;gap:4px;padding:6px 2px;background:var(--t-stone-700);color:var(--t-stone-50);border-radius:8px;font-size:0.7rem;font-weight:600;text-decoration:none;border:1px solid #3a3733;">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#4285F4"/><circle cx="12" cy="9" r="2.5" fill="#FBBC05"/></svg>
                Google
              </a>
            </div>
            <a href="${wikiUrl}" target="_blank" style="display:block;padding:6px;background:var(--t-gold-500);color:#1a1917;text-align:center;border-radius:8px;font-size:0.7rem;font-weight:700;text-decoration:none;">Search Wikipedia →</a>
          </div>`;
        L.marker([c.lat, c.lng], { icon: visitedIcon })
          .addTo(layer)
          .bindPopup(popup, { autoPan: false });
      });
    }
  }, [graves, visitedCemeteries, currentZoom, mapReady]);

  // ── Community graves layer ───────────────────────────────────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current;
    const layer = communityLayerRef.current;
    const L = leafletRef.current;
    if (!map || !layer || !L || !mapReady) return;

    layer.clearLayers();

    if (communityGraves.length === 0 || !SHOW_COMMUNITY_FEATURES) return;

    const friendIcon = L.divIcon({
      html: FRIEND_GRAVE_ICON_HTML,
      className: "",
      iconSize: [28, 36],
      iconAnchor: [14, 36],
      popupAnchor: [0, -32],
    });

    const communityIcon = L.divIcon({
      html: COMMUNITY_GRAVE_ICON_HTML,
      className: "",
      iconSize: [28, 36],
      iconAnchor: [14, 36],
      popupAnchor: [0, -32],
    });

    communityGraves.forEach((g) => {
      const icon = g.tier === "friend" ? friendIcon : communityIcon;
      const dates = [g.birthDate, g.deathDate].filter(Boolean).join(" – ");
      const rankLabel = `Rank ${g.contributorRank}`;
      
      const appleUrl = `https://maps.apple.com/?q=${encodeURIComponent(g.name)}&ll=${g.lat},${g.lng}`;
      const googleUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(g.name)}&center=${g.lat},${g.lng}`;
      const wikiUrl = g.cemetery ? `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(g.cemetery)}` : undefined;

      const popup = `
        <div style="font-family:system-ui;min-width:180px;padding:10px;text-align:center;">
          <p style="font-family:Georgia,serif;font-size:1rem;font-weight:600;color:var(--t-stone-50);margin:0 0 2px;">${g.name}</p>
          ${dates ? `<p style="font-size:0.75rem;color:#a855f7;margin:0 0 4px;">${dates}</p>` : ""}
          ${g.cemetery ? `<p style="font-size:0.7rem;color:var(--t-stone-500);margin:0 0 4px;">${g.cemetery}</p>` : ""}
          <div class="gl-popup-photo" style="width:100%;height:80px;border-radius:8px;margin-bottom:8px;background:var(--t-stone-800);overflow:hidden;"></div>
          <p style="font-size:0.7rem;color:var(--t-stone-500);margin:0 0 8px;">${g.contributorLabel} · ${rankLabel}</p>
          ${g.communityNote ? `<p style="font-size:0.7rem;color:#d0cbc5;margin:0 0 8px;font-style:italic;">"${g.communityNote}"</p>` : ""}
          <div style="display:flex;gap:6px;margin-bottom:6px;">
            <a href="${appleUrl}" target="_blank"
               style="flex:1;display:flex;align-items:center;justify-content:center;gap:4px;padding:6px 2px;background:var(--t-stone-700);color:var(--t-stone-50);border-radius:8px;font-size:0.7rem;font-weight:600;text-decoration:none;border:1px solid #3a3733;">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#007AFF"/><path d="M12 7l4 10-4-2-4 2 4-10z" fill="white"/></svg>
              Apple
            </a>
            <a href="${googleUrl}" target="_blank"
               style="flex:1;display:flex;align-items:center;justify-content:center;gap:4px;padding:6px 2px;background:var(--t-stone-700);color:var(--t-stone-50);border-radius:8px;font-size:0.7rem;font-weight:600;text-decoration:none;border:1px solid #3a3733;">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#4285F4"/><circle cx="12" cy="9" r="2.5" fill="#FBBC05"/></svg>
              Google
            </a>
          </div>
          ${wikiUrl ? `<a href="${wikiUrl}" target="_blank" style="display:block;padding:6px;background:var(--t-gold-500);color:#1a1917;text-align:center;border-radius:8px;font-size:0.7rem;font-weight:700;text-decoration:none;">Search Wikipedia →</a>` : ""}
        </div>`;
      const marker = L.marker([g.lat, g.lng], { icon })
        .addTo(layer)
        .bindPopup(popup, { autoPan: false });
      bindLazyPhoto(marker, g.photoUrl);
    });
  }, [communityGraves, mapReady]);

  // ── Overlay layer: auto + manual results ──────────────────────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current;
    const layer = overlayLayerRef.current;
    const L = leafletRef.current;
    if (!map || !layer || !L) return;

    layer.clearLayers();

    const figureIconMap: Record<string, string> = {
      political: "🏛️", military: "⚔️", artist: "🎨",
      musician: "🎵", actor: "🎭", other: "📍",
    };

    const makeCircleIcon = (emoji: string, bg = "#1a1917", border = "var(--t-stone-700)") =>
      L.divIcon({
        html: `<div style="width:32px;height:32px;background:${bg};border-radius:50%;border:2px solid ${border};display:flex;align-items:center;justify-content:center;font-size:1.1rem;box-shadow:0 2px 8px rgba(0,0,0,0.4);">${emoji}</div>`,
        className: "", iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -16],
      });

    // ── Heritage places (from Search Here) ────────────────────────────────
    if (activeFilters.has("heritage")) {
      heritagePlaces.forEach((h: HeritagePlace) => {
        const icon = makeCircleIcon(heritageIcon(h.type), "var(--t-stone-700)", "#3a3733");
        const html = `<div style="font-family:system-ui;min-width:160px;padding:10px;text-align:center;">
          <p style="font-family:Georgia,serif;font-size:1rem;font-weight:600;color:var(--t-stone-50);margin:0;">${h.name}</p>
          <p style="font-size:0.75rem;color:var(--t-gold-500);margin-top:2px;text-transform:capitalize;">${h.type}</p>
          ${h.wikipedia ? `<a href="${h.wikipedia}" target="_blank" style="display:block;margin-top:10px;padding:8px;background:var(--t-gold-500);color:#1a1917;text-align:center;border-radius:10px;font-weight:bold;text-decoration:none;font-size:0.875rem;">Learn more →</a>` : ""}
        </div>`;
        L.marker([h.lat, h.lng], { icon }).addTo(layer).bindPopup(html, { autoPan: false });
      });
    }

    // ── Search results ─────────────────────────────────────────────────────
    if (manualFigures) {
      manualFigures.forEach((n: NotableFigure) => {
        if (!activeFilters.has(n.category)) return;
        const icon = makeCircleIcon(figureIconMap[n.category] ?? "📍");
        const html = `<div style="font-family:system-ui;min-width:180px;padding:10px;text-align:center;">
          <p style="font-family:Georgia,serif;font-size:1rem;font-weight:600;color:var(--t-stone-50);margin:0;">${n.label}</p>
          <p style="font-size:0.75rem;color:var(--t-gold-500);margin-top:2px;">${n.occupationLabel || n.category}</p>
          ${n.wikipediaUrl ? `<a href="${n.wikipediaUrl}" target="_blank" style="display:block;margin-top:10px;padding:8px;background:var(--t-gold-500);color:#1a1917;text-align:center;border-radius:10px;font-weight:bold;text-decoration:none;">Learn more →</a>` : ""}
        </div>`;
        L.marker([n.lat, n.lng], { icon }).addTo(layer).bindPopup(html, { autoPan: false });
      });
    }

    if (manualCemeteries && activeFilters.has("cemeteries")) {
      manualCemeteries.forEach((c) => {
        const isVisited = visitedCemeteries.some(vc => vc.name.toLowerCase().trim() === c.name.toLowerCase().trim());

        const icon = L.divIcon({
          html: isVisited ? VISITED_ICON_HTML : `<div style="width:34px;height:34px;background:linear-gradient(135deg,#4a4845,#2e2c2a);border-radius:6px;border:2px solid #1a1917;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,0.5);">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 21h12"/><path d="M7 21v-8a5 5 0 0 1 10 0v8"/><path d="M12 7v4"/><path d="M10 9h4"/>
            </svg>
          </div>`,
          className: "",
          iconSize: isVisited ? [32, 32] : [34, 34],
          iconAnchor: isVisited ? [16, 16] : [17, 34],
          popupAnchor: isVisited ? [0, -16] : [0, -38],
        });

        const hoursLine = c.openingHours
          ? `<div style="display:flex;align-items:flex-start;justify-content:center;gap:6px;margin-top:6px;">
               <span style="font-size:0.875rem;flex-shrink:0;">🕐</span>
               <span style="font-size:0.75rem;color:#a09585;line-height:1.4;text-align:left;">${formatOpeningHours(c.openingHours)}</span>
             </div>`
          : "";

        const phoneLine = c.phone
          ? `<div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:4px;">
               <span style="font-size:0.875rem;">📞</span>
               <a href="tel:${c.phone}" style="font-size:0.75rem;color:var(--t-gold-500);text-decoration:none;">${c.phone}</a>
             </div>`
          : "";

        const appleUrl = `https://maps.apple.com/?q=${encodeURIComponent(c.name)}&ll=${c.lat},${c.lng}`;
        const googleUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.name)}&center=${c.lat},${c.lng}`;

        const popup = `
          <div style="font-family:system-ui;min-width:220px;max-width:260px;padding:12px;text-align:center;">
            <p style="font-family:Georgia,serif;font-size:1rem;font-weight:600;color:var(--t-stone-50);margin:0 0 2px;">${c.name}</p>
            <p style="font-size:0.7rem;color:#6a6560;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 8px;">Cemetery</p>
            ${hoursLine}
            ${phoneLine}
            <div style="display:flex;gap:6px;margin-top:10px;">
              <a href="${appleUrl}" target="_blank"
                 style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:8px 4px;background:var(--t-stone-700);color:var(--t-stone-50);border-radius:10px;font-size:0.75rem;font-weight:600;text-decoration:none;border:1px solid #3a3733;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#007AFF"/><path d="M12 7l4 10-4-2-4 2 4-10z" fill="white"/></svg>
                Apple
              </a>
              <a href="${googleUrl}" target="_blank"
                 style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:8px 4px;background:var(--t-stone-700);color:var(--t-stone-50);border-radius:10px;font-size:0.75rem;font-weight:600;text-decoration:none;border:1px solid #3a3733;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#4285F4"/><circle cx="12" cy="9" r="2.5" fill="#FBBC05"/></svg>
                Google
              </a>
            </div>
            ${c.wikipedia ? `<a href="${c.wikipedia}" target="_blank" style="display:block;margin-top:6px;padding:6px;background:var(--t-gold-500);color:#1a1917;text-align:center;border-radius:10px;font-size:0.75rem;font-weight:700;text-decoration:none;">Learn more →</a>` : ""}
          </div>`;
        L.marker([c.lat, c.lng], { icon }).addTo(layer).bindPopup(popup, { maxWidth: 280, autoPan: false });
      });
    }


    if (manualRelatives && activeFilters.has("relatives")) {
      manualRelatives.forEach((g) => {
        const icon = makeCircleIcon("👤", "linear-gradient(135deg,#7c5cbf,#5b3fa0)", "#1a1917");
        const name = g.extracted.name || "Unknown";
        const cemetery = g.location?.cemetery || "";
        const html = `<div style="font-family:system-ui;min-width:160px;padding:10px;text-align:center;">
          <p style="font-family:Georgia,serif;font-size:1rem;font-weight:600;color:var(--t-stone-50);margin:0 0 4px;">${name}</p>
          ${cemetery ? `<p style="font-size:0.75rem;color:var(--t-gold-500);margin:0;">${cemetery}</p>` : ""}
          <div class="gl-popup-photo" style="width:100%;height:72px;border-radius:10px;margin-top:6px;background:var(--t-stone-800);overflow:hidden;"></div>
        </div>`;
        const marker = L.marker([g.location.lat, g.location.lng], { icon }).addTo(layer).bindPopup(html, { autoPan: false });
        bindLazyPhoto(marker, g.photoDataUrl);
      });
    }
  }, [heritagePlaces, manualFigures, manualCemeteries, manualRelatives, mapReady, activeFilters, visitedCemeteries]);

  // ── Manual search trigger ─────────────────────────────────────────────────────
  useEffect(() => {
    if (findTrigger > 0) handleFind();
    if (findTrigger === -1) clearFind();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findTrigger]);

  const handleFind = async () => {
    const map = mapInstanceRef.current;
    if (!map) return;

    // Cancel any in-flight search so a slower prior request can't clobber this one.
    searchAbortRef.current?.abort();
    const ac = new AbortController();
    searchAbortRef.current = ac;

    setIsSearching(true);
    try {
      const center = map.getCenter();
      const lat = center.lat; const lng = center.lng;
      const latDelta = findRadius / 69;
      const lngDelta = findRadius / (69 * Math.cos((lat * Math.PI) / 180));
      const s = lat - latDelta; const n = lat + latDelta;
      const w = lng - lngDelta; const e = lng + lngDelta;
      const zoom = map.getZoom();

      const promises: Promise<void>[] = [];

      promises.push(
        fetchCemeteriesInBounds(s, w, n, e, ac.signal)
          .then(setManualCemeteries)
          .catch((err: unknown) => { if ((err as Error)?.name === "AbortError") throw err; setManualCemeteries(null); })
      );

      promises.push(
        getNotableFiguresInBounds(s, w, n, e, wikidataMinSitelinks(zoom), ac.signal)
          .then(setManualFigures)
          .catch((err: unknown) => { if ((err as Error)?.name === "AbortError") throw err; setManualFigures(null); })
      );

      if (zoom >= 8) {
        promises.push(
          fetchHeritageInBounds(s, w, n, e, zoom, ac.signal)
            .then(setHeritagePlaces)
            .catch((err: unknown) => { if ((err as Error)?.name === "AbortError") throw err; setHeritagePlaces([]); })
        );
      } else {
        setHeritagePlaces([]);
      }

      setManualRelatives(
        allGraves.filter(
          (g) =>
            g.location?.lat &&
            g.location.lat >= s && g.location.lat <= n &&
            g.location.lng >= w && g.location.lng <= e &&
            (g.tags || []).some((t) => RELATIVE_TAGS.includes(t.toLowerCase()))
        )
      );

      await Promise.all(promises);
      map.fitBounds([[s, w], [n, e]], { padding: [20, 20] });
    } catch (err) {
      // Aborted by a newer search — let that one own the UI state.
      if ((err as Error)?.name === "AbortError") return;
    } finally {
      if (searchAbortRef.current === ac) { searchAbortRef.current = null; setIsSearching(false); }
    }
  };

  const clearFind = () => {
    setManualFigures(null);
    setManualCemeteries(null);
    setManualRelatives(null);
    setHeritagePlaces([]);
    onClearFind();
  };

  const handleSearchHere = async () => {
    const map = mapInstanceRef.current;
    if (!map) return;
    
    const b = map.getBounds();
    const sw = b.getSouthWest();
    const ne = b.getNorthEast();

    // If the viewport is larger than Overpass can handle in one query, clamp to a
    // safe-sized box centered on the map rather than rejecting the search.
    const center = map.getCenter();
    const latSpan = Math.abs(ne.lat - sw.lat);
    const lngSpan = Math.abs(ne.lng - sw.lng);
    const clamped = latSpan > MAX_SEARCH_LAT_DEG || lngSpan > MAX_SEARCH_LNG_DEG;
    let s = sw.lat, w = sw.lng, n = ne.lat, e = ne.lng;
    if (clamped) {
      const halfLat = Math.min(latSpan, MAX_SEARCH_LAT_DEG) / 2;
      const halfLng = Math.min(lngSpan, MAX_SEARCH_LNG_DEG) / 2;
      s = center.lat - halfLat; n = center.lat + halfLat;
      w = center.lng - halfLng; e = center.lng + halfLng;
    }

    // Cancel any in-flight search so a slower prior request can't clobber this one.
    searchAbortRef.current?.abort();
    const ac = new AbortController();
    searchAbortRef.current = ac;

    setIsSearching(true);

    // Clear old state so legend and map accurately reflect a fresh search
    setManualFigures(null);
    setManualCemeteries(null);
    setHeritagePlaces([]);
    setManualRelatives(null);

    try {
      const z = map.getZoom();

      // Track per-query outcome so the post-search notice can distinguish a
      // genuine empty area from a service failure (timeout / 429 / network),
      // which otherwise look identical to the user. A non-abort rejection from
      // any query flips `anyError`; AbortError still propagates so a superseded
      // search can't clobber the newer one's UI state.
      let anyError = false;
      let cemeteriesCapped = false;
      // Result counts captured locally (state setters are async and can't be
      // read back synchronously to decide the post-search message).
      let cemCount = 0, figCount = 0, heritageCount = 0;
      const tasks: Promise<void>[] = [];

      tasks.push(
        fetchCemeteriesInBounds(s, w, n, e, ac.signal)
          .then((r) => { cemCount = r.length; cemeteriesCapped = r.length >= 200; setManualCemeteries(r); })
          .catch((err: unknown) => { if ((err as Error)?.name === "AbortError") throw err; anyError = true; setManualCemeteries(null); })
      );

      tasks.push(
        getNotableFiguresInBounds(s, w, n, e, wikidataMinSitelinks(z), ac.signal)
          .then((r) => { figCount = r.length; setManualFigures(r); })
          .catch((err: unknown) => { if ((err as Error)?.name === "AbortError") throw err; anyError = true; setManualFigures(null); })
      );

      if (z >= 8) {
        tasks.push(
          fetchHeritageInBounds(s, w, n, e, z, ac.signal)
            .then((r) => { heritageCount = r.length; setHeritagePlaces(r); })
            .catch((err: unknown) => { if ((err as Error)?.name === "AbortError") throw err; anyError = true; setHeritagePlaces([]); })
        );
      } else {
        setHeritagePlaces([]);
      }

      const relatives = allGraves.filter(
        (g) =>
          g.location?.lat &&
          g.location.lat >= s && g.location.lat <= n &&
          g.location.lng >= w && g.location.lng <= e &&
          (g.tags || []).some((t) => RELATIVE_TAGS.includes(t.toLowerCase()))
      );
      setManualRelatives(relatives);

      await Promise.all(tasks);

      // Single prioritized post-search notice. This is the only place that drives
      // the search toast, so failure / cap / clamp / empty messages don't clobber
      // each other in the shared single-slot toast (see MapPage).
      const hasResults = !!(figCount || cemCount || relatives.length || heritageCount);
      if (anyError) {
        onSearchNotice?.(hasResults
          ? "Search service is busy — some results may be missing. Try again."
          : "Search service is busy — try again.");
      } else if (cemeteriesCapped) {
        onSearchNotice?.("Showing the first 200 cemeteries; zoom in for complete results.");
      } else if (clamped) {
        onSearchNotice?.("Showing results near the center of the view.");
      } else if (!hasResults) {
        onSearchNotice?.("No results found in this area — try zooming out or moving the map.");
      } else {
        onSearchNotice?.(null);
      }
    } catch (err) {
      // Aborted by a newer search — let that one own the UI state.
      if ((err as Error)?.name === "AbortError") return;
    } finally {
      if (searchAbortRef.current === ac) { searchAbortRef.current = null; setIsSearching(false); }
    }
  };

  const handleMyLocation = async () => {
    const map = mapInstanceRef.current;
    if (!map || locating) return;
    setLocating(true);
    try {
      const pos = await getUserLocation();
      if (pos) {
        map.setView(pos, 15, { animate: true });
        if (userMarkerRef.current) userMarkerRef.current.setLatLng(pos);
      }
    } finally {
      setLocating(false);
    }
  };

  // ── Legend entries — derived from active state ────────────────────────────
  const legendItems = useMemo(() => {
    const items: { icon: React.ReactNode; label: string }[] = [];

    const activeFigures = manualFigures ?? [];
    const activeHeritage = heritagePlaces;

    const validGraves = graves.filter((g) => g.location?.lat && g.location?.lng);
    if (validGraves.length > 0) {
      items.push({
        icon: (
          <svg width="14" height="18" viewBox="0 0 28 36" fill="none">
            <rect x="2" y="14" width="24" height="18" rx="2" fill="var(--t-gold-500)"/>
            <path d="M2 16 Q2 2 14 2 Q26 2 26 16" fill="var(--t-gold-500)"/>
            <line x1="14" y1="6" x2="14" y2="12" stroke="#1a1917" strokeWidth="2" strokeLinecap="round"/>
            <line x1="10" y1="9" x2="18" y2="9" stroke="#1a1917" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        ),
        label: "Visited graves",
      });
    }

    if (communityGraves.length > 0 && SHOW_COMMUNITY_FEATURES) {
      items.push({
        icon: (
          <svg width="14" height="18" viewBox="0 0 28 36" fill="none">
            <rect x="2" y="14" width="24" height="18" rx="2" fill="#a855f7"/>
            <path d="M2 16 Q2 2 14 2 Q26 2 26 16" fill="#a855f7"/>
            <line x1="14" y1="6" x2="14" y2="12" stroke="#1a1917" strokeWidth="2" strokeLinecap="round"/>
            <line x1="10" y1="9" x2="18" y2="9" stroke="#1a1917" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        ),
        label: "Shared markers",
      });
    }

    if (userMarkerRef.current) {
      items.push({
        icon: <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#4a90e2", border: "2px solid #fff", boxShadow: "0 0 0 3px rgba(74,144,226,0.3)" }} />,
        label: "Your location",
      });
    }

    if (visitedCemeteries.length > 0) {
      items.push({
        icon: (
          <svg width="14" height="14" viewBox="0 0 32 32" fill="none">
            <circle cx="16" cy="16" r="14" fill="#1a1917" stroke="var(--t-gold-500)" strokeWidth="2.5"/>
            <path d="M10 16.5L14 20.5L23 11.5" stroke="var(--t-gold-500)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        ),
        label: "Visited location",
      });
    }

    // Figure categories present
    const figCategories = new Set<string>(activeFigures.map((f) => f.category));
    const figCategoryMap: Record<string, string> = {
      political: "🏛️  Political figures",
      military:  "⚔️  Military figures",
      artist:    "🎨  Artists",
      musician:  "🎵  Musicians",
      actor:     "🎭  Actors",
      other:     "📍  Notable buried figures",
    };
    for (const cat of ["political", "military", "artist", "musician", "actor", "other"]) {
      if (figCategories.has(cat)) {
        items.push({ icon: <span style={{ fontSize: 14 }}>{figCategoryMap[cat].split("  ")[0]}</span>, label: figCategoryMap[cat].split("  ")[1] });
      }
    }

    // Heritage types present
    const heritageTypes = new Set(activeHeritage.map((h) => h.type.toLowerCase()));
    const heritageLabels: Record<string, string> = {
      battlefield: "⚔️  Battlefield",
      monument:    "🗿  Monument",
      memorial:    "🕊️  Memorial",
      fort:        "🏰  Fort / Castle",
      castle:      "🏰  Fort / Castle",
      ruins:       "🏺  Ruins",
      heritage:    "🏛️  Heritage site",
    };
    const shownHeritage = new Set<string>();
    for (const type of heritageTypes) {
      const label = heritageLabels[type];
      if (label && !shownHeritage.has(label)) {
        shownHeritage.add(label);
        items.push({ icon: <span style={{ fontSize: 14 }}>{label.split("  ")[0]}</span>, label: label.split("  ")[1] });
      }
    }

    if (manualCemeteries && manualCemeteries.length > 0 && activeFilters.has("cemeteries")) {
      items.push({
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 21h12"/><path d="M7 21v-8a5 5 0 0 1 10 0v8"/><path d="M12 7v4"/><path d="M10 9h4"/>
          </svg>
        ),
        label: "Cemeteries",
      });
    }

    if (manualRelatives && manualRelatives.length > 0 && activeFilters.has("relatives")) {
      items.push({ icon: <span style={{ fontSize: 13 }}>👤</span>, label: "Tagged relatives" });
    }

    return items;
  }, [graves, communityGraves, heritagePlaces, manualFigures, manualCemeteries, manualRelatives, activeFilters, visitedCemeteries]);

  return (
    <div className="relative flex-1 flex flex-col overflow-hidden h-screen">
      <div ref={mapRef} className="w-full h-full relative z-0" />

      {/* Legend — floats above bottom nav */}
      {legendItems.length > 0 && (
        <div
          className="absolute left-4 z-[1000] rounded-xl px-3 py-2 flex flex-col gap-1.5"
          style={{
            bottom: "calc(6.5rem + env(safe-area-inset-bottom, 0px))",
            background: "rgba(var(--glass-bg-rgb), 0.88)",
            border: "1px solid var(--t-stone-700)",
            backdropFilter: "blur(8px)",
          }}
        >
          {legendItems.map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="w-5 flex items-center justify-center shrink-0">{item.icon}</div>
              <span className="text-stone-300 text-[0.8rem] font-medium">{item.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Filter Button */}
      <div className="absolute top-4 right-4 z-[1000]">
        <button
          onClick={() => setFilterMenuOpen(o => !o)}
          className="w-11 h-11 rounded-full flex items-center justify-center shadow-xl transition-all active:scale-95 bg-[var(--t-stone-900)] border-2 border-[var(--t-stone-700)]"
          aria-label="Map Filters"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={filterMenuOpen ? "var(--t-gold-500)" : "var(--t-stone-500)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
          </svg>
        </button>

        {filterMenuOpen && (
          <div className="absolute top-14 right-0 w-56 rounded-2xl shadow-2xl overflow-hidden p-3 flex flex-col gap-2"
               style={{ background: "rgba(var(--glass-bg-rgb), 0.95)", border: "1px solid var(--t-stone-700)", backdropFilter: "blur(12px)" }}>
            <div className="flex items-center justify-between px-2 pb-2 border-b border-stone-800">
              <span className="text-stone-200 font-serif font-semibold text-sm">Map Filters</span>
              <button
                onClick={() => setActiveFilters(new Set(FILTER_OPTIONS.map(o => o.id)))}
                className="text-[var(--t-gold-500)] text-[0.75rem] uppercase tracking-wider font-bold hover:text-[var(--t-gold-400)]"
              >
                Reset All
              </button>
            </div>
            <div className="flex flex-col gap-1 max-h-[380px] overflow-y-auto pr-1">
              {FILTER_OPTIONS.map(opt => {
                const checked = activeFilters.has(opt.id);
                return (
                  <label key={opt.id} className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-stone-800 cursor-pointer transition-colors">
                    <input 
                      type="checkbox" 
                      className="hidden" 
                      checked={checked}
                      onChange={() => {
                        setActiveFilters(prev => {
                           const next = new Set(prev);
                           if (next.has(opt.id)) next.delete(opt.id);
                           else next.add(opt.id);
                           return next;
                        });
                      }}
                    />
                    <div className={`w-4 h-4 rounded shadow-inner flex items-center justify-center transition-colors ${checked ? 'bg-[var(--t-gold-500)]' : 'bg-[var(--t-stone-900)] border border-[#3a3733]'}`}>
                      {checked && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#1a1917" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
                    </div>
                    <span className="text-stone-300 text-xs font-medium">{opt.label}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* My Location button — floats above bottom nav */}
      <button
        onClick={handleMyLocation}
        disabled={locating}
        aria-label="My location"
        className="absolute right-4 z-[1000] w-11 h-11 rounded-full flex items-center justify-center shadow-xl transition-all active:scale-95 disabled:opacity-60"
        style={{
          bottom: "calc(6.5rem + env(safe-area-inset-bottom, 0px))",
          background: "var(--t-stone-900)",
          border: "2px solid var(--t-stone-700)",
        }}
      >
        {locating ? (
          <div className="w-4 h-4 border-2 border-stone-500 border-t-transparent rounded-full animate-spin" />
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            <circle cx="12" cy="12" r="9" strokeOpacity="0.3" />
          </svg>
        )}
      </button>

      {/* Search Here button */}
      {!isSearching && (
        <div className="absolute inset-x-0 top-4 z-[1000] flex justify-center pointer-events-none">
          <button
            onClick={handleSearchHere}
            className="pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold shadow-xl active:scale-95 transition-all"
            style={{ background: "var(--t-stone-900)", border: "1px solid #3a3733", color: "var(--t-stone-50)" }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
            Search here
          </button>
        </div>
      )}

      {/* Searching indicator */}
      {isSearching && (
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 z-[1002] flex justify-center pointer-events-none">
          <div className="bg-stone-900/95 border border-stone-800 px-6 py-4 rounded-3xl shadow-2xl flex items-center gap-4 backdrop-blur-xl">
            <div className="w-5 h-5 border-2 border-stone-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-stone-100 font-serif text-sm">Scanning radius…</p>
          </div>
        </div>
      )}
    </div>
  );
}
