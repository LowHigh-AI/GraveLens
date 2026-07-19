"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import PageShell from "@/components/layout/PageShell";
import { getAllGraves, getGrave, deleteGrave, saveGrave, getAllCemeteries, deleteCemetery, saveCemetery, getQueuedItems } from "@/lib/storage";
import { createClient } from "@/lib/supabase/browser";
import { fetchAllFromCloud, deleteFromCloud, upsertGrave } from "@/lib/cloudSync";
import type { GraveRecord, CemeteryRecord, QueuedCapture, ExtractedGraveData } from "@/types";
import { QUEUE_CHANGED_EVENT } from "@/lib/queue";
import Link from "next/link";
import { generateThumbnail } from "@/lib/imageUtils";
import ThematicIllustration from "@/components/ui/ThematicIllustration";
import { reverseGeocode } from "@/lib/apis/nominatim";
import { formatOpeningHours, cemeteryId } from "@/lib/apis/cemetery";
import { shouldReview, TYPICAL_NAME_RE } from "@/lib/reviewUtils";
import GraveEditSheet, { type GraveEditPatch } from "@/components/archive/GraveEditSheet";
import { buildAllResearchLinks } from "@/lib/researchLinks";
import { CURRENT_RESEARCH_VERSION } from "@/lib/researchVersion";
import { expandGivenName } from "@/lib/research/personQuery";
import { getSoundex } from "@/lib/phonetic";

type SortField = "birthYear" | "deathYear" | "name" | "lastName" | "ageAtDeath" | "cemetery" | "dateAdded";
type SortDir = "asc" | "desc";
type ConfidenceFilter = "" | "high" | "medium" | "low" | "needs_review";
type ViewMode = "list" | "compact" | "tile" | "cover";
const PAGE_SIZE = 30;
type ArchiveTab = "markers" | "places" | "review";
type GroupingMode = "flat" | "cemetery" | "family";

interface CemeteryGroup {
  cemeteryName: string;
  locationDesc: string;
  graves: GraveRecord[];
}

interface FamilyGroup {
  surname: string;
  graves: GraveRecord[];
}

interface CemeteryFamilyGroup {
  cemeteryName: string;
  locationDesc: string;
  families: FamilyGroup[];
}

const PLACE_MARKER_TYPES = new Set(["cemetery", "graveyard", "mausoleum"]);

function matchesNameQuery(recordName: string, queryWords: string[]): boolean {
  if (!recordName) return false;
  const recordWords = recordName.trim().split(/\s+/).filter(Boolean);
  if (recordWords.length === 0) return false;

  return queryWords.every((qw) => {
    const qwLower = qw.toLowerCase();
    const qwSoundex = getSoundex(qw);

    return recordWords.some((rw) => {
      const rwLower = rw.toLowerCase();
      if (rwLower.includes(qwLower) || qwLower.includes(rwLower)) return true;

      const rwExpansions = expandGivenName(rwLower).map((x) => x.toLowerCase());
      const qwExpansions = expandGivenName(qwLower).map((x) => x.toLowerCase());

      if (rwExpansions.includes(qwLower) || qwExpansions.includes(rwLower)) return true;
      if (rwExpansions.some((e) => qwExpansions.includes(e))) return true;

      if (rwLower.length >= 3 && qwLower.length >= 3 && qwSoundex && qwSoundex === getSoundex(rwLower)) {
        return true;
      }

      return false;
    });
  });
}

function formatDates(extracted: ExtractedGraveData): string {
  const dates = [extracted.birthDate, extracted.deathDate].filter(Boolean).join(" — ");
  if (dates) return dates;
  if (extracted.birthYear != null || extracted.deathYear != null) {
    return [extracted.birthYear ?? "?", extracted.deathYear ?? "?"].join(" — ");
  }
  return "Dates unknown";
}

// ── Viewed-item tracking (dismisses "Recently Added" badge) ───────────────
const VIEWED_KEY = "gl_viewed_ids";
const RECENT_DAYS = 5 * 24 * 60 * 60 * 1000;

function loadViewedIds(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(VIEWED_KEY) ?? "[]")); }
  catch { return new Set(); }
}
function persistViewed(id: string): void {
  try {
    const ids = loadViewedIds();
    ids.add(id);
    localStorage.setItem(VIEWED_KEY, JSON.stringify([...ids]));
  } catch { /* ignore */ }
}

// ── Learned cemetery storage ───────────────────────────────────────────────
const LEARNED_KEY = "gl_learned_cemeteries";
const PROXIMITY_METERS = 750;

interface LearnedCemetery { name: string; lat: number; lng: number }

function loadLearned(): LearnedCemetery[] {
  try { return JSON.parse(localStorage.getItem(LEARNED_KEY) ?? "[]"); }
  catch { return []; }
}
function saveLearned(entries: LearnedCemetery[]): void {
  try { localStorage.setItem(LEARNED_KEY, JSON.stringify(entries)); } catch { /* ignore */ }
}
function learnCemetery(name: string, lat: number, lng: number): void {
  const entries = loadLearned();
  if (!entries.some((e) => distanceMeters(lat, lng, e.lat, e.lng) < PROXIMITY_METERS)) {
    saveLearned([...entries, { name, lat, lng }]);
  }
}
function findLearnedCemetery(lat: number, lng: number): string | undefined {
  return loadLearned().find((e) => distanceMeters(lat, lng, e.lat, e.lng) < PROXIMITY_METERS)?.name;
}

// ── Cemetery completion goals ──────────────────────────────────────────────
const GOALS_KEY = "gl_cemetery_goals";
function loadGoals(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(GOALS_KEY) ?? "{}"); }
  catch { return {}; }
}
function saveGoal(cemeteryId: string, total: number): void {
  try {
    const goals = loadGoals();
    goals[cemeteryId] = total;
    localStorage.setItem(GOALS_KEY, JSON.stringify(goals));
  } catch { /* ignore */ }
}
function removeGoal(cemeteryId: string): void {
  try {
    const goals = loadGoals();
    delete goals[cemeteryId];
    localStorage.setItem(GOALS_KEY, JSON.stringify(goals));
  } catch { /* ignore */ }
}

function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// ── Component ──────────────────────────────────────────────────────────────
export default function ArchivePage() {
  const [graves, setGraves] = useState<GraveRecord[]>([]);
  const [cemeteries, setCemeteries] = useState<CemeteryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [enriching, setEnriching] = useState(false);
  const [bulkEnriching, setBulkEnriching] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [archiveTab, setArchiveTab] = useState<ArchiveTab>(() => {
    if (typeof window === "undefined") return "markers";
    try {
      const stored = sessionStorage.getItem("gl_archive_filters");
      if (stored) return (JSON.parse(stored).archiveTab as ArchiveTab) ?? "markers";
    } catch {}
    return "markers";
  });

  // ── Assignment flow state ─────────────────────────────────────────────
  // Queue of grave IDs that still need a cemetery name after auto-enrichment
  const [assignmentQueue, setAssignmentQueue] = useState<string[]>([]);
  const [activeAssignmentId, setActiveAssignmentId] = useState<string | null>(null);
  const [assignmentInput, setAssignmentInput] = useState("");
  // Proximity confirmation: after assigning one grave, nearby unassigned ones
  const [nearbyConfirm, setNearbyConfirm] = useState<{
    name: string;
    graves: GraveRecord[];
  } | null>(null);
  // Full-record edit sheet opened from an archive row (F6)
  const [editSheetGrave, setEditSheetGrave] = useState<GraveRecord | null>(null);
  const [mergeModalOpen, setMergeModalOpen] = useState(false);

  const [failedQueueItems, setFailedQueueItems] = useState<QueuedCapture[]>([]);

  // Filter / sort state with session persistence
  const FILTER_STORAGE_KEY = "gl_archive_filters";

  const [sortField, setSortField] = useState<SortField>(() => {
    if (typeof window === "undefined") return "deathYear";
    try {
      const stored = sessionStorage.getItem(FILTER_STORAGE_KEY);
      if (stored) return (JSON.parse(stored).sortField as SortField) ?? "deathYear";
    } catch {}
    return "deathYear";
  });

  const [sortDir, setSortDir] = useState<SortDir>(() => {
    if (typeof window === "undefined") return "asc";
    try {
      const stored = sessionStorage.getItem(FILTER_STORAGE_KEY);
      if (stored) return (JSON.parse(stored).sortDir as SortDir) ?? "asc";
    } catch {}
    return "asc";
  });

  const [filterState, setFilterState] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      const stored = sessionStorage.getItem(FILTER_STORAGE_KEY);
      if (stored) return JSON.parse(stored).filterState ?? "";
    } catch {}
    return "";
  });

  const [filterCity, setFilterCity] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      const stored = sessionStorage.getItem(FILTER_STORAGE_KEY);
      if (stored) return JSON.parse(stored).filterCity ?? "";
    } catch {}
    return "";
  });

  const [filterCemetery, setFilterCemetery] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      const stored = sessionStorage.getItem(FILTER_STORAGE_KEY);
      if (stored) return JSON.parse(stored).filterCemetery ?? "";
    } catch {}
    return "";
  });

  const [filterTag, setFilterTag] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      const stored = sessionStorage.getItem(FILTER_STORAGE_KEY);
      if (stored) return JSON.parse(stored).filterTag ?? "";
    } catch {}
    return "";
  });

  const [filterConfidence, setFilterConfidence] = useState<ConfidenceFilter>(() => {
    if (typeof window === "undefined") return "";
    try {
      const stored = sessionStorage.getItem(FILTER_STORAGE_KEY);
      if (stored) return (JSON.parse(stored).filterConfidence as ConfidenceFilter) ?? "";
    } catch {}
    return "";
  });

  const [filtersOpen, setFiltersOpen] = useState(false);

  const [searchQuery, setSearchQuery] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      const stored = sessionStorage.getItem(FILTER_STORAGE_KEY);
      if (stored) return JSON.parse(stored).searchQuery ?? "";
    } catch {}
    return "";
  });

  const [searchOpen, setSearchOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      const stored = sessionStorage.getItem(FILTER_STORAGE_KEY);
      if (stored) return !!JSON.parse(stored).searchQuery;
    } catch {}
    return false;
  });

  // Sync filters to sessionStorage on any change
  useEffect(() => {
    const data = {
      sortField,
      sortDir,
      filterState,
      filterCity,
      filterCemetery,
      filterTag,
      filterConfidence,
      searchQuery,
      archiveTab,
    };
    try {
      sessionStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(data));
    } catch {}
  }, [sortField, sortDir, filterState, filterCity, filterCemetery, filterTag, filterConfidence, searchQuery, archiveTab]);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return "list";
    return (localStorage.getItem("gl_archive_view") as ViewMode) ?? "list";
  });

  const handleViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    try { localStorage.setItem("gl_archive_view", mode); } catch { /* ignore */ }
  };

  // ── Pagination ────────────────────────────────────────────────────────────
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // Reset to first page whenever the filtered set changes
  const filteredKey = `${searchQuery}|${filterState}|${filterCity}|${filterCemetery}|${filterTag}|${filterConfidence}|${sortField}|${sortDir}`;
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [filteredKey]);

  const [groupingMode, setGroupingMode] = useState<GroupingMode>(() => {
    if (typeof window === "undefined") return "flat";
    return (localStorage.getItem("gl_archive_grouping") as GroupingMode) ?? "flat";
  });

  const handleGroupingMode = (mode: GroupingMode) => {
    setGroupingMode(mode);
    try { localStorage.setItem("gl_archive_grouping", mode); } catch {}
  };

  const [viewedIds, setViewedIds] = useState<Set<string>>(() =>
    typeof window === "undefined" ? new Set() : loadViewedIds()
  );
  const handleView = (id: string) => {
    persistViewed(id);
    setViewedIds((prev) => new Set([...prev, id]));
  };

  // ── Scroll position restoration ──────────────────────────────────────────
  // Saves position to sessionStorage on every scroll, restores it on mount
  // so back-navigation from a result returns to the same list position.
  const SCROLL_KEY = "gl_archive_scroll";
  useEffect(() => {
    const scrollEl = document.querySelector(".scroll-container") as HTMLElement | null;
    if (!scrollEl) return;

    // Restore saved position after content renders
    const saved = sessionStorage.getItem(SCROLL_KEY);
    if (saved) {
      requestAnimationFrame(() => { scrollEl.scrollTop = parseInt(saved, 10); });
      sessionStorage.removeItem(SCROLL_KEY);
    }

    const onScroll = () => sessionStorage.setItem(SCROLL_KEY, String(scrollEl.scrollTop));
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, []);

  // ── Backfill thumbnails for existing records ─────────────────────────────
  useEffect(() => {
    (async () => {
      const all = await getAllGraves();
      const missing = all.filter((g) => !g.thumbnailDataUrl);
      if (missing.length === 0) return;
      for (const g of missing) {
        try {
          const thumb = await generateThumbnail(g.photoDataUrl);
          await saveGrave({ ...g, thumbnailDataUrl: thumb });
          setGraves((prev) => prev.map((r) => r.id === g.id ? { ...r, thumbnailDataUrl: thumb } : r));
        } catch { /* non-fatal — will retry next visit */ }
      }
    })();
  }, []);

  // ── Zero-cost backfill: researchLinks for pre-v2 records (runs once) ────
  // buildAllResearchLinks is pure/free; records saved before this feature
  // existed have researchLinks: undefined. Guard with localStorage so it
  // only runs once across all sessions on this device.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem("gl_backfill_v2_done")) return;
    (async () => {
      const all = await getAllGraves();
      const needsBackfill = all
        .filter((g) => g.extracted.name && !g.research?.researchLinks)
        .slice(0, 20);
      for (const g of needsBackfill) {
        try {
          const links = buildAllResearchLinks({
            firstName:   g.extracted.firstName ?? "",
            lastName:    g.extracted.lastName  ?? "",
            birthYear:   g.extracted.birthYear  ?? null,
            deathYear:   g.extracted.deathYear  ?? null,
            state:       g.location?.state      ?? "",
            inscription: g.extracted.inscription ?? "",
            symbols:     g.extracted.symbols     ?? [],
            county:      g.location?.county     ?? null,
          });
          if (links.length === 0) continue;
          const fresh = await getGrave(g.id);
          const base = fresh ?? g;
          await saveGrave({ ...base, research: { ...base.research, researchLinks: links } });
          setGraves((prev) => prev.map((r) =>
            r.id === g.id ? { ...r, research: { ...r.research, researchLinks: links } } : r
          ));
        } catch { /* non-fatal */ }
      }
      if (needsBackfill.length === 0) {
        localStorage.setItem("gl_backfill_v2_done", "1");
      }
    })();
  }, []);

  // ── Bulk research re-enrichment (runs on load, capped at 5/session) ──────
  // Records scanned before new lookup endpoints (NARA items, ±1yr windows,
  // research links) have stale research. Re-run /api/lookup for up to 5
  // unversioned records per session; each saves immediately to IDB.
  useEffect(() => {
    if (loading) return;
    // Enforce the once-per-session cap across remounts — without this, every
    // archive visit refires up to 5 lookups (and signed-out visits burned
    // them all on 401s).
    if (sessionStorage.getItem("gl_enrich_session_done")) return;
    let active = true;

    (async () => {
      const all = await getAllGraves();
      const stale = all
        .filter((g) =>
          g.extracted.name &&
          (g.research?.researchVersion ?? 0) < CURRENT_RESEARCH_VERSION
        )
        .slice(0, 5);
      if (stale.length === 0) return;

      sessionStorage.setItem("gl_enrich_session_done", "1");
      setBulkEnriching(true);
      for (const g of stale) {
        if (!active) break;
        try {
          const { birthYear, deathYear, firstName, lastName, inscription, symbols } = g.extracted;
          const { lat, lng, city, county, state, cemetery } = g.location ?? {};
          const res = await fetch("/api/lookup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: g.extracted.name, firstName, lastName, birthYear, deathYear, lat, lng, city, county, state, cemetery, inscription, symbols }),
          });
          // Signed out — every remaining call will 401 too; stop the pass.
          // The session flag stays set, so this costs one request per
          // session; enrichment resumes in the next session after sign-in.
          if (res.status === 401) break;
          if (!res.ok || !active) continue;
          const data = await res.json();

          const fresh = await getGrave(g.id);
          const base = fresh ?? g;
          const merged: typeof base.research = {
            ...base.research,
            ...data,
            // Preserve user-facing content that should not be overwritten
            storyScript:    base.research?.storyScript,
            narrative:      base.research?.narrative,
            narratives:     base.research?.narratives,
            epitaphSource:  base.research?.epitaphSource,
            epitaphMeaning: base.research?.epitaphMeaning,
            culturalContext: base.research?.culturalContext,
          };
          await saveGrave({ ...base, research: merged });
          if (active) {
            setGraves((prev) => prev.map((r) =>
              r.id === g.id ? { ...r, research: merged } : r
            ));
          }
          await sleep(750);
        } catch { /* non-fatal — will retry on next session */ }
      }
      if (active) setBulkEnriching(false);
    })();

    return () => { active = false; };
  }, [loading]);

  // ── Load graves ──────────────────────────────────────────────────────────
  // Stale-while-revalidate: show local IndexedDB data immediately, then
  // merge with Supabase cloud records if the user is logged in.
  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 1500);

    getAllGraves()
      .then(async (local) => {
        setGraves(local);
        setLoading(false);
        clearTimeout(timer);

        // Background cloud merge — non-fatal
        try {
          const supabase = createClient();
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return;

          const cloud = await fetchAllFromCloud(supabase, user.id);
          if (cloud.length === 0) return;

          // Merge: local wins on conflict — local edits are never pushed to the
          // cloud on save, so the local copy is always more current. Cloud only
          // contributes records the local device doesn't have yet (cross-device adds).
          const localIds = new Set(local.map((r) => r.id));
          const cloudOnly = cloud.filter((r) => !localIds.has(r.id));
          const merged = [...local, ...cloudOnly].sort(
            (a, b) => b.timestamp - a.timestamp
          );

          // Warm the local cache with cross-device records
          await Promise.all(cloudOnly.map((r) => saveGrave(r).catch(() => {})));

          setGraves(merged);
        } catch { /* offline or not logged in — local data stands */ }
      })
      .catch(() => {
        setLoading(false);
        clearTimeout(timer);
      });

    return () => clearTimeout(timer);
  }, []);

  // ── Refresh graves from IDB when the user returns to this page ───────────
  // Catches name/date edits made on the result page before navigating back.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) {
        getAllGraves().then(setGraves).catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // ── Load cemeteries from IDB & Sanitize Polluted Data ─────────────────────
  useEffect(() => {
    getAllCemeteries().then(async (list) => {
      try {
        const mapping = JSON.parse(localStorage.getItem("gl_cemetery_id_names") ?? "{}");
        list.forEach((c) => {
          mapping[c.id] = c.name;
        });
        localStorage.setItem("gl_cemetery_id_names", JSON.stringify(mapping));
      } catch {}

      const sanitized = await Promise.all(
        list.map(async (c) => {
          const nameLower = c.name.toLowerCase();
          const descLower = (c.description || "").toLowerCase();
          if (descLower.includes("bellefontaine") && !nameLower.includes("bellefontaine")) {
            const cleaned = {
              ...c,
              osmId: undefined,
              openingHours: undefined,
              phone: undefined,
              website: undefined,
              wikipediaUrl: undefined,
              denomination: undefined,
              established: undefined,
              description: undefined,
              notableFeatures: undefined,
              historicalEvents: undefined,
            };
            await saveCemetery(cleaned);
            return cleaned;
          }
          return c;
        })
      );
      setCemeteries(sanitized);
    }).catch(() => {});
  }, []);

  const loadFailedQueue = useCallback(() => {
    getQueuedItems()
      .then((items) => {
        const failed = items.filter((item) => item.status === "failed");
        setFailedQueueItems(failed);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadFailedQueue();

    const onQueueChanged = () => {
      loadFailedQueue();
    };
    window.addEventListener(QUEUE_CHANGED_EVENT, onQueueChanged);
    return () => {
      window.removeEventListener(QUEUE_CHANGED_EVENT, onQueueChanged);
    };
  }, [loadFailedQueue]);


  // ── Cemetery enrichment ──────────────────────────────────────────────────
  // 1. Check learned cemeteries (instant, no network)
  // 2. Nominatim reverse geocode (1 req/sec)
  // 3. Unresolved → placed in assignmentQueue for guided manual entry
  useEffect(() => {
    if (loading) return;

    const needsEnrichment = graves.filter(
      (g) =>
        g.location?.lat && g.location?.lng &&
        (!g.location?.cemetery || !g.location?.city || !g.location?.state)
    );
    if (needsEnrichment.length === 0) return;

    let active = true;
    setEnriching(true);
    const resolvedIds = new Set<string>();

    (async () => {
      let nominatimCalls = 0;

      for (const grave of needsEnrichment) {
        if (!active) break;
        const { lat, lng } = grave.location;

        // 1. Learned cemeteries
        const learnedName = findLearnedCemetery(lat, lng);
        if (learnedName) {
          const updated = { ...grave, location: { ...grave.location, cemetery: learnedName } };
          await saveGrave(updated);
          if (active) setGraves((prev) => prev.map((g) => g.id === updated.id ? updated : g));
          resolvedIds.add(grave.id);
          continue;
        }

        // 2. Nominatim
        if (nominatimCalls > 0) await sleep(1100);
        if (!active) break;
        nominatimCalls++;

        try {
          const enriched = await reverseGeocode(lat, lng);
          if (!active) break;
          const hasNew =
            enriched.cemetery ||
            (enriched.city && !grave.location.city) ||
            (enriched.state && !grave.location.state);
          if (hasNew) {
            const updated: GraveRecord = {
              ...grave,
              location: {
                ...grave.location,
                cemetery: enriched.cemetery || grave.location.cemetery,
                city: enriched.city || grave.location.city,
                state: enriched.state || grave.location.state,
              },
            };
            await saveGrave(updated);
            if (enriched.cemetery) learnCemetery(enriched.cemetery, lat, lng);
            if (active) setGraves((prev) => prev.map((g) => g.id === updated.id ? updated : g));
            resolvedIds.add(grave.id);
          }
        } catch { /* non-fatal */ }
      }

      if (active) {
        setEnriching(false);
        // Build queue from graves that still have no cemetery after enrichment
        const unresolved = needsEnrichment
          .filter((g) => !resolvedIds.has(g.id))
          .map((g) => g.id);
        if (unresolved.length > 0) setAssignmentQueue(unresolved);
      }
    })();

    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // ── Assignment flow helpers ──────────────────────────────────────────────
  const openNextAssignment = (queue: string[]) => {
    if (queue.length === 0) {
      setActiveAssignmentId(null);
      setAssignmentInput("");
      return;
    }
    setActiveAssignmentId(queue[0]);
    setAssignmentInput("");
  };

  const startAssignment = () => openNextAssignment(assignmentQueue);

  const handleAssignSave = async () => {
    const name = assignmentInput.trim();
    if (!name || !activeAssignmentId) return;

    const grave = graves.find((g) => g.id === activeAssignmentId);
    if (!grave) return;

    // Apply to current grave
    const updated = { ...grave, location: { ...grave.location, cemetery: name } };
    await saveGrave(updated);
    if (grave.location?.lat && grave.location?.lng) {
      learnCemetery(name, grave.location.lat, grave.location.lng);
    }
    setGraves((prev) => prev.map((g) => g.id === updated.id ? updated : g));

    // Remove from queue
    const nextQueue = assignmentQueue.filter((id) => id !== activeAssignmentId);
    setAssignmentQueue(nextQueue);
    setActiveAssignmentId(null);
    setAssignmentInput("");

    // Find other unassigned graves in the queue that are within proximity
    if (grave.location?.lat && grave.location?.lng) {
      const nearby = nextQueue
        .map((id) => graves.find((g) => g.id === id))
        .filter((g): g is GraveRecord =>
          Boolean(
            g?.location?.lat &&
            g?.location?.lng &&
            !g?.location?.cemetery &&
            distanceMeters(grave.location.lat, grave.location.lng, g.location.lat, g.location.lng) < PROXIMITY_METERS
          )
        );

      if (nearby.length > 0) {
        setNearbyConfirm({ name, graves: nearby });
        return; // wait for confirmation before advancing
      }
    }

    openNextAssignment(nextQueue);
  };

  const handleAssignSkip = () => {
    const nextQueue = assignmentQueue.filter((id) => id !== activeAssignmentId);
    setAssignmentQueue(nextQueue);
    openNextAssignment(nextQueue);
  };

  const handleNearbyYes = async () => {
    if (!nearbyConfirm) return;
    const { name, graves: nearbyGraves } = nearbyConfirm;

    // Apply cemetery name to all nearby graves
    const ids = nearbyGraves.map((g) => g.id);
    for (const g of nearbyGraves) {
      const updated = { ...g, location: { ...g.location, cemetery: name } };
      await saveGrave(updated);
      setGraves((prev) => prev.map((r) => r.id === updated.id ? updated : r));
    }

    const nextQueue = assignmentQueue.filter((id) => !ids.includes(id));
    setAssignmentQueue(nextQueue);
    setNearbyConfirm(null);
    openNextAssignment(nextQueue);
  };

  const handleNearbyNo = () => {
    // Nearby graves stay in queue — user will be prompted individually
    setNearbyConfirm(null);
    openNextAssignment(assignmentQueue);
  };

  // ── Manual cemetery edit ──────────────────────────────────────────────────
  // Full-record edit from an archive row: name, dates, cemetery in one save.
  // Applies the same derivations as ResultPage edits (first/last name split,
  // year extraction) and counts as a human review of the record.
  const handleGraveEdit = async (id: string, patch: GraveEditPatch) => {
    const grave = graves.find((g) => g.id === id);
    if (!grave) return;

    const YEAR_RE = /\b(1[5-9]\d\d|20[0-2]\d)\b/;
    const extracted = { ...grave.extracted };
    if (patch.name !== undefined) {
      extracted.name = patch.name;
      const parts = patch.name.split(/\s+/).filter(Boolean);
      extracted.firstName = parts[0] ?? "";
      extracted.lastName = parts.length > 1 ? parts[parts.length - 1] : "";
    }
    if (patch.birthDate !== undefined) {
      extracted.birthDate = patch.birthDate;
      extracted.birthYear = patch.birthDate.match(YEAR_RE) ? parseInt(patch.birthDate.match(YEAR_RE)![1], 10) : null;
    }
    if (patch.deathDate !== undefined) {
      extracted.deathDate = patch.deathDate;
      extracted.deathYear = patch.deathDate.match(YEAR_RE) ? parseInt(patch.deathDate.match(YEAR_RE)![1], 10) : null;
    }

    const updated: GraveRecord = {
      ...grave,
      extracted,
      ...(patch.cemetery !== undefined
        ? { location: { ...grave.location, cemetery: patch.cemetery } }
        : {}),
      // A human edit that leaves the record with a name counts as review
      ...(extracted.name ? { reviewedAt: Date.now(), needsReview: false } : {}),
    };
    await saveGrave(updated);
    setGraves((prev) => prev.map((g) => (g.id === id ? updated : g)));

    // Cemetery changed — learn it and offer the nearby bulk update
    if (patch.cemetery && grave.location?.lat && grave.location?.lng) {
      learnCemetery(patch.cemetery, grave.location.lat, grave.location.lng);
      const nearby = graves.filter((g) => {
        if (g.id === id) return false;
        if (!g.location?.lat || !g.location?.lng) return false;
        return distanceMeters(grave.location.lat, grave.location.lng, g.location.lat, g.location.lng) < PROXIMITY_METERS;
      });
      if (nearby.length > 0) {
        setNearbyConfirm({ name: patch.cemetery, graves: nearby });
      }
    }
  };

  // ── Derived filter options ────────────────────────────────────────────────
  const uniqueStates = useMemo(() => {
    const vals = graves.map((g) => g.location?.state).filter((v): v is string => Boolean(v));
    return [...new Set(vals)].sort();
  }, [graves]);

  const uniqueCities = useMemo(() => {
    const vals = graves
      .filter((g) => !filterState || g.location?.state === filterState)
      .map((g) => g.location?.city)
      .filter((v): v is string => Boolean(v));
    return [...new Set(vals)].sort();
  }, [graves, filterState]);

  const uniqueTags = useMemo(() => {
    const vals = graves.flatMap((g) => g.tags ?? []);
    return [...new Set(vals)].sort();
  }, [graves]);

  const uniqueCemeteries = useMemo(() => {
    const vals = graves
      .filter(
        (g) =>
          (!filterState || g.location?.state === filterState) &&
          (!filterCity || g.location?.city === filterCity)
      )
      .map((g) => g.location?.cemetery)
      .filter((v): v is string => Boolean(v));
    return [...new Set(vals)].sort();
  }, [graves, filterState, filterCity]);

  // ── Derived places: merge IDB CemeteryRecords with cemeteries from graves ──
  const derivedPlaces = useMemo(() => {
    const map = new Map<string, CemeteryRecord>();
    // IDB records take priority
    cemeteries.forEach((c) => map.set(c.name.toLowerCase().trim(), c));
    // Backfill from graves for any cemetery not yet in IDB
    graves.forEach((g) => {
      const name = g.location?.cemetery;
      if (!name || !g.location?.lat || !g.location?.lng) return;
      const key = name.toLowerCase().trim();
      if (!map.has(key)) {
        map.set(key, {
          id: `gl_derived_${key}`,
          name,
          lat: g.location.lat,
          lng: g.location.lng,
          visitCount: 1,
          firstVisited: g.timestamp,
          lastVisited: g.timestamp,
        });
      } else {
        // Update visit tracking on the derived entry
        const existing = map.get(key)!;
        if (existing.id.startsWith("gl_derived_")) {
          map.set(key, {
            ...existing,
            visitCount: existing.visitCount + 1,
            lastVisited: Math.max(existing.lastVisited, g.timestamp),
            firstVisited: Math.min(existing.firstVisited, g.timestamp),
          });
        }
      }
    });
    return Array.from(map.values()).sort((a, b) => b.lastVisited - a.lastVisited);
  }, [graves, cemeteries]);

  // ── Working Scans: records flagged for manual completion ─────────────────
  const workingScans = useMemo(() => graves.filter(shouldReview), [graves]);

  // ── Filtered + sorted graves ──────────────────────────────────────────────
  const filteredGraves = useMemo(() => {
    let result = graves.filter((g) => {
      // Exclude records that belong in Review tab
      if (shouldReview(g)) return false;
      // Exclude records that represent a place (cemetery/graveyard), not an individual marker
      const mType = g.extracted?.markerType?.toLowerCase() ?? "";
      if (PLACE_MARKER_TYPES.has(mType)) return false;
      const hasPlaceTag = g.tags?.some((t) => PLACE_MARKER_TYPES.has(t.toLowerCase()));
      if (hasPlaceTag) return false;
      // Text search
      if (searchQuery) {
        const q = searchQuery.toLowerCase().trim();
        const queryWords = q.split(/\s+/).filter(Boolean);

        const name = g.extracted.name || "";
        let isMatch = matchesNameQuery(name, queryWords);

        if (!isMatch && Array.isArray(g.extracted.people)) {
          isMatch = g.extracted.people.some((p) => matchesNameQuery(p.name || "", queryWords));
        }

        if (!isMatch) {
          const cemetery = g.location?.cemetery?.toLowerCase() || "";
          const city = g.location?.city?.toLowerCase() || "";
          const state = g.location?.state?.toLowerCase() || "";
          const tags = (g.tags || []).join(" ").toLowerCase();
          const inscription = g.extracted.inscription?.toLowerCase() || "";

          isMatch =
            cemetery.includes(q) ||
            city.includes(q) ||
            state.includes(q) ||
            tags.includes(q) ||
            inscription.includes(q) ||
            queryWords.every((qw: string) =>
              cemetery.includes(qw) ||
              city.includes(qw) ||
              state.includes(qw) ||
              tags.includes(qw) ||
              inscription.includes(qw)
            );
        }

        if (!isMatch) return false;
      }

      if (filterState && g.location?.state !== filterState) return false;
      if (filterCity && g.location?.city !== filterCity) return false;
      if (filterCemetery && g.location?.cemetery !== filterCemetery) return false;
      if (filterTag && !g.tags?.includes(filterTag)) return false;
      if (filterConfidence) {
        const conf = g.extracted?.confidence;
        if (filterConfidence === "needs_review") {
          if (conf !== "medium" && conf !== "low") return false;
        } else {
          if (conf !== filterConfidence) return false;
        }
      }
      return true;
    });
    result = [...result].sort((a, b) => {
      if (sortField === "name") {
        const aName = (a.extracted.name ?? "").toLowerCase();
        const bName = (b.extracted.name ?? "").toLowerCase();
        const cmp = aName.localeCompare(bName);
        return sortDir === "asc" ? cmp : -cmp;
      }
      if (sortField === "lastName") {
        const aLast = (a.extracted.lastName ?? "").toLowerCase();
        const bLast = (b.extracted.lastName ?? "").toLowerCase();
        if (aLast !== bLast) {
          const cmp = aLast.localeCompare(bLast);
          return sortDir === "asc" ? cmp : -cmp;
        }
        const aFirst = (a.extracted.firstName ?? "").toLowerCase();
        const bFirst = (b.extracted.firstName ?? "").toLowerCase();
        const cmp = aFirst.localeCompare(bFirst);
        return sortDir === "asc" ? cmp : -cmp;
      }
      if (sortField === "cemetery") {
        const aCem = (a.location?.cemetery ?? "").toLowerCase();
        const bCem = (b.location?.cemetery ?? "").toLowerCase();
        const cmp = aCem.localeCompare(bCem);
        return sortDir === "asc" ? cmp : -cmp;
      }
      if (sortField === "dateAdded") {
        return sortDir === "asc" ? a.timestamp - b.timestamp : b.timestamp - a.timestamp;
      }
      let aVal: number | null = null;
      let bVal: number | null = null;
      if (sortField === "birthYear" || sortField === "deathYear" || sortField === "ageAtDeath") {
        aVal = a.extracted[sortField] ?? null;
        bVal = b.extracted[sortField] ?? null;
      }
      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return 1;
      if (bVal === null) return -1;
      return sortDir === "asc" ? aVal - bVal : bVal - aVal;
    });
    return result;
  }, [graves, filterState, filterCity, filterCemetery, filterTag, filterConfidence, searchQuery, sortField, sortDir]);

  const groupedGraves = useMemo(() => {
    if (groupingMode === "flat") return null;

    const cemeteryMap = new Map<string, { cemeteryName: string; locationDesc: string; graves: GraveRecord[] }>();

    for (const g of filteredGraves) {
      const cemeteryName = g.location?.cemetery || "Unknown Cemetery";
      const city = g.location?.city || "";
      const state = g.location?.state || "";
      const locationDesc = [city, state].filter(Boolean).join(", ");

      let group = cemeteryMap.get(cemeteryName);
      if (!group) {
        group = { cemeteryName, locationDesc, graves: [] };
        cemeteryMap.set(cemeteryName, group);
      }
      group.graves.push(g);
    }

    const sortedCemeteries = Array.from(cemeteryMap.values()).sort((a, b) => {
      if (a.cemeteryName === "Unknown Cemetery") return 1;
      if (b.cemeteryName === "Unknown Cemetery") return -1;
      return a.cemeteryName.localeCompare(b.cemeteryName);
    });

    if (groupingMode === "cemetery") {
      return sortedCemeteries as CemeteryGroup[];
    }

    // groupingMode === "family"
    return sortedCemeteries.map((c) => {
      const familyMap = new Map<string, { surname: string; graves: GraveRecord[] }>();

      for (const g of c.graves) {
        const surname = g.extracted.lastName?.trim() || "Unknown";
        let fam = familyMap.get(surname);
        if (!fam) {
          fam = { surname, graves: [] };
          familyMap.set(surname, fam);
        }
        fam.graves.push(g);
      }

      const sortedFamilies = Array.from(familyMap.values()).sort((a, b) => {
        if (a.surname === "Unknown") return 1;
        if (b.surname === "Unknown") return -1;
        return a.surname.localeCompare(b.surname);
      });

      return {
        cemeteryName: c.cemeteryName,
        locationDesc: c.locationDesc,
        families: sortedFamilies,
      } as CemeteryFamilyGroup;
    });
  }, [filteredGraves, groupingMode]);

  // ── Duplicate Detection & Merging ───────────────────────────────────────
  const duplicateGroups = useMemo(() => {
    if (graves.length < 2) return [];

    const groups: Array<{ primary: GraveRecord; duplicates: GraveRecord[] }> = [];
    const processedIds = new Set<string>();

    for (let i = 0; i < graves.length; i++) {
      const a = graves[i];
      if (processedIds.has(a.id) || !a.extracted?.name) continue;

      const dupsForA: GraveRecord[] = [];
      const aLast = (a.extracted.lastName || "").toLowerCase().trim();
      const aFirst = (a.extracted.firstName || "").toLowerCase().trim();
      const aBirth = a.extracted.birthYear;
      const aDeath = a.extracted.deathYear;
      const aCemetery = (a.location?.cemetery || "").toLowerCase().trim();

      for (let j = i + 1; j < graves.length; j++) {
        const b = graves[j];
        if (processedIds.has(b.id) || !b.extracted?.name) continue;

        const bLast = (b.extracted.lastName || "").toLowerCase().trim();
        const bFirst = (b.extracted.firstName || "").toLowerCase().trim();
        const bBirth = b.extracted.birthYear;
        const bDeath = b.extracted.deathYear;
        const bCemetery = (b.location?.cemetery || "").toLowerCase().trim();

        const surnameMatch = aLast === bLast || (aLast.length >= 3 && bLast.length >= 3 && getSoundex(aLast) === getSoundex(bLast));
        const firstMatch = aFirst.includes(bFirst) || bFirst.includes(aFirst) || getSoundex(aFirst) === getSoundex(bFirst);

        let geoMatch = false;
        if (aCemetery && bCemetery && aCemetery === bCemetery) {
          geoMatch = true;
        } else if (a.location?.lat && a.location?.lng && b.location?.lat && b.location?.lng) {
          const dist = distanceMeters(a.location.lat, a.location.lng, b.location.lat, b.location.lng);
          if (dist < 15) geoMatch = true;
        }

        const yearMatch = (aBirth != null && bBirth != null && aBirth === bBirth) ||
                          (aDeath != null && bDeath != null && aDeath === bDeath) ||
                          (aBirth == null && aDeath == null && bBirth == null && bDeath == null);

        if (surnameMatch && firstMatch && geoMatch && yearMatch) {
          dupsForA.push(b);
          processedIds.add(b.id);
        }
      }

      if (dupsForA.length > 0) {
        processedIds.add(a.id);
        groups.push({ primary: a, duplicates: dupsForA });
      }
    }

    return groups;
  }, [graves]);

  const handleMergeDuplicates = async (primaryId: string, duplicateIds: string[]) => {
    const primary = graves.find((g) => g.id === primaryId);
    if (!primary) return;

    const merged = { ...primary };

    for (const dupId of duplicateIds) {
      const dup = graves.find((g) => g.id === dupId);
      if (!dup) continue;

      const combinedTags = Array.from(new Set([...(merged.tags || []), ...(dup.tags || [])]));
      merged.tags = combinedTags;

      const combinedPhotos = Array.from(new Set([
        ...(merged.additionalPhotos || []),
        dup.photoDataUrl,
        ...(dup.additionalPhotos || [])
      ]));
      merged.additionalPhotos = combinedPhotos;

      if (dup.userNotes) {
        merged.userNotes = merged.userNotes
          ? `${merged.userNotes}\n\n[Merged Scan Notes]: ${dup.userNotes}`
          : dup.userNotes;
      }
      if (dup.communityNote) {
        merged.communityNote = merged.communityNote
          ? `${merged.communityNote}\n\n[Merged Scan Notes]: ${dup.communityNote}`
          : dup.communityNote;
      }

      await deleteGrave(dup.id);

      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) await deleteFromCloud(supabase, user.id, dup.id);
      } catch {}
    }

    await saveGrave(merged);

    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await upsertGrave(supabase, user.id, merged, merged.photoDataUrl);
      }
    } catch {}

    setGraves((prev) =>
      prev
        .filter((g) => !duplicateIds.includes(g.id))
        .map((g) => (g.id === primaryId ? merged : g))
    );
  };

  const handleDelete = async (id: string) => {
    await deleteGrave(id);
    setGraves((prev) => prev.filter((g) => g.id !== id));
    setDeleteConfirm(null);
    // Cloud delete — non-fatal
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user) await deleteFromCloud(supabase, user.id, id);
    } catch { /* offline or not logged in */ }
  };

  const handleExportCsv = useCallback(() => {
    if (graves.length === 0) return;

    const headers = [
      "ID",
      "Name",
      "First Name",
      "Last Name",
      "Birth Date",
      "Birth Year",
      "Death Date",
      "Death Year",
      "Age At Death",
      "Inscription",
      "Epitaph",
      "Marker Type",
      "Material",
      "Condition",
      "Confidence",
      "Cemetery",
      "City",
      "County",
      "State",
      "Latitude",
      "Longitude",
      "Tags",
      "Co-Buried Names",
      "Scan Date"
    ];

    const rows = graves.map((g) => {
      const secondaryNames = (g.extracted.people || [])
        .slice(1)
        .map((p) => p.name)
        .filter(Boolean)
        .join("; ");

      const scanDate = new Date(g.timestamp).toISOString();

      return [
        g.id,
        g.extracted.name || "",
        g.extracted.firstName || "",
        g.extracted.lastName || "",
        g.extracted.birthDate || "",
        g.extracted.birthYear !== null ? String(g.extracted.birthYear) : "",
        g.extracted.deathDate || "",
        g.extracted.deathYear !== null ? String(g.extracted.deathYear) : "",
        g.extracted.ageAtDeath !== null ? String(g.extracted.ageAtDeath) : "",
        g.extracted.inscription || "",
        g.extracted.epitaph || "",
        g.extracted.markerType || "",
        g.extracted.material || "",
        g.extracted.condition || "",
        g.extracted.confidence || "",
        g.location?.cemetery || "",
        g.location?.city || "",
        g.location?.county || "",
        g.location?.state || "",
        g.location?.lat !== undefined ? String(g.location.lat) : "",
        g.location?.lng !== undefined ? String(g.location.lng) : "",
        (g.tags || []).join("; "),
        secondaryNames,
        scanDate
      ];
    });

    const csvContent = [
      headers.join(","),
      ...rows.map((row) =>
        row
          .map((val) => {
            const escaped = String(val).replace(/"/g, '""');
            if (/[,"\n\r]/.test(escaped)) {
              return `"${escaped}"`;
            }
            return escaped;
          })
          .join(",")
      )
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `gravelens-export-${new Date().toISOString().slice(0, 10)}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [graves]);

  const handleFilterState = (val: string) => { setFilterState(val); setFilterCity(""); setFilterCemetery(""); };
  const handleFilterCity = (val: string) => { setFilterCity(val); setFilterCemetery(""); };

  const hasActiveFilters =
    filterState || filterCity || filterCemetery || filterTag || filterConfidence ||
    sortField !== "deathYear" || sortDir !== "asc";

  const showAssignBanner = assignmentQueue.length > 0 && !enriching && !activeAssignmentId && !nearbyConfirm;

  return (
    <PageShell
      title="Archive"
      icon={
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
      }
      headerTitleActions={null}
      headerActions={
        <>
          {graves.length > 0 && (
          <div className="flex bg-stone-800/60 rounded-full p-1 border border-white/5 shadow-[inset_0_1px_4px_rgba(0,0,0,0.5)]">
            <button
              onClick={() => {
                setSearchOpen((o) => !o);
                if (filtersOpen) setFiltersOpen(false);
              }}
              className={`w-8 h-8 flex items-center justify-center rounded-full transition-all ${
                searchOpen ? "bg-white/10 shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]" : "hover:bg-white/5"
              }`}
              aria-label="Toggle search"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={searchQuery || searchOpen ? "var(--t-gold-500)" : "var(--t-stone-500)"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
              </svg>
            </button>
            <button
              onClick={() => {
                setFiltersOpen((o) => !o);
                if (searchOpen) setSearchOpen(false);
              }}
              className={`relative w-8 h-8 flex items-center justify-center rounded-full transition-all ${
                filtersOpen ? "bg-white/10 shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]" : "hover:bg-white/5"
              }`}
              aria-label="Toggle filters"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={hasActiveFilters || filtersOpen ? "var(--t-gold-500)" : "var(--t-stone-500)"} strokeWidth="2" strokeLinecap="round">
                <path d="M1 3h14M3 8h10M6 13h4" />
              </svg>
              {hasActiveFilters && (
                <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-gold-400 rounded-full shadow-[0_0_4px_rgba(201,168,76,0.8)]" />
              )}
            </button>
            <Link
              href="/research"
              className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/5 transition-all text-stone-500 hover:text-stone-300"
              aria-label="Research a name"
              title="Research a name"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                <line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
              </svg>
            </Link>
            <button
              onClick={handleExportCsv}
              className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/5 transition-all text-stone-500 hover:text-stone-300"
              aria-label="Export database as CSV"
              title="Export as CSV"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
          </div>
          )}
        </>
      }
      headerBottomRow={
        <>
          <div className="flex bg-[var(--t-stone-900)]/80 rounded-[14px] p-1 border border-stone-800 shadow-[inset_0_1px_4px_rgba(0,0,0,0.5)]">
            {/* Markers */}
            <button
              onClick={() => setArchiveTab("markers")}
              className={`px-2.5 sm:px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-[10px] transition-all flex items-center gap-1.5 ${
                archiveTab === "markers"
                  ? "bg-stone-700/80 text-gold-400 shadow-[0_2px_8px_rgba(0,0,0,0.5)] border border-stone-600/50"
                  : "text-stone-500 hover:text-stone-300 border border-transparent"
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/>
              </svg>
              Markers
            </button>
            {/* Places */}
            <button
              onClick={() => setArchiveTab("places")}
              className={`px-2.5 sm:px-4 py-1.5 text-xs font-bold uppercase tracking-wider rounded-[10px] transition-all flex items-center gap-1.5 ${
                archiveTab === "places"
                  ? "bg-stone-700/80 text-gold-400 shadow-[0_2px_8px_rgba(0,0,0,0.5)] border border-stone-600/50"
                  : "text-stone-500 hover:text-stone-300 border border-transparent"
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 21h12"/><path d="M7 21v-8a5 5 0 0 1 10 0v8"/><path d="M12 7v4"/><path d="M10 9h4"/>
              </svg>
              Places
            </button>
            {/* Review — pending completion */}
            <button
              onClick={() => setArchiveTab("review")}
              className={`relative px-2.5 sm:px-4 py-1.5 text-xs font-bold uppercase tracking-wider rounded-[10px] transition-all flex items-center gap-1.5 ${
                archiveTab === "review"
                  ? "bg-stone-700/80 text-gold-400 shadow-[0_2px_8px_rgba(0,0,0,0.5)] border border-stone-600/50"
                  : "text-stone-500 hover:text-stone-300 border border-transparent"
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
              Review
              {workingScans.length > 0 && (
                <span
                  className="absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-0.5 rounded-full text-[0.6rem] font-bold flex items-center justify-center bg-amber-500 text-stone-900 shadow"
                >
                  {workingScans.length}
                </span>
              )}
            </button>
          </div>
          {archiveTab === "markers" && graves.length > 0 && (
            <div className="flex items-center gap-1 shrink-0">
              {(
                [
                  { mode: "list" as ViewMode,    label: "List",    icon: <path d="M2 4h12M2 8h12M2 12h12" /> },
                  { mode: "compact" as ViewMode, label: "Compact", icon: <><path d="M2 3h12M2 6.5h12M2 10h12M2 13.5h12" /></> },
                  { mode: "tile" as ViewMode,    label: "Tile",    icon: <><rect x="1" y="1" width="6" height="6" rx="1" /><rect x="9" y="1" width="6" height="6" rx="1" /><rect x="1" y="9" width="6" height="6" rx="1" /><rect x="9" y="9" width="6" height="6" rx="1" /></> },
                  { mode: "cover" as ViewMode,   label: "Cover",   icon: <><rect x="1" y="2" width="14" height="12" rx="2" /><path d="M4 13V9" strokeWidth="1" opacity="0.5" /><path d="M12 13V9" strokeWidth="1" opacity="0.5" /></> },
                ] as const
              ).map(({ mode, label, icon }) => (
                <button
                  key={mode}
                  onClick={() => handleViewMode(mode)}
                  aria-label={label}
                  className={`w-8 h-8 flex items-center justify-center rounded-[10px] transition-all ${
                    viewMode === mode ? "bg-gold-500/15 text-gold-400 shadow-[inset_0_1px_2px_rgba(201,168,76,0.2)]" : "text-stone-500 hover:bg-white/5 hover:text-stone-300"
                  }`}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    {icon}
                  </svg>
                </button>
              ))}
            </div>
          )}
        </>
      }
      headerPanels={
        <>
          {searchOpen && (
            <div className="px-4 pb-3 border-t border-stone-800 pt-3">
              <div className="relative">
                <input
                  autoFocus
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search name, cemetery, inscription..."
                  className="w-full bg-stone-800 text-stone-200 text-sm rounded-lg pl-9 pr-8 py-1.5 border border-stone-700 focus:outline-none focus:border-gold-500/50"
                />
                <div className="absolute left-3 top-2 text-stone-500">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.3-4.3" />
                  </svg>
                </div>
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="absolute right-2.5 top-2 text-stone-500 active:text-stone-300"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          )}
          {filtersOpen && graves.length > 0 && (
            <div className="px-4 pb-3 border-t border-stone-800 pt-3 flex flex-col gap-2">
              {/* Grouping Control */}
              <div className="flex flex-col gap-1 mb-1">
                <span className="text-[0.6rem] font-bold text-stone-500 uppercase tracking-widest">Grouping Mode</span>
                <div className="flex bg-stone-900/50 p-0.5 rounded-lg border border-stone-800/80">
                  {(
                    [
                      { mode: "flat", label: "Flat List" },
                      { mode: "cemetery", label: "By Cemetery" },
                      { mode: "family", label: "By Family" }
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.mode}
                      onClick={() => handleGroupingMode(item.mode)}
                      className={`flex-1 text-[0.7rem] font-semibold py-1 rounded-md transition-all ${
                        groupingMode === item.mode
                          ? "bg-stone-800 text-gold-400 shadow-sm border border-stone-700/60"
                          : "text-stone-500 hover:text-stone-300"
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Sort row */}
              <div className="flex gap-2">
                <select
                  value={sortField}
                  onChange={(e) => setSortField(e.target.value as SortField)}
                  className="flex-1 bg-stone-800 text-stone-200 text-xs rounded-lg px-3 py-2 border border-stone-700 appearance-none"
                >
                  <option value="lastName">Last Name (Family)</option>
                  <option value="name">First Name</option>
                  <option value="deathYear">Death Year</option>
                  <option value="birthYear">Birth Year</option>
                  <option value="ageAtDeath">Age at Death</option>
                  <option value="cemetery">Cemetery</option>
                  <option value="dateAdded">Date Added</option>
                </select>
                <button
                  onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                  className="flex items-center gap-1.5 px-3 py-2 bg-stone-800 border border-stone-700 text-stone-300 text-xs rounded-lg shrink-0"
                >
                  {sortField === "name" || sortField === "lastName" || sortField === "cemetery" ? (
                    sortDir === "asc" ? (
                      <><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2v8M3 7l3 3 3-3" /></svg>A → Z</>
                    ) : (
                      <><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 10V2M3 5l3-3 3 3" /></svg>Z → A</>
                    )
                  ) : sortField === "ageAtDeath" ? (
                    sortDir === "asc" ? (
                      <><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2v8M3 7l3 3 3-3" /></svg>Youngest first</>
                    ) : (
                      <><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 10V2M3 5l3-3 3 3" /></svg>Oldest first</>
                    )
                  ) : (
                    sortDir === "asc" ? (
                      <><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2v8M3 7l3 3 3-3" /></svg>Oldest first</>
                    ) : (
                      <><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 10V2M3 5l3-3 3 3" /></svg>Newest first</>
                    )
                  )}
                </button>
              </div>
              {/* Location filters */}
              <div className="flex gap-2">
                <select value={filterState} onChange={(e) => handleFilterState(e.target.value)} className="flex-1 bg-stone-800 text-stone-200 text-xs rounded-lg px-3 py-2 border border-stone-700 appearance-none">
                  <option value="">All states</option>
                  {uniqueStates.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <select value={filterCity} onChange={(e) => handleFilterCity(e.target.value)} disabled={uniqueCities.length === 0} className="flex-1 bg-stone-800 text-stone-200 text-xs rounded-lg px-3 py-2 border border-stone-700 appearance-none disabled:opacity-40">
                  <option value="">All cities</option>
                  {uniqueCities.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <select value={filterCemetery} onChange={(e) => setFilterCemetery(e.target.value)} disabled={uniqueCemeteries.length === 0} className="w-full bg-stone-800 text-stone-200 text-xs rounded-lg px-3 py-2 border border-stone-700 appearance-none disabled:opacity-40">
                <option value="">All cemeteries</option>
                {uniqueCemeteries.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              {/* Tag + confidence filters */}
              <div className="flex gap-2">
                <select value={filterTag} onChange={(e) => setFilterTag(e.target.value)} disabled={uniqueTags.length === 0} className="flex-1 bg-stone-800 text-stone-200 text-xs rounded-lg px-3 py-2 border border-stone-700 appearance-none disabled:opacity-40">
                  <option value="">All tags</option>
                  {uniqueTags.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <select
                  value={filterConfidence}
                  onChange={(e) => setFilterConfidence(e.target.value as ConfidenceFilter)}
                  className="flex-1 bg-stone-800 text-stone-200 text-xs rounded-lg px-3 py-2 border border-stone-700 appearance-none"
                >
                  <option value="">All confidence</option>
                  <option value="needs_review">Needs review</option>
                  <option value="high">High only</option>
                  <option value="medium">Medium only</option>
                  <option value="low">Low only</option>
                </select>
              </div>
              {hasActiveFilters && (
                <button
                  onClick={() => { setFilterState(""); setFilterCity(""); setFilterCemetery(""); setFilterTag(""); setFilterConfidence(""); setSortField("deathYear"); setSortDir("asc"); }}
                  className="text-xs text-gold-400 text-left"
                >
                  Clear all filters
                </button>
              )}
            </div>
          )}
        </>
      }
      absoluteOverlays={
        <>
          {activeAssignmentId && (() => {
            const grave = graves.find((g) => g.id === activeAssignmentId);
            if (!grave) return null;
            const queueIndex = assignmentQueue.indexOf(activeAssignmentId);
            return (
              <AssignmentSheet
                grave={grave}
                value={assignmentInput}
                onChange={setAssignmentInput}
                onSave={handleAssignSave}
                onSkip={handleAssignSkip}
                current={queueIndex + 1}
                total={assignmentQueue.length}
              />
            );
          })()}
          {nearbyConfirm && (
            <NearbyConfirmSheet
              cemeteryName={nearbyConfirm.name}
              nearby={nearbyConfirm.graves}
              onYes={handleNearbyYes}
              onNo={handleNearbyNo}
            />
          )}
          {editSheetGrave && (
            <GraveEditSheet
              grave={editSheetGrave}
              onSave={(patch) => handleGraveEdit(editSheetGrave.id, patch)}
              onClose={() => setEditSheetGrave(null)}
            />
          )}
          {mergeModalOpen && duplicateGroups.length > 0 && (
            <DuplicateMergeModal
              groups={duplicateGroups}
              onMerge={handleMergeDuplicates}
              onClose={() => setMergeModalOpen(false)}
            />
          )}
        </>
      }
    >
        {loading ? (
          <div className="flex items-center justify-center flex-1">
            <div className="w-6 h-6 border-2 border-gold-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : archiveTab === "markers" && graves.length === 0 ? (
          <EmptyState />
        ) : archiveTab === "markers" ? (
          <>
            {/* Failed Uploads — records that failed to process/upload */}
            {failedQueueItems.length > 0 && (
              <div className="mx-4 mt-4 mb-1">
                <div className="flex items-center justify-between mb-2 px-1">
                  <div className="flex items-center gap-2">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <p className="text-xs font-semibold uppercase tracking-widest text-stone-500">
                      Failed Scans · {failedQueueItems.length}
                    </p>
                  </div>
                  <button
                    onClick={async () => {
                      const { retryAllFailedItems } = await import("@/lib/queue");
                      retryAllFailedItems();
                    }}
                    className="text-xs text-gold-400 font-medium active:scale-95 transition-all"
                  >
                    Retry All
                  </button>
                </div>
                <div className="rounded-2xl overflow-hidden border border-red-900/30">
                  {failedQueueItems.map((item, i) => (
                    <div
                      key={item.id}
                      className={`flex items-center gap-3 px-3 py-3 ${i > 0 ? "border-t border-stone-850" : ""}`}
                      style={{ background: "rgba(239, 68, 68, 0.05)" }}
                    >
                      {/* Thumbnail */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={item.thumbnailDataUrl ?? item.photoDataUrl}
                        alt=""
                        className="w-12 h-12 rounded-xl object-cover shrink-0 opacity-70 border border-red-950/40"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-stone-300 text-sm font-medium truncate">
                          Offline Capture
                        </p>
                        <p className="text-red-400 text-xs mt-0.5 truncate">
                          Analysis failed after {item.retries} attempts
                        </p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          onClick={async () => {
                            const { retryQueueItem } = await import("@/lib/queue");
                            await retryQueueItem(item.id);
                          }}
                          className="text-xs font-medium px-2.5 py-1 rounded-lg bg-stone-850 text-stone-300 hover:bg-stone-800 active:scale-95 transition-all"
                        >
                          Retry
                        </button>
                        <button
                          onClick={async () => {
                            const { deleteQueueItem } = await import("@/lib/queue");
                            await deleteQueueItem(item.id);
                          }}
                          className="text-xs font-medium px-2 py-1 rounded-lg bg-red-950/20 text-red-400 hover:bg-red-950/45 active:scale-95 transition-all"
                          aria-label="Delete"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Assignment banner */}
            {showAssignBanner && (
              <div className="mx-4 mt-4 mb-1 flex items-center justify-between gap-3 px-4 py-3 rounded-2xl border border-gold-500/30 bg-gold-500/5 animate-fade-in">
                <div className="flex items-center gap-2 min-w-0">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--t-gold-500)" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M8 1.5C5.52 1.5 3.5 3.52 3.5 6c0 3.5 4.5 8.5 4.5 8.5s4.5-5 4.5-8.5c0-2.48-2.02-4.5-4.5-4.5z" strokeLinejoin="round" />
                    <circle cx="8" cy="6" r="1.5" />
                  </svg>
                  <p className="text-gold-300 text-xs leading-snug">
                    <span className="font-semibold">{assignmentQueue.length} marker{assignmentQueue.length !== 1 ? "s" : ""}</span>{" "}
                    without a cemetery name
                  </p>
                </div>
                <button
                  onClick={startAssignment}
                  className="shrink-0 text-xs font-semibold text-[#1a1917] px-3 py-1.5 rounded-lg"
                  style={{ background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }}
                >
                  Assign
                </button>
              </div>
            )}

            {/* Duplicate Scans Merge Banner */}
            {duplicateGroups.length > 0 && (
              <div className="mx-5 my-3 p-3 rounded-xl bg-gold-500/10 border border-gold-500/20 flex items-center justify-between gap-3 shadow-[0_4px_12px_rgba(201,168,76,0.05)] animate-fade-in">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="text-lg">✨</span>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-gold-400">Potential duplicates found</p>
                    <p className="text-[0.68rem] text-stone-500 truncate mt-0.5">
                      We identified {duplicateGroups.length} set{duplicateGroups.length > 1 ? "s" : ""} of potential duplicate scans of the same grave.
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setMergeModalOpen(true)}
                  className="shrink-0 text-[0.68rem] font-bold text-stone-900 bg-gold-400 px-3 py-1.5 rounded-lg active:bg-gold-500 transition-colors"
                >
                  Merge Scans
                </button>
              </div>
            )}

            {groupingMode === "flat" ? (
              <>
                {viewMode === "compact" && (
                  <GraveCompactList
                    graves={filteredGraves.slice(0, visibleCount)}
                    onDeleteRequest={setDeleteConfirm}
                    onDeleteConfirm={handleDelete}
                    onDeleteCancel={() => setDeleteConfirm(null)}
                    deleteConfirm={deleteConfirm}
                    onView={handleView}
                  />
                )}
                {viewMode === "list" && (
                  <GraveList
                    graves={filteredGraves.slice(0, visibleCount)}
                    enriching={enriching}
                    deleteConfirm={deleteConfirm}
                    onDeleteRequest={setDeleteConfirm}
                    onDeleteConfirm={handleDelete}
                    onDeleteCancel={() => setDeleteConfirm(null)}
                    onEdit={setEditSheetGrave}
                    viewedIds={viewedIds}
                    onView={handleView}
                  />
                )}
                {viewMode === "tile" && (
                  <GraveTileGrid
                    graves={filteredGraves.slice(0, visibleCount)}
                    enriching={enriching}
                    deleteConfirm={deleteConfirm}
                    onDeleteRequest={setDeleteConfirm}
                    onDeleteConfirm={handleDelete}
                    onDeleteCancel={() => setDeleteConfirm(null)}
                    viewedIds={viewedIds}
                    onView={handleView}
                  />
                )}
                {viewMode === "cover" && (
                  <GraveCoverFlow
                    graves={filteredGraves.slice(0, visibleCount)}
                    enriching={enriching}
                    deleteConfirm={deleteConfirm}
                    onDeleteRequest={setDeleteConfirm}
                    onDeleteConfirm={handleDelete}
                    onDeleteCancel={() => setDeleteConfirm(null)}
                    viewedIds={viewedIds}
                    onView={handleView}
                  />
                )}
                {/* Load More */}
                {filteredGraves.length > visibleCount && (
                  <div className="flex justify-center py-6">
                    <button
                      onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                      className="px-6 py-2.5 rounded-full text-sm font-semibold border border-stone-700 text-stone-300 hover:bg-stone-800 active:scale-95 transition-all"
                    >
                      Load more · {filteredGraves.length - visibleCount} remaining
                    </button>
                  </div>
                )}
              </>
            ) : groupingMode === "cemetery" ? (
              <div className="space-y-4 mt-2">
                {(groupedGraves as CemeteryGroup[]).map((group) => (
                  <div key={group.cemeteryName} className="mt-4 first:mt-0">
                    <div className="px-5 py-2.5 bg-stone-850/40 border-y border-stone-800/80 flex justify-between items-center">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">🪦</span>
                        <h4 className="text-xs font-bold text-stone-300 uppercase tracking-wide">{group.cemeteryName}</h4>
                      </div>
                      {group.locationDesc && (
                        <span className="text-[0.65rem] text-stone-500 font-medium">{group.locationDesc}</span>
                      )}
                    </div>
                    {viewMode === "compact" && (
                      <GraveCompactList
                        graves={group.graves}
                        deleteConfirm={deleteConfirm}
                        onDeleteRequest={setDeleteConfirm}
                        onDeleteConfirm={handleDelete}
                        onDeleteCancel={() => setDeleteConfirm(null)}
                        onView={handleView}
                      />
                    )}
                    {viewMode === "list" && (
                      <GraveList
                        graves={group.graves}
                        enriching={enriching}
                        deleteConfirm={deleteConfirm}
                        onDeleteRequest={setDeleteConfirm}
                        onDeleteConfirm={handleDelete}
                        onDeleteCancel={() => setDeleteConfirm(null)}
                        onEdit={setEditSheetGrave}
                        viewedIds={viewedIds}
                        onView={handleView}
                      />
                    )}
                    {viewMode === "tile" && (
                      <GraveTileGrid
                        graves={group.graves}
                        enriching={enriching}
                        deleteConfirm={deleteConfirm}
                        onDeleteRequest={setDeleteConfirm}
                        onDeleteConfirm={handleDelete}
                        onDeleteCancel={() => setDeleteConfirm(null)}
                        viewedIds={viewedIds}
                        onView={handleView}
                      />
                    )}
                    {viewMode === "cover" && (
                      <GraveCoverFlow
                        graves={group.graves}
                        enriching={enriching}
                        deleteConfirm={deleteConfirm}
                        onDeleteRequest={setDeleteConfirm}
                        onDeleteConfirm={handleDelete}
                        onDeleteCancel={() => setDeleteConfirm(null)}
                        viewedIds={viewedIds}
                        onView={handleView}
                      />
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-6 mt-2">
                {(groupedGraves as CemeteryFamilyGroup[]).map((group) => (
                  <div key={group.cemeteryName} className="mt-4 first:mt-0">
                    <div className="px-5 py-2.5 bg-stone-850/40 border-y border-stone-800/80 flex justify-between items-center">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">🪦</span>
                        <h4 className="text-xs font-bold text-stone-300 uppercase tracking-wide">{group.cemeteryName}</h4>
                      </div>
                      {group.locationDesc && (
                        <span className="text-[0.65rem] text-stone-500 font-medium">{group.locationDesc}</span>
                      )}
                    </div>
                    <div className="space-y-4 mt-3">
                      {group.families.map((fam) => (
                        <div key={fam.surname} className="pl-3 border-l-2 border-gold-500/20 ml-5 mr-5">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[0.68rem] font-bold text-gold-400/90 uppercase tracking-wider">
                              {fam.surname} Family
                            </span>
                            <span className="text-[0.6rem] text-stone-500 font-medium bg-stone-900 px-1.5 py-0.5 rounded-full border border-stone-800/80">
                              {fam.graves.length} {fam.graves.length === 1 ? "marker" : "markers"}
                            </span>
                          </div>
                          {viewMode === "compact" && (
                            <GraveCompactList
                              graves={fam.graves}
                              deleteConfirm={deleteConfirm}
                              onDeleteRequest={setDeleteConfirm}
                              onDeleteConfirm={handleDelete}
                              onDeleteCancel={() => setDeleteConfirm(null)}
                              onView={handleView}
                            />
                          )}
                          {viewMode === "list" && (
                            <GraveList
                              graves={fam.graves}
                              enriching={enriching}
                              deleteConfirm={deleteConfirm}
                              onDeleteRequest={setDeleteConfirm}
                              onDeleteConfirm={handleDelete}
                              onDeleteCancel={() => setDeleteConfirm(null)}
                              onEdit={setEditSheetGrave}
                              viewedIds={viewedIds}
                              onView={handleView}
                            />
                          )}
                          {viewMode === "tile" && (
                            <GraveTileGrid
                              graves={fam.graves}
                              enriching={enriching}
                              deleteConfirm={deleteConfirm}
                              onDeleteRequest={setDeleteConfirm}
                              onDeleteConfirm={handleDelete}
                              onDeleteCancel={() => setDeleteConfirm(null)}
                              viewedIds={viewedIds}
                              onView={handleView}
                            />
                          )}
                          {viewMode === "cover" && (
                            <GraveCoverFlow
                              graves={fam.graves}
                              enriching={enriching}
                              deleteConfirm={deleteConfirm}
                              onDeleteRequest={setDeleteConfirm}
                              onDeleteConfirm={handleDelete}
                              onDeleteCancel={() => setDeleteConfirm(null)}
                              viewedIds={viewedIds}
                              onView={handleView}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}

        {/* ── Review tab ── */}
        {!loading && archiveTab === "review" && (
          <div className="flex flex-col">
            {workingScans.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3 px-8">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--t-stone-600)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
                <p className="text-stone-400 text-sm font-semibold text-center">All caught up</p>
                <p className="text-stone-600 text-xs text-center leading-relaxed">
                  Records flagged for completion will appear here before moving to your archive.
                </p>
              </div>
            ) : (
              <>
                <div className="px-5 pt-5 pb-2 flex items-center justify-between gap-3">
                  <p className="text-stone-500 text-xs leading-relaxed">
                    {workingScans.length} {workingScans.length === 1 ? "record" : "records"} pending — tap any entry to complete it.
                  </p>
                  {bulkEnriching && (
                    <span className="flex items-center gap-1.5 text-stone-600 text-xs shrink-0">
                      <span className="w-3 h-3 border border-stone-600 border-t-transparent rounded-full animate-spin" />
                      Updating…
                    </span>
                  )}
                </div>
                <div className="divide-y divide-stone-800/60">
                  {workingScans.map((g) => {
                    const hasDates = g.extracted.birthYear != null || g.extracted.deathYear != null;
                    const hasName = !!g.extracted.name;
                    const hasCemetery = !!g.location?.cemetery;
                    const isLowConfidence = g.extracted.confidence === "low";
                    const hasUnusualChars = !!g.extracted.name && !TYPICAL_NAME_RE.test(g.extracted.name);
                    const dateRange = hasDates
                      ? [g.extracted.birthYear ?? "?", g.extracted.deathYear ?? "?"].join(" – ")
                      : null;
                    const locationLine = [g.location?.cemetery, g.location?.city, g.location?.state]
                      .filter(Boolean).join(", ");

                    return (
                      <Link
                        key={g.id}
                        href={`/result/${g.id}`}
                        className="flex items-start gap-4 px-5 py-4 active:bg-white/5"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={g.thumbnailDataUrl ?? g.photoDataUrl}
                          alt=""
                          className="w-14 h-14 rounded-xl object-cover shrink-0 opacity-90 mt-0.5"
                          loading="lazy"
                        />
                        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                          <p className="text-stone-200 text-sm font-semibold leading-snug flex items-center gap-1.5 flex-wrap">
                            {hasName ? g.extracted.name : <span className="text-stone-500 italic font-normal">Name unknown</span>}
                            {g.extracted.people && g.extracted.people.length > 1 && (
                              <span className="px-1.5 py-0.5 rounded text-[0.62rem] font-semibold bg-stone-700/80 text-stone-300 font-sans">
                                +{g.extracted.people.length - 1} person
                              </span>
                            )}
                          </p>
                          {dateRange && (
                            <p className="text-stone-400 text-xs">{dateRange}</p>
                          )}
                          <p className="text-stone-500 text-xs truncate">
                            {locationLine || "Location unknown"}
                          </p>
                          {/* Review-reason badges */}
                          <div className="flex flex-wrap gap-1 mt-1">
                            {!hasName && (
                              <span className="text-[0.6rem] px-1.5 py-0.5 rounded bg-amber-500/12 text-amber-400 font-bold uppercase tracking-wide">Name</span>
                            )}
                            {!hasDates && (
                              <span className="text-[0.6rem] px-1.5 py-0.5 rounded bg-stone-700/80 text-stone-400 font-bold uppercase tracking-wide">Dates</span>
                            )}
                            {!hasCemetery && (
                              <span className="text-[0.6rem] px-1.5 py-0.5 rounded bg-stone-700/80 text-stone-400 font-bold uppercase tracking-wide">Cemetery</span>
                            )}
                            {isLowConfidence && (
                              <span className="text-[0.6rem] px-1.5 py-0.5 rounded bg-amber-500/12 text-amber-400 font-bold uppercase tracking-wide">Low confidence</span>
                            )}
                            {hasUnusualChars && (
                              <span className="text-[0.6rem] px-1.5 py-0.5 rounded bg-amber-500/12 text-amber-400 font-bold uppercase tracking-wide">Verify text</span>
                            )}
                          </div>
                        </div>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--t-stone-600)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-1">
                          <polyline points="9 18 15 12 9 6"/>
                        </svg>
                      </Link>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Places tab ── */}
        {!loading && archiveTab === "places" && (
          <CemeterySection
            cemeteries={derivedPlaces}
            graves={graves}
            onDelete={async (id) => {
              if (!id.startsWith("gl_derived_")) {
                await deleteCemetery(id);
              }
              setCemeteries((prev) => prev.filter((c) => c.id !== id));
            }}
            onRefresh={async (updated) => {
              await saveCemetery(updated);
              setCemeteries((prev) => {
                const idx = prev.findIndex((c) => c.id === updated.id);
                if (idx >= 0) {
                  const next = [...prev];
                  next[idx] = updated;
                  return next;
                }
                // Derived record promoted to real IDB record — add it
                return [...prev, updated];
              });
            }}
          />
        )}
      

      </PageShell>
  );
}

// ── AssignmentSheet ────────────────────────────────────────────────────────
function AssignmentSheet({
  grave,
  value,
  onChange,
  onSave,
  onSkip,
  current,
  total,
}: {
  grave: GraveRecord;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onSkip: () => void;
  current: number;
  total: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 100); }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-end lg:items-center lg:p-6">
      <div className="absolute inset-0 bg-black/60" onClick={onSkip} />
      <div
        className="relative w-full max-w-sm mx-auto bg-stone-800 rounded-t-3xl lg:rounded-2xl animate-fade-up"
        style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div className="w-10 h-1 bg-stone-600 rounded-full mx-auto mt-3 mb-5" />

        <div className="px-6 pb-2">
          {/* Progress */}
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-serif text-stone-100 text-lg">Name this cemetery</h3>
            {total > 1 && (
              <span className="text-stone-500 text-xs">{current} of {total}</span>
            )}
          </div>

          {/* Grave preview */}
          <div className="flex items-center gap-3 mb-5 p-3 rounded-xl bg-stone-700/50">
            <div className="w-12 h-12 rounded-lg overflow-hidden bg-stone-700 shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={grave.thumbnailDataUrl ?? grave.photoDataUrl} alt="" className="w-full h-full object-cover" />
            </div>
            <div className="min-w-0">
              <p className="font-serif text-stone-200 font-medium truncate">
                {grave.extracted.name || "Unknown"}
              </p>
              <p className="text-stone-500 text-xs mt-0.5">
                {formatDates(grave.extracted)}
              </p>
            </div>
          </div>

          {/* Input */}
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onSave(); if (e.key === "Escape") onSkip(); }}
            placeholder="e.g. Oak Hill Cemetery"
            className="w-full bg-stone-700 border border-stone-600 text-stone-100 text-sm rounded-xl px-4 py-3 placeholder:text-stone-500 outline-none focus:border-gold-500 mb-4"
          />

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={onSave}
              disabled={!value.trim()}
              className="flex-1 h-12 rounded-xl font-semibold text-[#1a1917] text-sm disabled:opacity-40 transition-all active:scale-[0.98]"
              style={{ background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }}
            >
              Save
            </button>
            <button
              onClick={onSkip}
              className="flex-1 h-12 rounded-xl text-sm text-stone-400 bg-stone-700"
            >
              Skip
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── NearbyConfirmSheet ─────────────────────────────────────────────────────
function NearbyConfirmSheet({
  cemeteryName,
  nearby,
  onYes,
  onNo,
}: {
  cemeteryName: string;
  nearby: GraveRecord[];
  onYes: () => void;
  onNo: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end lg:items-center lg:p-6">
      <div className="absolute inset-0 bg-black/60" onClick={onNo} />
      <div
        className="relative w-full max-w-sm mx-auto bg-stone-800 rounded-t-3xl lg:rounded-2xl animate-fade-up"
        style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-stone-600 rounded-full mx-auto mt-3 mb-5" />

        <div className="px-6 pb-2">
          <h3 className="font-serif text-stone-100 text-lg mb-1">
            {nearby.length} nearby marker{nearby.length !== 1 ? "s" : ""} found
          </h3>
          <p className="text-stone-400 text-sm mb-5">
            Apply <span className="text-gold-400 font-medium">&quot;{cemeteryName}&quot;</span> to{" "}
            {nearby.length === 1 ? "this marker" : "these markers"} too?
          </p>

          {/* Nearby grave list */}
          <div className="flex flex-col gap-2 mb-5">
            {nearby.map((g) => (
              <div key={g.id} className="flex items-center gap-3 p-3 rounded-xl bg-stone-700/50">
                <div className="w-10 h-10 rounded-lg overflow-hidden bg-stone-700 shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={g.thumbnailDataUrl ?? g.photoDataUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                </div>
                <div className="min-w-0">
                  <p className="text-stone-200 text-sm font-medium truncate">
                    {g.extracted.name || "Unknown"}
                  </p>
                  <p className="text-stone-500 text-xs">
                    {formatDates(g.extracted)}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={onYes}
              className="flex-1 h-12 rounded-xl font-semibold text-[#1a1917] text-sm transition-all active:scale-[0.98]"
              style={{ background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }}
            >
              Yes, apply to all
            </button>
            <button
              onClick={onNo}
              className="flex-1 h-12 rounded-xl text-sm text-stone-400 bg-stone-700"
            >
              Ask individually
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── GraveTileGrid ──────────────────────────────────────────────────────────
function GraveTileGrid({
  graves,
  enriching,
  deleteConfirm,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
  viewedIds,
  onView,
}: {
  graves: GraveRecord[];
  enriching: boolean;
  deleteConfirm: string | null;
  onDeleteRequest: (id: string) => void;
  onDeleteConfirm: (id: string) => void;
  onDeleteCancel: () => void;
  viewedIds: Set<string>;
  onView: (id: string) => void;
}) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setNow(Date.now()), 0);
    return () => clearTimeout(t);
  }, []);

  if (graves.length === 0) {
    return (
      <div className="flex items-center justify-center flex-1 mt-16">
        <p className="text-stone-500 text-sm">No markers match the current filters.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 p-4 mt-2">
      {graves.map((grave) => {
        const hasCemetery = Boolean(grave.location?.cemetery);
        const hasGps = Boolean(grave.location?.lat && grave.location?.lng);
        const dates = formatDates(grave.extracted);
        const isNew = now > 0 && now - grave.timestamp < RECENT_DAYS && !viewedIds.has(grave.id);

        return (
          <div key={grave.id} className="relative">
            <Link href={`/result/${grave.id}`} className="block" onClick={() => onView(grave.id)}>
              <div
                className="rounded-2xl overflow-hidden bg-stone-800 relative"
                style={{ aspectRatio: "3/4" }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={grave.thumbnailDataUrl ?? grave.photoDataUrl}
                  alt={grave.extracted.name ?? ""}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
                <div
                  className="absolute inset-0"
                  style={{
                    background:
                      "linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.3) 45%, transparent 70%)",
                  }}
                />
                <div className="absolute bottom-0 left-0 right-0 p-3">
                  <p className="font-serif text-white text-sm font-medium leading-tight line-clamp-2">
                    {grave.extracted.name || "Unknown"}
                  </p>
                  {grave.extracted.people && grave.extracted.people.length > 1 && (
                    <span className="inline-block mt-1 px-1.5 py-0.5 rounded text-[0.62rem] font-semibold bg-stone-700/80 text-stone-300">
                      +{grave.extracted.people.length - 1} person
                    </span>
                  )}
                  {dates && (
                    <p className="text-stone-400 text-[0.8rem] mt-0.5">{dates}</p>
                  )}
                  {hasCemetery ? (
                    <p className="text-stone-500 text-[0.75rem] truncate mt-0.5">
                      {grave.location.cemetery}
                    </p>
                  ) : enriching && hasGps ? (
                    <p className="text-stone-600 text-[0.75rem] mt-0.5">Looking up…</p>
                  ) : null}
                  {grave.tags && grave.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {grave.tags.slice(0, 2).map((tag) => (
                        <span
                          key={tag}
                          className="px-1.5 py-0.5 rounded-full text-[0.65rem] bg-stone-800/80 border border-stone-600/60 text-stone-400"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </Link>

            {isNew && (
              <div className="absolute top-2 left-2 z-10 pointer-events-none">
                <span className="px-1.5 py-0.5 rounded text-[0.75rem] font-bold uppercase tracking-wide" style={{ background: "rgba(201,168,76,0.18)", color: "var(--t-gold-500)", border: "1px solid rgba(201,168,76,0.35)" }}>New</span>
              </div>
            )}

            {/* Delete button — top-right corner */}
            <div className="absolute top-2 right-2 z-10">
              {deleteConfirm === grave.id ? (
                <div className="flex gap-1">
                  <button
                    onClick={() => onDeleteConfirm(grave.id)}
                    className="text-[0.75rem] text-red-400 px-2 py-1 rounded-lg bg-stone-900/90 border border-red-500/30"
                  >
                    Delete
                  </button>
                  <button
                    onClick={onDeleteCancel}
                    className="text-[0.75rem] text-stone-400 px-2 py-1 rounded-lg bg-stone-900/90"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => onDeleteRequest(grave.id)}
                  className="w-7 h-7 flex items-center justify-center rounded-full bg-stone-900/70 text-stone-500 active:text-red-400"
                  aria-label="Delete grave"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── GraveCoverFlow ─────────────────────────────────────────────────────────
function GraveCoverFlow({
  graves,
  enriching,
  deleteConfirm,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
  viewedIds,
  onView,
}: {
  graves: GraveRecord[];
  enriching: boolean;
  deleteConfirm: string | null;
  onDeleteRequest: (id: string) => void;
  onDeleteConfirm: (id: string) => void;
  onDeleteCancel: () => void;
  viewedIds: Set<string>;
  onView: (id: string) => void;
}) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setNow(Date.now()), 0);
    return () => clearTimeout(t);
  }, []);

  if (graves.length === 0) {
    return (
      <div className="flex items-center justify-center flex-1 mt-16">
        <p className="text-stone-500 text-sm">No markers match the current filters.</p>
      </div>
    );
  }

  return (
    <div
      className="flex overflow-x-auto gap-4 mt-4 pb-4"
      style={{
        scrollSnapType: "x mandatory",
        WebkitOverflowScrolling: "touch",
        scrollbarWidth: "none",
        paddingLeft: "calc(50vw - 42vw)",
        paddingRight: "calc(50vw - 42vw)",
      }}
    >
      {graves.map((grave) => {
        const hasGps = Boolean(grave.location?.lat && grave.location?.lng);
        const dates = formatDates(grave.extracted);
        const locationLine = [grave.location?.cemetery, grave.location?.city, grave.location?.state]
          .filter(Boolean)
          .join(", ");
        const isNew = now > 0 && now - grave.timestamp < RECENT_DAYS && !viewedIds.has(grave.id);

        return (
          <div
            key={grave.id}
            className="relative shrink-0"
            style={{
              width: "84vw",
              maxWidth: "360px",
              scrollSnapAlign: "center",
            }}
          >
            <Link href={`/result/${grave.id}`} className="block" onClick={() => onView(grave.id)}>
              <div
                className="rounded-3xl overflow-hidden bg-stone-800 relative"
                style={{ height: "64vh", minHeight: "340px", maxHeight: "520px" }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={grave.thumbnailDataUrl ?? grave.photoDataUrl}
                  alt={grave.extracted.name ?? ""}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
                {/* Gradient overlay */}
                <div
                  className="absolute inset-0"
                  style={{
                    background:
                      "linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.45) 40%, rgba(0,0,0,0.1) 65%, transparent 85%)",
                  }}
                />
                {/* Content */}
                <div className="absolute bottom-0 left-0 right-0 p-6">
                  <h2 className="font-serif text-white text-2xl font-bold leading-tight">
                    {grave.extracted.name || "Unknown"}
                  </h2>
                  {grave.extracted.people && grave.extracted.people.length > 1 && (
                    <span className="inline-block mt-1.5 px-2 py-0.5 rounded text-xs font-semibold bg-stone-800/80 text-stone-300">
                      +{grave.extracted.people.length - 1} person
                    </span>
                  )}
                  {dates && (
                    <p className="text-stone-300 text-sm mt-1.5">{dates}</p>
                  )}
                  {locationLine ? (
                    <p className="text-stone-400 text-xs mt-1 truncate">{locationLine}</p>
                  ) : enriching && hasGps ? (
                    <p className="text-stone-600 text-xs mt-1">Looking up cemetery…</p>
                  ) : null}
                  {grave.tags && grave.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {grave.tags.map((tag) => (
                        <span
                          key={tag}
                          className="px-2 py-0.5 rounded-full text-[0.75rem] border text-stone-300"
                          style={{
                            background: "rgba(201,168,76,0.12)",
                            borderColor: "rgba(201,168,76,0.3)",
                          }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </Link>

            {isNew && (
              <div className="absolute top-3 left-3 z-10 pointer-events-none">
                <span className="px-1.5 py-0.5 rounded text-[0.75rem] font-bold uppercase tracking-wide" style={{ background: "rgba(201,168,76,0.18)", color: "var(--t-gold-500)", border: "1px solid rgba(201,168,76,0.35)" }}>New</span>
              </div>
            )}

            {/* Delete — top-right */}
            <div className="absolute top-3 right-3 z-10">
              {deleteConfirm === grave.id ? (
                <div className="flex gap-1.5">
                  <button
                    onClick={() => onDeleteConfirm(grave.id)}
                    className="text-xs text-red-400 px-3 py-1.5 rounded-xl bg-stone-900/90 border border-red-500/30"
                  >
                    Delete
                  </button>
                  <button
                    onClick={onDeleteCancel}
                    className="text-xs text-stone-400 px-3 py-1.5 rounded-xl bg-stone-900/90"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => onDeleteRequest(grave.id)}
                  className="w-8 h-8 flex items-center justify-center rounded-full bg-stone-900/70 text-stone-500 active:text-red-400"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── EmptyState ─────────────────────────────────────────────────────────────
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-5 px-10 text-center animate-fade-in">
      <div className="w-20 h-20 rounded-full bg-stone-800/40 flex items-center justify-center border border-stone-800/60 shadow-inner">
        <ThematicIllustration type="stone" size={40} />
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="font-serif text-stone-200 text-xl font-medium leading-tight">Your archive is empty</h2>
        <p className="text-stone-500 text-sm leading-relaxed max-w-[240px] mx-auto">
          When you photograph and save a grave marker, it will appear here.
        </p>
      </div>
      <Link
        href="/"
        className="mt-2 h-12 px-6 rounded-2xl flex items-center justify-center font-semibold text-[#1a1917] transition-all active:scale-[0.98]"
        style={{ background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }}
      >
        Scan your first marker
      </Link>
    </div>
  );
}

// ── GraveList ──────────────────────────────────────────────────────────────
function GraveList({
  graves,
  enriching,
  deleteConfirm,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
  onEdit,
  viewedIds,
  onView,
}: {
  graves: GraveRecord[];
  enriching: boolean;
  deleteConfirm: string | null;
  onDeleteRequest: (id: string) => void;
  onDeleteConfirm: (id: string) => void;
  onDeleteCancel: () => void;
  onEdit?: (grave: GraveRecord) => void;
  viewedIds: Set<string>;
  onView: (id: string) => void;
}) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setNow(Date.now()), 0);
    return () => clearTimeout(t);
  }, []);
  if (graves.length === 0) {
    return (
      <div className="flex items-center justify-center flex-1 mt-16">
        <p className="text-stone-500 text-sm">No markers match the current filters.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-stone-800 mt-2">
      {graves.map((grave) => {
        const hasCemetery = Boolean(grave.location?.cemetery);
        const hasGps = Boolean(grave.location?.lat && grave.location?.lng);
        const isNew = now - grave.timestamp < RECENT_DAYS && !viewedIds.has(grave.id);

        return (
          <div key={grave.id} className="flex items-center gap-3 px-5 py-4">
            <Link href={`/result/${grave.id}`} className="flex items-center gap-3 flex-1 min-w-0" onClick={() => onView(grave.id)}>
              <div className="w-14 h-14 rounded-xl overflow-hidden bg-stone-800 shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={grave.thumbnailDataUrl ?? grave.photoDataUrl} alt={grave.extracted.name} className="w-full h-full object-cover" loading="lazy" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="font-serif text-stone-100 font-medium truncate flex items-center gap-1.5">
                    {grave.extracted.name || "Unknown"}
                    {grave.extracted.people && grave.extracted.people.length > 1 && (
                      <span className="shrink-0 px-1.5 py-0.5 rounded text-[0.62rem] font-semibold bg-stone-700/80 text-stone-300 font-sans">
                        +{grave.extracted.people.length - 1} person
                      </span>
                    )}
                    {grave.researchOnly && (
                      <span className="shrink-0 px-1.5 py-0.5 rounded text-[0.62rem] font-semibold font-sans uppercase tracking-wide" style={{ background: "rgba(201,168,76,0.14)", color: "var(--t-gold-500)" }}>
                        Research
                      </span>
                    )}
                  </p>
                  {isNew && (
                    <span className="shrink-0 px-1.5 py-0.5 rounded text-[0.75rem] font-bold uppercase tracking-wide" style={{ background: "rgba(201,168,76,0.18)", color: "var(--t-gold-500)", border: "1px solid rgba(201,168,76,0.35)" }}>New</span>
                  )}
                </div>
                <p className="text-stone-500 text-xs mt-0.5">
                  {formatDates(grave.extracted)}
                </p>
                {hasCemetery || grave.location?.city ? (
                  <p className="text-stone-600 text-xs truncate mt-0.5">
                    {[grave.location.cemetery, grave.location.city, grave.location.state].filter(Boolean).join(", ")}
                  </p>
                ) : enriching && hasGps ? (
                  <span className="text-stone-600 text-xs mt-0.5">Looking up cemetery…</span>
                ) : null}
                {grave.tags && grave.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {grave.tags.map((tag) => (
                      <span key={tag} className="px-1.5 py-0.5 rounded-full text-[0.75rem] bg-stone-800 border border-stone-700 text-stone-500">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </Link>

            <div className="flex items-center gap-1 shrink-0">
              {deleteConfirm === grave.id ? (
                <div className="flex gap-2">
                  <button onClick={() => onDeleteConfirm(grave.id)} className="text-xs text-red-400 px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/20">
                    Delete
                  </button>
                  <button onClick={onDeleteCancel} className="text-xs text-stone-400">Cancel</button>
                </div>
              ) : (
                <>
                  {onEdit && (
                    <button
                      onClick={() => onEdit(grave)}
                      className="w-10 h-10 flex items-center justify-center text-stone-600 active:text-stone-300 rounded-lg"
                      aria-label="Edit details"
                    >
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                      </svg>
                    </button>
                  )}
                  <button onClick={() => onDeleteRequest(grave.id)} className="w-10 h-10 flex items-center justify-center text-stone-600 active:text-red-400 rounded-lg" aria-label="Delete grave">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                    </svg>
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── GraveCompactList — dense 48px single-line rows ────────────────────────────
function GraveCompactList({
  graves,
  deleteConfirm,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
  onView,
}: {
  graves: GraveRecord[];
  deleteConfirm: string | null;
  onDeleteRequest: (id: string) => void;
  onDeleteConfirm: (id: string) => void;
  onDeleteCancel: () => void;
  onView: (id: string) => void;
}) {
  if (graves.length === 0) {
    return (
      <div className="flex items-center justify-center flex-1 mt-16">
        <p className="text-stone-500 text-sm">No markers match the current filters.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-stone-800/60 mt-1">
      {graves.map((grave) => {
        const name = grave.extracted.name || "Unknown";
        const dates = (() => {
          if (grave.extracted.birthYear != null || grave.extracted.deathYear != null) {
            return `${grave.extracted.birthYear ?? "?"} – ${grave.extracted.deathYear ?? "?"}`;
          }
          return null;
        })();
        const location = [grave.location?.cemetery, grave.location?.state].filter(Boolean).join(", ");
        const extraPeople = (grave.extracted.people?.length ?? 0) - 1;

        return (
          <div key={grave.id} className="flex items-center gap-2.5 px-4 py-0" style={{ minHeight: "48px" }}>
            <Link
              href={`/result/${grave.id}`}
              className="flex items-center gap-2.5 flex-1 min-w-0 py-2"
              onClick={() => onView(grave.id)}
            >
              {/* Tiny thumbnail */}
              <div className="w-8 h-8 rounded-lg overflow-hidden bg-stone-800 shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={grave.thumbnailDataUrl ?? grave.photoDataUrl}
                  alt=""
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              </div>
              {/* Name */}
              <p className="font-serif text-stone-200 text-sm truncate flex-1 min-w-0">
                {name}
                {extraPeople > 0 && (
                  <span className="ml-1 text-[0.6rem] font-semibold text-stone-500 font-sans">+{extraPeople}</span>
                )}
              </p>
              {/* Dates — hidden on very small screens */}
              {dates && (
                <span className="hidden xs:block text-stone-500 text-[0.72rem] shrink-0 tabular-nums">{dates}</span>
              )}
              {/* Cemetery/State */}
              {location && (
                <span className="text-stone-600 text-[0.72rem] shrink-0 truncate max-w-[30%] hidden sm:block">{location}</span>
              )}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--t-stone-700)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </Link>
            {/* Delete action */}
            {deleteConfirm === grave.id ? (
              <div className="flex gap-1.5 shrink-0">
                <button onClick={() => onDeleteConfirm(grave.id)} className="text-[0.7rem] text-red-400 px-2 py-1 rounded-md bg-red-500/10 border border-red-500/20">Delete</button>
                <button onClick={onDeleteCancel} className="text-[0.7rem] text-stone-500">Cancel</button>
              </div>
            ) : (
              <button
                onClick={() => onDeleteRequest(grave.id)}
                className="shrink-0 w-8 h-8 flex items-center justify-center text-stone-700 active:text-red-400 rounded-lg"
                aria-label="Delete"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                </svg>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Cemetery / Places section ────────────────────────────────────────────────

function CemeterySection({
  cemeteries,
  graves,
  onDelete,
  onRefresh,
}: {
  cemeteries: CemeteryRecord[];
  graves: GraveRecord[];
  onDelete: (id: string) => Promise<void>;
  onRefresh: (updated: CemeteryRecord) => Promise<void>;
}) {
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [goals, setGoals] = useState<Record<string, number>>(() =>
    typeof window !== "undefined" ? loadGoals() : {}
  );
  const [goalEditing, setGoalEditing] = useState<string | null>(null);
  const [goalInput, setGoalInput] = useState("");

  if (cemeteries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 px-8 py-20 text-center">
        <div className="w-16 h-16 rounded-2xl bg-stone-800 border border-stone-700 flex items-center justify-center">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6a6560" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 21h12"/><path d="M7 21v-8a5 5 0 0 1 10 0v8"/><path d="M12 7v4"/><path d="M10 9h4"/>
          </svg>
        </div>
        <div>
          <p className="text-stone-300 font-semibold text-base">No places yet</p>
          <p className="text-stone-500 text-sm mt-1 leading-relaxed">
            Cemetery records are created automatically when you scan a grave marker at a new location.
          </p>
        </div>
      </div>
    );
  }

  const handleRefresh = async (c: CemeteryRecord) => {
    setRefreshingId(c.id);
    try {
      const res = await fetch("/api/enrich-cemetery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: c.name, lat: c.lat, lng: c.lng, force: true }),
      });
      if (!res.ok) return;
      const enriched = await res.json();
      const stableId = c.id.startsWith("gl_derived_") ? cemeteryId(c.name, c.lat, c.lng, enriched.osmId) : c.id;
      const updated: CemeteryRecord = {
        ...c,
        id: stableId,
        osmId: enriched.osmId ?? undefined,
        openingHours: enriched.openingHours ?? undefined,
        phone: enriched.phone ?? undefined,
        website: enriched.website ?? undefined,
        wikipediaUrl: enriched.wikipediaUrl ?? undefined,
        denomination: enriched.denomination ?? undefined,
        established: enriched.established ?? undefined,
        description: enriched.description ?? undefined,
        notableFeatures: enriched.notableFeatures ?? undefined,
        historicalEvents: enriched.historicalEvents ?? undefined,
        visitCount: c.visitCount,
        firstVisited: c.firstVisited,
        lastVisited: c.lastVisited,
      };
      await onRefresh(updated);
    } catch { /* non-fatal */ } finally {
      setRefreshingId(null);
    }
  };

  return (
    <div className="flex flex-col divide-y divide-stone-800">
      {cemeteries.map((c) => {
        const appleUrl = `https://maps.apple.com/?q=${encodeURIComponent(c.name)}&ll=${c.lat},${c.lng}`;
        const googleUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.name)}&center=${c.lat},${c.lng}`;
        const firstDate = new Date(c.firstVisited).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        const lastDate = new Date(c.lastVisited).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

        // Derive location + grave count from the graves archive
        const cGraves = graves.filter((g) => g.location?.cemetery?.toLowerCase().trim() === c.name.toLowerCase().trim());
        const graveCount = cGraves.length;
        const sample = cGraves[0];
        const city = sample?.location?.city;
        const state = sample?.location?.state;
        const locationLine = [city, state].filter(Boolean).join(", ");

        const hasEnrichment = !!(c.description || c.openingHours || c.phone || c.website || c.wikipediaUrl || c.established || c.denomination || c.notableFeatures?.length || c.historicalEvents?.length);
        const isRefreshing = refreshingId === c.id;

        return (
          <div key={c.id} className="px-5 py-5 flex flex-col gap-3">
            {/* Name + badge row */}
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="font-serif text-stone-100 text-base font-semibold leading-snug">{c.name}</p>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                  {locationLine && <span className="text-[0.8rem] text-stone-400">{locationLine}</span>}
                  {c.established && <span className="text-[0.8rem] text-stone-400">Est. {c.established}</span>}
                  {c.denomination && <span className="text-[0.8rem] text-stone-400 capitalize">{c.denomination}</span>}
                  {graveCount > 0 && (
                    <span className="text-[0.8rem] text-stone-500">
                      {graveCount} {graveCount === 1 ? "marker" : "markers"} in archive
                    </span>
                  )}
                </div>
              </div>
              <div className="shrink-0 flex items-center gap-2">
                {/* Visit badge */}
                <div className="flex flex-col items-center px-2 py-1 rounded-lg bg-stone-800 border border-stone-700 min-w-[44px]">
                  <span className="text-xs font-bold" style={{ color: "var(--t-gold-500)" }}>{c.visitCount}</span>
                  <span className="text-[0.65rem] text-stone-500 uppercase tracking-wide">{c.visitCount === 1 ? "visit" : "visits"}</span>
                </div>
                {/* Refresh info */}
                <button
                  onClick={() => handleRefresh(c)}
                  disabled={isRefreshing}
                  title={hasEnrichment ? "Refresh info" : "Look up cemetery info"}
                  className="w-8 h-8 flex items-center justify-center text-stone-500 active:text-stone-200 rounded-lg disabled:opacity-40"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={isRefreshing ? "animate-spin" : ""}>
                    <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                  </svg>
                </button>
                {/* Delete — only for IDB-backed records, not derived entries */}
                {!c.id.startsWith("gl_derived_") && (
                  deleteId === c.id ? (
                    <div className="flex gap-1">
                      <button onClick={() => onDelete(c.id).then(() => setDeleteId(null))} className="text-xs text-red-400 px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/20">Delete</button>
                      <button onClick={() => setDeleteId(null)} className="text-xs text-stone-500">Cancel</button>
                    </div>
                  ) : (
                    <button onClick={() => setDeleteId(c.id)} className="w-8 h-8 flex items-center justify-center text-stone-500 active:text-red-400 rounded-lg" aria-label="Delete cemetery">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                      </svg>
                    </button>
                  )
                )}
              </div>
            </div>

            {/* Completion tracker */}
            {(() => {
              const goal = goals[c.id];
              const pct = goal ? Math.min(100, Math.round((graveCount / goal) * 100)) : null;
              const isEditingGoal = goalEditing === c.id;

              return (
                <div className="flex flex-col gap-2">
                  {goal && pct !== null && (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-stone-400">
                          {graveCount} of {goal} documented
                        </span>
                        <span className="text-xs font-semibold" style={{ color: pct >= 100 ? "#92cc92" : "var(--t-gold-500)" }}>
                          {pct}%
                        </span>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-stone-700">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${pct}%`,
                            background: pct >= 100 ? "#92cc92" : "var(--t-gold-500)",
                          }}
                        />
                      </div>
                    </div>
                  )}
                  {isEditingGoal ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        value={goalInput}
                        onChange={(e) => setGoalInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const n = parseInt(goalInput, 10);
                            if (n > 0) { saveGoal(c.id, n); setGoals((g) => ({ ...g, [c.id]: n })); }
                            setGoalEditing(null); setGoalInput("");
                          }
                          if (e.key === "Escape") { setGoalEditing(null); setGoalInput(""); }
                        }}
                        placeholder="e.g. 250"
                        className="flex-1 bg-stone-700 border border-stone-600 text-stone-100 text-xs rounded-lg px-3 py-2 outline-none placeholder:text-stone-500"
                        autoFocus
                      />
                      <button
                        onClick={() => {
                          const n = parseInt(goalInput, 10);
                          if (n > 0) { saveGoal(c.id, n); setGoals((g) => ({ ...g, [c.id]: n })); }
                          setGoalEditing(null); setGoalInput("");
                        }}
                        className="px-3 py-2 rounded-lg text-xs font-semibold"
                        style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
                      >
                        Set
                      </button>
                      {goal && (
                        <button
                          onClick={() => { removeGoal(c.id); setGoals((g) => { const n = { ...g }; delete n[c.id]; return n; }); setGoalEditing(null); setGoalInput(""); }}
                          className="px-2 py-2 rounded-lg text-xs text-stone-500 active:text-red-400"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  ) : (
                    <button
                      onClick={() => { setGoalEditing(c.id); setGoalInput(goal ? String(goal) : ""); }}
                      className="self-start text-xs text-stone-500 active:text-stone-300 transition-colors flex items-center gap-1"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
                      </svg>
                      {goal ? "Edit goal" : "Set documentation goal"}
                    </button>
                  )}
                </div>
              );
            })()}

            {/* Hours, phone, website, Wikipedia */}
            {(c.openingHours || c.phone || c.website || c.wikipediaUrl) && (
              <div className="flex flex-col gap-1.5">
                {c.openingHours && (
                  <div className="flex items-start gap-2">
                    <span className="text-stone-500 text-xs mt-0.5 shrink-0">🕐</span>
                    <span className="text-stone-400 text-xs leading-relaxed">{formatOpeningHours(c.openingHours)}</span>
                  </div>
                )}
                {c.phone && (
                  <div className="flex items-center gap-2">
                    <span className="text-stone-500 text-xs shrink-0">📞</span>
                    <a href={`tel:${c.phone}`} className="text-xs" style={{ color: "var(--t-gold-500)" }}>{c.phone}</a>
                  </div>
                )}
                {c.website && (
                  <div className="flex items-center gap-2">
                    <span className="text-stone-500 text-xs shrink-0">🌐</span>
                    <a href={c.website} target="_blank" rel="noopener noreferrer" className="text-xs truncate" style={{ color: "var(--t-gold-500)" }}>
                      {c.website.replace(/^https?:\/\/(www\.)?/, "")}
                    </a>
                  </div>
                )}
                {c.wikipediaUrl && (
                  <div className="flex items-center gap-2">
                    <span className="text-stone-500 text-xs shrink-0">📖</span>
                    <a href={c.wikipediaUrl} target="_blank" rel="noopener noreferrer" className="text-xs" style={{ color: "var(--t-gold-500)" }}>
                      Wikipedia article
                    </a>
                  </div>
                )}
              </div>
            )}

            {/* Description */}
            {c.description && (
              <p className="text-stone-300 text-sm leading-relaxed">{c.description}</p>
            )}

            {/* Notable features */}
            {c.notableFeatures && c.notableFeatures.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-[0.75rem] uppercase tracking-widest text-stone-400 font-semibold">Notable Features</p>
                {c.notableFeatures.map((f, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="text-stone-500 text-xs mt-0.5 shrink-0">•</span>
                    <span className="text-stone-300 text-xs leading-relaxed">{f}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Historical events */}
            {c.historicalEvents && c.historicalEvents.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-[0.75rem] uppercase tracking-widest text-stone-400 font-semibold">Historical Events</p>
                {c.historicalEvents.map((e, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="text-[0.75rem] mt-0.5 shrink-0">📜</span>
                    <span className="text-stone-300 text-xs leading-relaxed">{e}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Navigation buttons */}
            <div className="flex gap-2 mt-1">
              <a href={appleUrl} target="_blank" rel="noopener noreferrer"
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[0.8rem] font-semibold text-stone-200 border border-stone-700 bg-stone-800 active:bg-stone-700 transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#007AFF"/><path d="M12 7l4 10-4-2-4 2 4-10z" fill="white"/></svg>
                Apple Maps
              </a>
              <a href={googleUrl} target="_blank" rel="noopener noreferrer"
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[0.8rem] font-semibold text-stone-200 border border-stone-700 bg-stone-800 active:bg-stone-700 transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#4285F4"/><circle cx="12" cy="9" r="2.5" fill="#FBBC05"/></svg>
                Google Maps
              </a>
            </div>

            {/* Visit metadata */}
            <p className="text-[0.75rem] text-stone-500">
              First visited {firstDate}{c.visitCount > 1 ? ` · Last visited ${lastDate}` : ""}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ── DuplicateMergeModal ───────────────────────────────────────────────────
function DuplicateMergeModal({
  groups,
  onMerge,
  onClose,
}: {
  groups: Array<{ primary: GraveRecord; duplicates: GraveRecord[] }>;
  onMerge: (primaryId: string, duplicateIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [merging, setMerging] = useState<string | null>(null);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-955/80 backdrop-blur-md animate-fade-in">
      <div
        className="w-full max-w-2xl rounded-2xl border border-stone-800 shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
        style={{ background: "#1c1b19" }}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-stone-800 flex justify-between items-center bg-stone-900/40">
          <div>
            <h3 className="text-base font-bold text-stone-200">Merge Duplicate Scans</h3>
            <p className="text-xs text-stone-500 mt-0.5">We found markers that appear to be duplicate scans of the same grave.</p>
          </div>
          <button onClick={onClose} className="text-stone-500 hover:text-stone-300 p-1.5 rounded-full hover:bg-white/5">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {groups.map((group) => {
            const isMerging = merging === group.primary.id;
            return (
              <div key={group.primary.id} className="p-4 rounded-xl border border-stone-800 bg-stone-900/20 flex flex-col gap-4">
                <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
                  {/* Primary Scan */}
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={group.primary.photoDataUrl} alt="Primary" className="w-14 h-14 rounded-lg object-cover border border-stone-850 shrink-0" />
                    <div className="min-w-0">
                      <span className="text-[0.6rem] font-bold text-gold-500 uppercase tracking-wider bg-gold-500/10 px-1.5 py-0.5 rounded">Primary Scan</span>
                      <h4 className="text-sm font-semibold text-stone-200 mt-1 truncate">{group.primary.extracted.name}</h4>
                      <p className="text-xs text-stone-500 truncate">{group.primary.location?.cemetery || "Unknown Cemetery"}</p>
                    </div>
                  </div>

                  <div className="text-stone-500 text-lg font-bold">＋</div>

                  {/* Duplicate Scans */}
                  <div className="flex flex-col gap-3 flex-1 min-w-0">
                    {group.duplicates.map((dup) => (
                      <div key={dup.id} className="flex items-center gap-3 min-w-0">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={dup.photoDataUrl} alt="Duplicate" className="w-14 h-14 rounded-lg object-cover border border-stone-850 shrink-0" />
                        <div className="min-w-0">
                          <span className="text-[0.6rem] font-bold text-stone-500 uppercase tracking-wider bg-stone-800 px-1.5 py-0.5 rounded">Duplicate Scan</span>
                          <h4 className="text-sm font-semibold text-stone-300 mt-1 truncate">{dup.extracted.name}</h4>
                          <p className="text-xs text-stone-500 truncate">{dup.location?.cemetery || "Unknown Cemetery"}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex justify-end border-t border-stone-850 pt-3">
                  <button
                    disabled={isMerging}
                    onClick={async () => {
                      setMerging(group.primary.id);
                      await onMerge(group.primary.id, group.duplicates.map(d => d.id));
                      setMerging(null);
                    }}
                    className="text-xs font-semibold bg-gold-500 text-stone-950 px-4 py-2 rounded-lg hover:bg-gold-400 disabled:opacity-50 transition-colors flex items-center gap-2"
                  >
                    {isMerging ? (
                      <>
                        <div className="w-3 h-3 border border-t-transparent rounded-full animate-spin border-stone-950" />
                        Merging...
                      </>
                    ) : "Merge & Keep Photos"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
