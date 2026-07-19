"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import Link from "next/link";
import BottomNav from "@/components/layout/BottomNav";
import { saveGrave, getGrave, getAllGraves, getPendingResult, deletePendingResult, recordCemeteryVisit, saveAudio, getAudio } from "@/lib/storage";
import { inferGender, inferOrigin, selectVoice, formatTime } from "@/lib/ttsUtils";
import { cemeteryId } from "@/lib/apis/cemetery";
import { reverseGeocode } from "@/lib/apis/nominatim";
import { getDeviceLocation } from "@/lib/geo";
import { checkAndUnlock, loadStats } from "@/lib/achievements";
import AchievementUnlockToast, { type AchievementToastState } from "@/components/achievements/AchievementUnlockToast";
import { createClient } from "@/lib/supabase/browser";
import { uploadPhoto, upsertGrave, pushExplorerPoints, notifyExplorerProgress } from "@/lib/cloudSync";
import { photoProxyUrl } from "@/lib/photoUrl";
import { fetchBurialIndexRelatives, computePersonIdentityKey, type BurialIndexRelative } from "@/lib/community";
import { shareGrave, buildEmailShareUrl, buildSmsShareUrl } from "@/lib/share";
import { interpretSymbols } from "@/lib/apis/symbols";
import { getLandmarkEvents } from "@/lib/apis/wikipedia";
import { SCAN_USAGE, HEAR_STORY_USAGE } from "@/lib/usageActions";
// Opened on demand — load its canvas/crop code only when the editor is invoked.
const PhotoEditorModal = dynamic(() => import("@/components/results/PhotoEditorModal"), {
  ssr: false,
});
import { SectionHeader, ResearchSummaryCard, CONFIDENCE_INFO } from "@/components/research/cards";
import ProfileBadge from "@/components/auth/ProfileBadge";
import DesktopNav from "@/components/layout/DesktopNav";
import { EcosystemLauncher } from "@/components/ecosystem/lowhighShell";
import { useIsDesktop } from "@/hooks/useIsDesktop";
import { toNameCase } from "@/lib/nameUtils";
import { detectConflicts } from "@/lib/conflictDetector";
import { shouldReview, TYPICAL_NAME_RE } from "@/lib/reviewUtils";
import { validateExtraction } from "@/lib/extractionValidation";
import type {
  GraveRecord,
  ResearchData,
  ExtractedGraveData,
  GeoLocation,
  CulturalContext,
  PersonData,
} from "@/types";


interface PendingResult {
  id: string;
  photoDataUrl: string;
  thumbnailDataUrl?: string;
  additionalPhotos?: string[];
  extracted: ExtractedGraveData;
  location: GeoLocation | null;
  timestamp: number;
  needsReview?: boolean;
  reviewedAt?: number;
  /** Shared usage id for the scan that created this record (analyze + the
   *  auto-loaded cultural summary log under it as one "Scan a marker" action). */
  scanPromptId?: string;
}

function getPersonalizationDetails(
  research: ResearchData | null
) {
  if (!research) return {};

  const occupation = research.historicalCensus
    ?.map((c) => c.occupation)
    .filter(Boolean)[0] || undefined;

  const im = research.immigration?.[0];
  const immigration = im
    ? `Arrived in ${im.arrivalYear ?? "the U.S."}${im.origin ? " from " + im.origin : ""}`
    : undefined;

  const m = research.militaryContext;
  const militaryConfirmed = m?.inferredFrom === "inscription" || m?.inferredFrom === "symbols";
  const military = (militaryConfirmed && m?.likelyConflict)
    ? `${m.likelyConflict}${m.role ? " - " + m.role : ""}`
    : undefined;

  return { occupation, immigration, military };
}

export default function ResultPage({ id }: { id: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<PendingResult | null>(null);
  const [research, setResearch] = useState<ResearchData | null>(null);
  const [researchLoading, setResearchLoading] = useState(false);
  const [activePhotoUrl, setActivePhotoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (pending?.photoDataUrl) {
      setActivePhotoUrl(pending.photoDataUrl);
    }
  }, [pending?.photoDataUrl]);
  const [saved, setSaved] = useState(false);
  // True when this result was loaded from the archive (not a fresh scan).
  // Used to surface the "refresh for latest records" banner.
  const isArchivedLoad = useRef(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const [unlockToast, setUnlockToast] = useState<AchievementToastState | null>(null);
  const [culturalContext, setCulturalContext] = useState<CulturalContext | null>(null);
  const [culturalLoading, setCulturalLoading] = useState(false);
  const [expandingCategory, setExpandingCategory] = useState<string | null>(null);
  const [locationOverride, setLocationOverride] = useState<GeoLocation | null>(null);
  const [nearbyPrompt, setNearbyPrompt] = useState<{ name: string; records: GraveRecord[] } | null>(null);
  const [photoFullscreen, setPhotoFullscreen] = useState(false);
  const [photoEditing, setPhotoEditing] = useState(false);
  const [extractedOverride, setExtractedOverride] = useState<Partial<ExtractedGraveData> | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  // Tracks which individual section is mid-refresh (null = none)
  // Abort controller for the initial fresh-scan research fetch.
  // Cancelled the moment a user-triggered refresh starts so the old-name
  // response can never overwrite a corrected refresh that resolves first.
  const initialFetchAbortRef = useRef<AbortController | null>(null);
  // Abort controller for the simultaneous supplemental fetch (Phase 2).
  const supplementalFetchAbortRef = useRef<AbortController | null>(null);
  const isDesktop = useIsDesktop();

  // Detecting spinner shown briefly while reverse-geocoding for a cemetery name
  const [cemeteryPrompt, setCemeteryPrompt] = useState<"detecting" | "locating" | null>(null);

  const [selectedPersonIdx, setSelectedPersonIdx] = useState(0);
  const personResearchCacheRef = useRef<Map<number, ResearchData>>(new Map());
  // Tracks the full merged ExtractedGraveData for the currently selected person.
  // Null means person 0 (primary) — callers fall back to pending.extracted.
  const [selectedPersonData, setSelectedPersonData] = useState<ExtractedGraveData | null>(null);
  const [reviewPrompt, setReviewPrompt] = useState(false);
  const [reviewHelpOpen, setReviewHelpOpen] = useState(false);
  const reviewPromptShownRef = useRef(false);

  useEffect(() => {
    getPendingResult(id).then(async (raw) => {
      // Fall back to the saved archive if there's no in-flight pending result
      if (!raw) {
        const archived = await getGrave(id);
        if (!archived) {
          router.replace("/");
          return;
        }
        setPending({
          id: archived.id,
          photoDataUrl: archived.photoDataUrl,
          additionalPhotos: archived.additionalPhotos,
          extracted: archived.extracted,
          location: archived.location,
          timestamp: archived.timestamp,
          needsReview: archived.needsReview,
          reviewedAt: archived.reviewedAt,
        });

        // Backfill lifetimeLandmarks for records saved before the feature existed
        // or where the lookup couldn't compute them. Pure computation — no API call.
        let archivedResearch = archived.research ?? {};
        const by = archived.extracted.birthYear;
        const dy = archived.extracted.deathYear;
        if (archivedResearch.historical && !archivedResearch.historical.lifetimeLandmarks && by != null && dy != null && dy > by) {
          const landmarks = getLandmarkEvents(by, dy);
          if (landmarks.length > 0) {
            archivedResearch = {
              ...archivedResearch,
              historical: { ...archivedResearch.historical, lifetimeLandmarks: landmarks },
            };
            saveGrave({ ...archived, research: archivedResearch }).catch(() => {});
          }
        }

        isArchivedLoad.current = true;
        setResearch(archivedResearch);
        setCulturalContext(archivedResearch?.culturalContext ?? null);
        setTags(archived.tags ?? []);

        setSaved(true);
        return;
      }

      const data = raw as PendingResult;
      setPending(data);
      deletePendingResult(id).catch(() => {});

      // Auto-save immediately so the record is never lost, regardless of
      // whether the user taps "Save" or navigates away. Research data is
      // patched into the saved record once the lookup response arrives.
      const autoRecord: GraveRecord = {
        id: data.id,
        timestamp: data.timestamp,
        photoDataUrl: data.photoDataUrl,
        thumbnailDataUrl: data.thumbnailDataUrl,
        location: data.location ?? { lat: 0, lng: 0 },
        extracted: data.extracted,
        research: {},
        tags: [],
      };
      saveGrave(autoRecord).catch(() => {});
      setSaved(true);

      // Auto-create / update a CemeteryRecord when a grave is saved at a named cemetery
      if (data.location?.cemetery && data.location?.lat && data.location?.lng) {
        const { cemetery, lat, lng, city, state } = data.location;
        (async () => {
          try {
            // Use the server-side route so OSM/Wikipedia calls run without browser CORS restrictions
            const res = await fetch("/api/enrich-cemetery", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: cemetery, lat, lng, city, state }),
            });
            if (res.ok) {
              const enriched = await res.json();
              await recordCemeteryVisit(enriched);
            } else {
              throw new Error("enrich-cemetery returned " + res.status);
            }
          } catch {
            // Enrichment failed: record a minimal visit so we always track it
            try {
              await recordCemeteryVisit({
                id: cemeteryId(cemetery, lat, lng),
                name: cemetery,
                lat,
                lng,
              });
            } catch { /* truly non-fatal */ }
          }
        })();
      }

      // Cloud sync — non-fatal if offline or not logged in
      (async () => {
        try {
          const supabase = createClient();
          const { data: { user } } = await supabase.auth.getUser();
          if (user) {
            const photoPath = await uploadPhoto(user.id, autoRecord.id, autoRecord.photoDataUrl);
            // Re-read from DB so this save doesn't clobber research data that
            // the lookup fetch may have written while the upload was in flight.
            const fresh = await getGrave(autoRecord.id);
            // Local copy renders via the authenticated proxy; DB stores the path.
            const toSync = { ...(fresh ?? autoRecord), photoDataUrl: photoProxyUrl(autoRecord.id), syncedAt: Date.now() };
            await upsertGrave(supabase, user.id, toSync, photoPath);
            await saveGrave(toSync);
          }
        } catch { /* offline or not logged in — local save stands */ }

        // Check for newly unlocked achievements and push to cloud
        try {
          const allGraves = await getAllGraves();
          const stats = loadStats();
          const { newUnlocks, rankUp } = checkAndUnlock(allGraves, stats);
          if (newUnlocks.length > 0) {
            // Rank-ups earn a dedicated (non-blocking) hero toast; minor unlocks
            // collapse into a single count pill. When both happen on one save the
            // hero toast takes precedence — the minor unlocks still light the
            // Explorer badge silently.
            setUnlockToast(
              rankUp
                ? { kind: "hero", rankLevel: rankUp.level, rankTitle: rankUp.title, bonus: rankUp.bonus }
                : { kind: "count", count: newUnlocks.length }
            );
            // A new unlock may raise the user's rank and unlock a rank reward.
            // Nudge the ecosystem context to refresh the claimable-rewards dot.
            notifyExplorerProgress();
          }
          // Push current Explorer state to cloud (new unlocks or not)
          const supabase = createClient();
          const { data: { user } } = await supabase.auth.getUser();
          if (user) {
            pushExplorerPoints(supabase, user.id).catch(() => {});
          }
        } catch { /* non-fatal */ }
      })();

      if (!data.extracted?.name) return;
      setResearchLoading(true);
      const initialAbort = new AbortController();
      initialFetchAbortRef.current = initialAbort;
      const suppAbort = new AbortController();
      supplementalFetchAbortRef.current = suppAbort;

      const lookupPayload = {
        name: data.extracted.name,
        firstName: data.extracted.firstName,
        lastName: data.extracted.lastName,
        birthYear: data.extracted.birthYear,
        deathYear: data.extracted.deathYear,
        birthDate: data.extracted.birthDate,
        deathDate: data.extracted.deathDate,
        people: data.extracted.people,
        lat: data.location?.lat,
        lng: data.location?.lng,
        city: data.location?.city,
        county: data.location?.county,
        state: data.location?.state,
        cemetery: data.location?.cemetery,
        inscription: data.extracted.inscription ?? "",
        symbols: data.extracted.symbols ?? [],
        // Lets the server confidence-gate writes to the shared research index.
        confidence: data.extracted.confidence,
      };

      // Phase 1: person-specific core data — resolves in ~5–7s
      fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: initialAbort.signal,
        body: JSON.stringify(lookupPayload),
      })
        .then((r) => {
          if (r.status === 401) {
            setAuthRequired(true);
            throw new Error("Unauthorized");
          }
          setAuthRequired(false);
          return r.json();
        })
        .then((d) => {
          const researchData: ResearchData = {
            sourceStatus:      d.sourceStatus ?? undefined,
            newspapers:        d.newspapers ?? [],
            naraRecords:       d.naraRecords ?? [],
            landRecords:       d.landRecords ?? [],
            historical:        d.historical ?? {},
            militaryContext:   d.militaryContext ?? undefined,
            localHistory:      d.localHistory ?? undefined,
            wikitree:          d.wikitree ?? undefined,
          familySearchHints: d.familySearchHints ?? undefined,
            ssdi:              d.ssdi ?? undefined,
            immigration:       d.immigration ?? undefined,
            historicalCensus:  d.historicalCensus ?? undefined,
            naraItemRecords:   d.naraItemRecords ?? undefined,
            researchChecklist: d.researchChecklist ?? undefined,
            surnameSoundex:    d.surnameSoundex ?? undefined,
            surnameVariants:   d.surnameVariants ?? undefined,
            researchLinks:     d.researchLinks ?? undefined,
            cemetery: data.location?.cemetery
              ? {
                  name: data.location.cemetery,
                  wikipediaUrl: d.cemeteryWikiUrl,
                  location: data.location ?? undefined,
                }
              : undefined,
          };
          setResearch(researchData);
          personResearchCacheRef.current.set(0, researchData);
          // Patch research into the already-saved record, re-reading first so we
          // don't clobber the cloud photoDataUrl/syncedAt if the upload finished first.
          getGrave(autoRecord.id).then((existing) => {
            saveGrave({ ...(existing ?? autoRecord), research: researchData });
          }).catch(() => {});
        })
        .catch((err) => {
          // Ignore aborts — a user-triggered refresh took over
          if (err?.name !== "AbortError") setResearch({});
        })
        .finally(() => {
          if (!initialAbort.signal.aborted) setResearchLoading(false);
        });

      // Phase 2: supplemental geographic context + birth year notables.
      // Fires simultaneously with Phase 1; merges into research state when ready.
      fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: suppAbort.signal,
        body: JSON.stringify({ ...lookupPayload, supplemental: true }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (suppAbort.signal.aborted) return;
          setResearch((prev) => {
            if (!prev) return prev;
            const merged: ResearchData = {
              ...prev,
              birthYearNotables: d.birthYearNotables ?? prev.birthYearNotables,
              localHistory: d.localHistory
                ? { ...(prev.localHistory ?? {}), ...d.localHistory }
                : prev.localHistory,
            };
            personResearchCacheRef.current.set(0, merged);
            getGrave(autoRecord.id).then((existing) => {
              saveGrave({ ...(existing ?? autoRecord), research: merged });
            }).catch(() => {});
            return merged;
          });
        })
        .catch(() => { /* supplemental is best-effort */ });
    });
  }, [id, router]);

  const syncGraveToCloud = useCallback(async (record: GraveRecord) => {
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const photoPath = await uploadPhoto(user.id, record.id, record.photoDataUrl);
      await upsertGrave(supabase, user.id, record, photoPath);
      const fresh = await getGrave(record.id);
      await saveGrave({ ...(fresh ?? record), photoDataUrl: photoProxyUrl(record.id), syncedAt: Date.now() });
    } catch (err) {
      console.warn("[CloudSync] Non-fatal sync error:", err);
    }
  }, []);

  // When already saved, persist tag changes immediately
  const handleTagsChange = useCallback(async (next: string[]) => {
    setTags(next);
    if (!saved || !pending) return;
    const existing = await getGrave(pending.id);
    if (!existing) return;
    const updated = { ...existing, tags: next };
    await saveGrave(updated);
    // Sync tag update to cloud
    syncGraveToCloud(updated);
  }, [saved, pending, syncGraveToCloud]);



  const handleSaveForLater = useCallback(async () => {
    setReviewPrompt(false);
    if (!pending) return;
    const existing = await getGrave(pending.id);
    await saveGrave({ ...(existing ?? {
      id: pending.id,
      timestamp: pending.timestamp,
      photoDataUrl: pending.photoDataUrl,
      location: pending.location ?? { lat: 0, lng: 0 },
      extracted: pending.extracted,
      research: {},
      tags: [],
    }), needsReview: true, reviewedAt: undefined });
  }, [pending]);

  const handleMarkReviewed = useCallback(async () => {
    if (!pending) return;
    const nextPending = {
      ...pending,
      reviewedAt: Date.now(),
      needsReview: false,
    };
    setPending(nextPending);

    const existing = await getGrave(pending.id);
    if (existing) {
      const updatedRecord = {
        ...existing,
        reviewedAt: nextPending.reviewedAt,
        needsReview: false,
      };
      await saveGrave(updatedRecord);
      syncGraveToCloud(updatedRecord);
    }
  }, [pending, syncGraveToCloud]);

  const handleShare = useCallback(async () => {
    if (!pending) return;
    const record: GraveRecord = {
      id: pending.id,
      timestamp: pending.timestamp,
      photoDataUrl: pending.photoDataUrl,
      location: pending.location ?? { lat: 0, lng: 0 },
      extracted: pending.extracted,
      research: research ?? {},
    };

    // Try native share first
    const nativeSuccess = await shareGrave(record);
    if (!nativeSuccess) {
      setShareOpen(true);
    }
  }, [pending, research]);


  const handleLoadCultural = useCallback(async () => {
    if (!pending || culturalLoading) return;
    setCulturalLoading(true);
    try {
      const personExtracted = selectedPersonData ?? pending.extracted;
      const location = locationOverride ?? pending.location;
      const res = await fetch("/api/cultural", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "summary",
          // Part of the scan action — log under the same id/identity as the
          // marker read so the estimator sums them into one "Scan a marker".
          promptId: pending.scanPromptId,
          ...SCAN_USAGE,
          name: personExtracted.name,
          birthYear: personExtracted.birthYear,
          deathYear: personExtracted.deathYear,
          ageAtDeath: personExtracted.ageAtDeath,
          city: location?.city,
          state: location?.state,
          ...getPersonalizationDetails(research),
        }),
      });
      if (res.ok) {
        const data: CulturalContext = await res.json();
        setCulturalContext(data);
        setResearch((prev) => ({ ...(prev ?? {}), culturalContext: data }));
        // Persist cultural summary to IDB so it doesn't regenerate on next view
        if (selectedPersonIdx === 0) {
          getGrave(pending.id).then(async (existing) => {
            if (existing) {
              const updated = { ...existing, research: { ...existing.research, culturalContext: data } };
              await saveGrave(updated);
              syncGraveToCloud(updated);
            }
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.warn("Cultural context generation failed:", err);
    } finally {
      setCulturalLoading(false);
    }
  }, [pending, culturalLoading, selectedPersonData, locationOverride, selectedPersonIdx, syncGraveToCloud, research]);

  const handleExpandCategory = useCallback(async (categoryId: string, categoryLabel: string) => {
    if (!pending || expandingCategory || !culturalContext) return;
    setExpandingCategory(categoryId);
    try {
      const personExtracted = selectedPersonData ?? pending.extracted;
      const location = locationOverride ?? pending.location;
      const res = await fetch("/api/cultural", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "expand",
          categoryId,
          categoryLabel,
          name: personExtracted.name,
          birthYear: personExtracted.birthYear,
          deathYear: personExtracted.deathYear,
          ageAtDeath: personExtracted.ageAtDeath,
          city: location?.city,
          state: location?.state,
          ...getPersonalizationDetails(research),
        }),
      });
      if (res.ok) {
        const { detail } = await res.json();
        const updatedCtx: CulturalContext = {
          categories: culturalContext.categories.map((c) =>
            c.id === categoryId ? { ...c, detail } : c
          ),
        };
        setCulturalContext(updatedCtx);
        setResearch((r) => ({ ...(r ?? {}), culturalContext: updatedCtx }));
        if (selectedPersonIdx === 0) {
          getGrave(pending.id).then(async (existing) => {
            if (existing) {
              const updated = {
                ...existing,
                research: {
                  ...existing.research,
                  culturalContext: updatedCtx,
                },
              };
              await saveGrave(updated);
              syncGraveToCloud(updated);
            }
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.warn("Category expand failed:", err);
    } finally {
      setExpandingCategory(null);
    }
  }, [pending, expandingCategory, culturalContext, selectedPersonData, locationOverride, selectedPersonIdx, syncGraveToCloud, research]);


  // Auto-load cultural context once the main research fetch completes
  useEffect(() => {
    if (!pending || researchLoading || culturalContext) return;
    if (!extracted?.birthYear && !extracted?.deathYear) return;
    handleLoadCultural();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [researchLoading]);

  // Show review prompt when name is empty or confidence is low.
  // Runs on both fresh scans (researchLoading flip) and archived needsReview
  // records (pending populates but researchLoading never changes).
  useEffect(() => {
    if (!pending || researchLoading || reviewPromptShownRef.current) return;
    // Already human-reviewed — don't re-prompt on low confidence
    if (pending.reviewedAt != null) return;
    const current = { ...pending.extracted, ...(extractedOverride ?? {}) };
    if (!current.name || current.confidence === "low") {
      reviewPromptShownRef.current = true;
      setReviewPrompt(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, researchLoading]);

  const currentLocation = locationOverride ?? pending?.location ?? null;

  const handlePhotoSave = useCallback(async (newDataUrl: string) => {
    if (!pending) return;
    setPending((prev) => prev ? { ...prev, photoDataUrl: newDataUrl } : prev);
    const existing = await getGrave(pending.id);
    if (existing) await saveGrave({ ...existing, photoDataUrl: newDataUrl });
    // Re-sync to cloud non-fatally
    (async () => {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        await uploadPhoto(user.id, pending.id, newDataUrl);
        const fresh = await getGrave(pending.id);
        if (fresh) await saveGrave({ ...fresh, photoDataUrl: photoProxyUrl(pending.id), syncedAt: Date.now() });
      } catch { /* offline or not logged in */ }
    })();
    setPhotoEditing(false);
    setPhotoFullscreen(false);
  }, [pending]);

  const handleCemeteryEdit = useCallback(async (name: string) => {
    if (!pending) return;
    const newLocation: GeoLocation = { ...(currentLocation ?? { lat: 0, lng: 0 }), cemetery: name };
    setLocationOverride(newLocation);

    const updated: GraveRecord = {
      id: pending.id,
      timestamp: pending.timestamp,
      photoDataUrl: pending.photoDataUrl,
      location: newLocation,
      extracted: pending.extracted,
      research: research ?? {},
      tags,
    };
    await saveGrave(updated);
    syncGraveToCloud(updated);

    if (newLocation.lat !== 0 && newLocation.lng !== 0) {
      try {
        const all = await getAllGraves();
        const PROXIMITY_M = 750;
        const nearby = all.filter((g) => {
          if (g.id === pending.id) return false;
          if (!g.location?.lat || !g.location?.lng) return false;
          const dLat = g.location.lat - newLocation.lat;
          const dLng = g.location.lng - newLocation.lng;
          const dist = Math.sqrt(dLat * dLat + dLng * dLng) * 111_000;
          return dist < PROXIMITY_M;
        });
        if (nearby.length > 0) setNearbyPrompt({ name, records: nearby });
      } catch { /* non-fatal */ }
    }
  }, [pending, currentLocation, research, tags, syncGraveToCloud]);

  const handleLocateCemetery = useCallback(async () => {
    if (!pending) return;
    try {
      const deviceLoc = await getDeviceLocation();
      if (!deviceLoc) return;
      const geo = await reverseGeocode(deviceLoc.lat, deviceLoc.lng);
      const newLoc: GeoLocation = { ...(currentLocation ?? { lat: 0, lng: 0 }), ...geo };
      setLocationOverride(newLoc);
      const existing = await getGrave(pending.id);
      if (existing) {
        const updated = { ...existing, location: newLoc };
        await saveGrave(updated);
        syncGraveToCloud(updated);
      }
    } catch { /* non-fatal */ }
  }, [pending, currentLocation, syncGraveToCloud]);

  const handleNearbyYes = useCallback(async () => {
    if (!nearbyPrompt) return;
    for (const g of nearbyPrompt.records) {
      const updated = { ...g, location: { ...g.location, cemetery: nearbyPrompt.name } };
      await saveGrave(updated);
    }
    setNearbyPrompt(null);
  }, [nearbyPrompt]);

  const handleRefreshData = useCallback(async (extractedData?: ExtractedGraveData, skipCemeteryCheck = false) => {
    if (!pending || refreshingRef.current) return;
    // Cancel any in-flight initial scan fetch (Phase 1 + Phase 2) so they
    // can't overwrite a corrected refresh that resolves first.
    initialFetchAbortRef.current?.abort();
    initialFetchAbortRef.current = null;
    supplementalFetchAbortRef.current?.abort();
    supplementalFetchAbortRef.current = null;

    // ── Cemetery auto-detection ──────────────────────────────────────────────
    // Only runs on explicit user-triggered refreshes (not edit-triggered ones).
    let effectiveLocation = currentLocation;
    if (!skipCemeteryCheck && !effectiveLocation?.cemetery) {
      const lat = effectiveLocation?.lat;
      const lng = effectiveLocation?.lng;
      const hasCoords = typeof lat === "number" && typeof lng === "number" && (lat !== 0 || lng !== 0);

      if (hasCoords) {
        setCemeteryPrompt("detecting");
        setRefreshing(true);
        try {
          const geo = await reverseGeocode(lat!, lng!);
          if (geo.cemetery) {
            // Auto-detected — apply silently and continue
            const newLoc: GeoLocation = { ...(effectiveLocation ?? { lat: lat!, lng: lng! }), ...geo };
            setLocationOverride(newLoc);
            effectiveLocation = newLoc;
            const existing = await getGrave(pending.id);
            if (existing) await saveGrave({ ...existing, location: newLoc });
          }
          // No cemetery found — proceed without one; user can edit via the Location card
        } catch {
          // Network error — proceed without cemetery
        }
        setCemeteryPrompt(null);
      } else {
        // No valid GPS coords — try to get the device's current location now.
        // The user may have granted permission after capture, or moved outside to get a fix.
        setCemeteryPrompt("locating");
        setRefreshing(true);
        try {
          const deviceLoc = await getDeviceLocation();
          if (deviceLoc) {
            const geo = await reverseGeocode(deviceLoc.lat, deviceLoc.lng);
            const newLoc: GeoLocation = { ...geo };
            setLocationOverride(newLoc);
            effectiveLocation = newLoc;
            const existing = await getGrave(pending.id);
            if (existing) await saveGrave({ ...existing, location: newLoc });
          }
        } catch {
          // Non-fatal — proceed without location
        }
        setCemeteryPrompt(null);
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    refreshingRef.current = true;
    setRefreshing(true);

    // ── Re-scan the image when user explicitly refreshes (no extractedData passed) ──
    // This lets app-side prompt improvements take effect on existing scans.
    let freshExtracted: ExtractedGraveData | undefined;
    if (!extractedData && pending.photoDataUrl) {
      try {
        const commaIdx = pending.photoDataUrl.indexOf(",");
        const header = pending.photoDataUrl.slice(0, commaIdx);
        const imageBase64 = pending.photoDataUrl.slice(commaIdx + 1);
        const mimeType = header.split(":")[1]?.split(";")[0] ?? "image/jpeg";
        const analyzeRes = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageBase64, mimeType }),
        });
        if (analyzeRes.ok) {
          const { extracted } = await analyzeRes.json();
          freshExtracted = extracted as ExtractedGraveData;
          setPending((prev) => prev ? { ...prev, extracted: freshExtracted! } : prev);
          const existing = await getGrave(pending.id);
          if (existing) {
            const updated = { ...existing, extracted: freshExtracted! };
            await saveGrave(updated);
            syncGraveToCloud(updated);
          }
        }
      } catch { /* non-fatal — fall through with existing extracted */ }
    }
    // ────────────────────────────────────────────────────────────────────────

    const current = extractedData ?? { ...(freshExtracted ?? pending.extracted), ...(extractedOverride ?? {}) };
    const phase1Abort = new AbortController();
    const phase2Abort = new AbortController();
    try {
      isArchivedLoad.current = false; // refresh clears the stale banner
      setResearchLoading(true);
      initialFetchAbortRef.current = phase1Abort;
      supplementalFetchAbortRef.current = phase2Abort;

      const refreshPayload = {
        name: current.name,
        firstName: current.firstName,
        lastName: current.lastName,
        birthYear: current.birthYear,
        deathYear: current.deathYear,
        birthDate: current.birthDate,
        deathDate: current.deathDate,
        people: current.people,
        lat: effectiveLocation?.lat,
        lng: effectiveLocation?.lng,
        city: effectiveLocation?.city,
        county: effectiveLocation?.county,
        state: effectiveLocation?.state,
        cemetery: effectiveLocation?.cemetery,
        inscription: current.inscription ?? "",
        symbols: current.symbols ?? [],
      };

      // Fire Phase 1 and Phase 2 simultaneously; wait for both before clearing spinner.
      const [phase1Res, phase2Res] = await Promise.all([
        fetch("/api/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: phase1Abort.signal,
          body: JSON.stringify(refreshPayload),
        }),
        fetch("/api/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: phase2Abort.signal,
          body: JSON.stringify({ ...refreshPayload, supplemental: true }),
        }),
      ]);

      if (phase1Res.status === 401 || phase2Res.status === 401) {
        setAuthRequired(true);
        if (initialFetchAbortRef.current === phase1Abort && supplementalFetchAbortRef.current === phase2Abort) {
          setResearchLoading(false);
          refreshingRef.current = false;
          setRefreshing(false);
        }
        return;
      }
      setAuthRequired(false);

      if (phase1Res.ok) {
        const d = await phase1Res.json();
        const s = phase2Res.ok ? await phase2Res.json() : {};

        const researchData: ResearchData = {
          sourceStatus:      d.sourceStatus ?? undefined,
          newspapers:        d.newspapers ?? [],
          naraRecords:       d.naraRecords ?? [],
          landRecords:       d.landRecords ?? [],
          historical:        d.historical ?? {},
          militaryContext:   d.militaryContext ?? undefined,
          localHistory:      s.localHistory
            ? { ...(d.localHistory ?? {}), ...s.localHistory }
            : (d.localHistory ?? undefined),
          wikitree:          d.wikitree ?? undefined,
          familySearchHints: d.familySearchHints ?? undefined,
          ssdi:              d.ssdi ?? undefined,
          immigration:       d.immigration ?? undefined,
          historicalCensus:  d.historicalCensus ?? undefined,
          naraItemRecords:   d.naraItemRecords ?? undefined,
          birthYearNotables: s.birthYearNotables ?? undefined,
          researchChecklist: d.researchChecklist ?? undefined,
          surnameSoundex:    d.surnameSoundex ?? undefined,
          surnameVariants:   d.surnameVariants ?? undefined,
          researchLinks:     d.researchLinks ?? undefined,
          cemetery: effectiveLocation?.cemetery
            ? { name: effectiveLocation.cemetery, wikipediaUrl: d.cemeteryWikiUrl, location: effectiveLocation ?? undefined }
            : undefined,
        };
        // Patch lookup results over existing research — preserves user-generated
        // content (story script, epitaph context, narratives) that isn't
        // returned by /api/lookup so it isn't wiped on every name/date edit.
        setResearch((prev) => ({
          storyScript:    prev?.storyScript,
          epitaphSource:  prev?.epitaphSource,
          epitaphMeaning: prev?.epitaphMeaning,
          storyScripts:   prev?.storyScripts,
          epitaphSources: prev?.epitaphSources,
          epitaphMeanings: prev?.epitaphMeanings,
          narrative:      prev?.narrative,
          narratives:     prev?.narratives,
          culturalContext: prev?.culturalContext,
          ...researchData,
        }));
        personResearchCacheRef.current.set(0, researchData);
        setSelectedPersonIdx(0);
        setCulturalContext(null);
        const existing = await getGrave(pending.id);
        if (existing) {
          await saveGrave({
            ...existing,
            extracted: current,
            research: {
              // Preserve generated content not touched by the lookup
              storyScript:    existing.research?.storyScript,
              epitaphSource:  existing.research?.epitaphSource,
              epitaphMeaning: existing.research?.epitaphMeaning,
              storyScripts:   existing.research?.storyScripts,
              epitaphSources: existing.research?.epitaphSources,
              epitaphMeanings: existing.research?.epitaphMeanings,
              narrative:      existing.research?.narrative,
              narratives:     existing.research?.narratives,
              culturalContext: existing.research?.culturalContext,
              ...researchData,
            },
          });
        }
      }
    } catch (err: unknown) {
      if ((err as { name?: string })?.name !== "AbortError") {
        console.error("handleRefreshData error:", err);
      }
    } finally {
      if (initialFetchAbortRef.current === phase1Abort && supplementalFetchAbortRef.current === phase2Abort) {
        setResearchLoading(false);
        refreshingRef.current = false;
        setRefreshing(false);
      }
    }
  }, [pending, extractedOverride, currentLocation, syncGraveToCloud]);


  // ────────────────────────────────────────────────────────────────────────────

  // Tracks the in-flight person-switch fetch so rapid taps can cancel the prior one.
  const personFetchAbortRef = useRef<AbortController | null>(null);

  const handleSelectPerson = useCallback(async (idx: number, force = false) => {
    if (idx === selectedPersonIdx && !force) return;
    if (!pending) return;

    // Cancel any still-in-flight fetch for a previous person switch
    personFetchAbortRef.current?.abort();

    setSelectedPersonIdx(idx);

    const people = pending.extracted.people ?? [];
    const person = people[idx];
    // Update selectedPersonData so cultural context callbacks use the right person
    if (idx === 0 || !person) {
      setSelectedPersonData(null);
    } else {
      setSelectedPersonData({
        ...pending.extracted,
        ...(extractedOverride ?? {}),
        ...person,
        people: pending.extracted.people,
      });
    }

    const cached = personResearchCacheRef.current.get(idx);
    if (cached && !force) {
      setResearch(cached);
      setCulturalContext(cached.culturalContext ?? null);
      return;
    }

    if (!person) return;

    const abort = new AbortController();
    personFetchAbortRef.current = abort;

    setResearchLoading(true);
    try {
      const res = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({
          name: person.name,
          firstName: person.firstName,
          lastName: person.lastName,
          birthYear: person.birthYear,
          deathYear: person.deathYear,
          birthDate: person.birthDate,
          deathDate: person.deathDate,
          people: pending.extracted.people,
          lat: currentLocation?.lat,
          lng: currentLocation?.lng,
          city: currentLocation?.city,
          county: currentLocation?.county,
          state: currentLocation?.state,
          cemetery: currentLocation?.cemetery,
          inscription: pending.extracted.inscription ?? "",
          symbols: pending.extracted.symbols ?? [],
        }),
      });
      if (res.ok) {
        const d = await res.json();
        const researchData: ResearchData = {
          sourceStatus:      d.sourceStatus ?? undefined,
          newspapers:        d.newspapers ?? [],
          naraRecords:       d.naraRecords ?? [],
          landRecords:       d.landRecords ?? [],
          historical:        d.historical ?? {},
          militaryContext:   d.militaryContext ?? undefined,
          localHistory:      d.localHistory ?? undefined,
          wikitree:          d.wikitree ?? undefined,
          familySearchHints: d.familySearchHints ?? undefined,
          ssdi:              d.ssdi ?? undefined,
          immigration:       d.immigration ?? undefined,
          historicalCensus:  d.historicalCensus ?? undefined,
          naraItemRecords:   d.naraItemRecords ?? undefined,
          birthYearNotables: d.birthYearNotables ?? undefined,
          researchChecklist: d.researchChecklist ?? undefined,
          culturalContext:   d.culturalContext ?? undefined,
          cemetery: currentLocation?.cemetery
            ? { name: currentLocation.cemetery, wikipediaUrl: d.cemeteryWikiUrl, location: currentLocation ?? undefined }
            : undefined,
        };
        personResearchCacheRef.current.set(idx, researchData);
        setResearch(researchData);
        setCulturalContext(researchData.culturalContext ?? null);
      }
    } catch (err) {
      // Ignore intentional cancellations from rapid person switching
      if ((err as { name?: string })?.name !== "AbortError") {
        /* non-fatal network error — leave previous research visible */
      }
    } finally {
      if (!abort.signal.aborted) setResearchLoading(false);
    }
  }, [selectedPersonIdx, pending, currentLocation, extractedOverride]);

  const handleExtractedEdit = useCallback(async (patch: Partial<ExtractedGraveData>) => {
    if (!pending) return;

    // Derive firstName/lastName when full name is edited
    let enriched: Partial<ExtractedGraveData> = patch;
    if (patch.name !== undefined) {
      const parts = patch.name.trim().split(/\s+/).filter(Boolean);
      enriched = {
        ...enriched,
        firstName: parts[0] ?? "",
        lastName: parts.length > 1 ? parts[parts.length - 1] : "",
      };
    }
    // Derive year numbers when date strings are edited
    if (patch.birthDate !== undefined) {
      const m = patch.birthDate.match(/\b(1[5-9]\d\d|20[0-2]\d)\b/);
      enriched = { ...enriched, birthYear: m ? parseInt(m[1], 10) : null };
    }
    if (patch.deathDate !== undefined) {
      const m = patch.deathDate.match(/\b(1[5-9]\d\d|20[0-2]\d)\b/);
      enriched = { ...enriched, deathYear: m ? parseInt(m[1], 10) : null };
    }

    if (selectedPersonIdx > 0) {
      const currentExtracted = { ...pending.extracted, ...(extractedOverride ?? {}) };
      const updatedPeople = [...(currentExtracted.people ?? [])];
      const person = updatedPeople[selectedPersonIdx];
      if (person) {
        updatedPeople[selectedPersonIdx] = {
          ...person,
          ...enriched,
        };
        const next = {
          ...currentExtracted,
          people: updatedPeople,
        };
        setExtractedOverride(next);

        setSelectedPersonData({
          ...currentExtracted,
          ...updatedPeople[selectedPersonIdx],
          people: updatedPeople,
        });

        const existing = await getGrave(pending.id);
        if (existing) {
          const updated = {
            ...existing,
            extracted: next,
            reviewedAt: Date.now(),
          };
          await saveGrave(updated);
          syncGraveToCloud(updated);
        }

        personResearchCacheRef.current.delete(selectedPersonIdx);
        handleSelectPerson(selectedPersonIdx, true);
      }
      return;
    }

    // Substitute edited name/dates into the inscription text so it stays in sync.
    const currentExtracted = { ...pending.extracted, ...(extractedOverride ?? {}) };
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const YEAR_RE = /\b(1[5-9]\d\d|20[0-2]\d)\b/;

    // Replace oldVal with newVal in text. Strategy:
    //   1. Case-insensitive exact match (handles "JOHN" → "John", "MARCH 15, 1890" → etc.)
    //   2. Multiline fallback — OCR often puts first/last name on separate lines so
    //      "George Sawyer" won't match "GEORGE\nSAWYER" with a plain regex.
    //      Try matching words with flexible whitespace/newline separators.
    //   3. Year-only fallback — the AI normalises dates so the extracted string rarely
    //      matches the raw inscription verbatim (e.g. "March 15, 1890" vs "MAR. 15, 1890").
    //      If the full string misses, replace just the year token so "1890" → "1891" still lands.
    function replaceInText(text: string, oldVal: string, newVal: string): string {
      const direct = text.replace(new RegExp(esc(oldVal.trim()), "gi"), newVal);
      if (direct !== text) return direct;
      const words = oldVal.trim().split(/\s+/).filter(Boolean);
      if (words.length > 1) {
        const multilinePattern = words.map(esc).join("[\\s\\n]+");
        const multiline = text.replace(new RegExp(multilinePattern, "gi"), newVal);
        if (multiline !== text) return multiline;
      }
      const oldYear = oldVal.match(YEAR_RE)?.[0];
      const newYear = newVal.match(YEAR_RE)?.[0];
      if (oldYear && newYear && oldYear !== newYear) {
        return text.replace(new RegExp(`\\b${oldYear}\\b`, "g"), newYear);
      }
      return text;
    }

    let inscriptionText = currentExtracted.inscription ?? "";
    if (patch.name !== undefined && currentExtracted.name?.trim()) {
      inscriptionText = replaceInText(inscriptionText, currentExtracted.name, patch.name);
    }
    if (patch.birthDate !== undefined && currentExtracted.birthDate?.trim()) {
      inscriptionText = replaceInText(inscriptionText, currentExtracted.birthDate, patch.birthDate);
    }
    if (patch.deathDate !== undefined && currentExtracted.deathDate?.trim()) {
      inscriptionText = replaceInText(inscriptionText, currentExtracted.deathDate, patch.deathDate);
    }
    if (inscriptionText !== (currentExtracted.inscription ?? "")) {
      enriched = { ...enriched, inscription: inscriptionText };
    }

    const next = { ...pending.extracted, ...(extractedOverride ?? {}), ...enriched };
    setExtractedOverride(next);

    // Persist to DB — don't let a missing record block the research refresh
    const existing = await getGrave(pending.id);
    if (existing) {
      // Clear needsReview if a name is now present; a human edit that leaves
      // the record with a name counts as review (overrides low confidence).
      const reviewCleared = existing.needsReview && !!next.name;
      const updated = {
        ...existing,
        extracted: next,
        ...(next.name ? { reviewedAt: Date.now() } : {}),
        ...(reviewCleared ? { needsReview: false } : {}),
      };
      await saveGrave(updated);
      syncGraveToCloud(updated);
    }

    // Re-run research when fields that affect the lookup change
    const RESEARCH_KEYS: (keyof ExtractedGraveData)[] = [
      "name", "firstName", "lastName", "birthYear", "deathYear", "inscription", "symbols",
    ];
    if (RESEARCH_KEYS.some((k) => k in enriched)) {
      handleRefreshData(next);
    }
  }, [pending, extractedOverride, handleRefreshData, selectedPersonIdx, handleSelectPerson, syncGraveToCloud]);

  if (!pending) {
    return (
      <div className="flex items-center justify-center min-h-full bg-stone-900">
        <div className="w-8 h-8 border-2 border-gold-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const extracted: ExtractedGraveData = { ...pending.extracted, ...(extractedOverride ?? {}) };
  const activePeople = extracted.people ?? [];
  const activeExtracted: ExtractedGraveData =
    selectedPersonIdx > 0 && activePeople[selectedPersonIdx]
      ? { ...extracted, ...activePeople[selectedPersonIdx], people: extracted.people }
      : extracted;
  const { photoDataUrl } = pending;
  const location = currentLocation;

  const graveRecord: GraveRecord = {
    id: pending.id,
    timestamp: pending.timestamp,
    photoDataUrl,
    additionalPhotos: pending.additionalPhotos,
    location: location ?? { lat: 0, lng: 0 },
    extracted,
    research: research ?? {},
    tags,
    needsReview: pending.needsReview,
    reviewedAt: pending.reviewedAt,
  };

  return (
    <div className="flex flex-col h-full bg-stone-900 overflow-hidden lg:pl-56">
      {isDesktop && <DesktopNav />}
      {/* Header */}
      <header
        className="flex items-center justify-between px-5 py-3 bg-stone-900/95 backdrop-blur-sm sticky top-0 z-30 border-b border-stone-800"
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        <button
          onClick={() => router.back()}
          className="flex items-center gap-2 -ml-1 px-2 py-2 rounded-xl text-stone-400 active:text-stone-200 active:bg-white/5 transition-colors"
          aria-label="Go back"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6"/>
          </svg>
          <span className="text-sm">Back</span>
        </button>

        <span className="font-serif text-stone-200 text-base font-medium">
          {toNameCase(activeExtracted.name) || "Unknown"}
        </span>

        <div className="flex items-center gap-3">
          <button
            onClick={() => handleRefreshData()}
            disabled={refreshing || researchLoading}
            aria-label="Refresh data"
            className="text-stone-400 active:text-stone-200 disabled:opacity-40"
          >
            <svg
              width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={refreshing || researchLoading ? "animate-spin" : ""}
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
          <button
            onClick={handleShare}
            className="text-stone-400 active:text-stone-200"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
              <polyline points="16 6 12 2 8 6"/>
              <line x1="12" y1="2" x2="12" y2="15"/>
            </svg>
          </button>
          {/* Global account controls: kept in the header at every width so the
              launcher + profile badge match every PageShell page (the desktop
              sidebar carries no account control). */}
          <EcosystemLauncher />
          <ProfileBadge />
        </div>
      </header>

      {/* Desktop: side-by-side wrapper. Mobile: plain column (flex-col is default). */}
      <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">

      <main className="scroll-container flex-1 w-full pb-32 lg:pb-8 lg:basis-[60%] lg:shrink-0 lg:overflow-y-auto">
        {/* Hero photo — mobile only; desktop uses the aside panel */}
        <div className="lg:hidden">
          <div
            className="relative w-full aspect-[4/3] bg-stone-800 overflow-hidden cursor-pointer"
            onClick={() => setPhotoFullscreen(true)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={activePhotoUrl || photoDataUrl}
              alt="Grave marker"
              className="w-full h-full object-cover"
            />
            {/* Additional photos thumbnails overlay */}
            {graveRecord?.additionalPhotos && graveRecord.additionalPhotos.length > 0 && (
              <div className="absolute bottom-3 left-3 flex gap-1.5 z-10 animate-fade-up" onClick={(e) => e.stopPropagation()}>
                {[photoDataUrl, ...graveRecord.additionalPhotos].map((photo, index) => (
                  <button
                    key={index}
                    onClick={() => setActivePhotoUrl(photo)}
                    className={`w-10 h-10 rounded-lg overflow-hidden border-2 transition-all ${
                      (activePhotoUrl || photoDataUrl) === photo ? "border-gold-500 scale-105" : "border-stone-850 opacity-70"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photo} alt="" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-stone-900 via-transparent to-transparent" />
            <div className="absolute bottom-3 right-3 w-7 h-7 rounded-full flex items-center justify-center bg-stone-900/60">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#b0aba6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
              </svg>
            </div>
            {extracted.confidence && (
              <ConfidenceBadge confidence={extracted.confidence} extracted={extracted} offsetClass="top-3 right-3" />
            )}
          </div>
        </div>

        <div className="flex flex-col gap-0 px-5 lg:px-8 lg:py-4">

          {/* ── ZONE 1: IDENTITY ── Who is this person? ────────────────────── */}

          <PrimaryCard
            extracted={activeExtracted}
            onSave={handleExtractedEdit}
            people={activePeople.length > 1 ? activePeople : undefined}
            selectedPersonIdx={selectedPersonIdx}
            onSelectPerson={handleSelectPerson}
          />

          {/* Inscription + epitaph — the primary source; grounds all other data */}
          <InscriptionCard
            inscription={extracted.inscription}
            epitaph={extracted.epitaph}
            epitaphSource={
              selectedPersonIdx === 0
                ? (research?.epitaphSource ?? research?.epitaphSources?.[0])
                : research?.epitaphSources?.[selectedPersonIdx]
            }
            epitaphMeaning={
              selectedPersonIdx === 0
                ? (research?.epitaphMeaning ?? research?.epitaphMeanings?.[0])
                : research?.epitaphMeanings?.[selectedPersonIdx]
            }
            onSave={(inscription) => handleExtractedEdit({ inscription })}
          />

          {/* Symbols with database meanings */}
          {extracted.symbols && extracted.symbols.length > 0 && (
            <SymbolsCard symbols={extracted.symbols} />
          )}

          {/* ── ZONE 2: CONTEXT ── When and where did they live? ──────────── */}

          {/* Cemetery & Location */}
          {location && <CemeteryCard location={location} research={research} onSave={handleCemeteryEdit} onLocate={handleLocateCemetery} />}

          {/* Historical context — birth/death era, life expectancy, lifetime events */}
          {(research?.historical || researchLoading) && (
            <HistoricalCard
              historical={research?.historical}
              extracted={activeExtracted}
              loading={researchLoading}
            />
          )}

          {/* A Life in Their Era — cultural context */}
          <CulturalContextCard
            context={culturalContext}
            loading={culturalLoading}
            expandingCategory={expandingCategory}
            onExpand={handleExpandCategory}
            extracted={extracted}
          />

          {/* Local & regional history */}
          {(research?.localHistory || researchLoading) && (
            <LocalHistoryCard
              localHistory={research?.localHistory}
              location={location}
              loading={researchLoading}
            />
          )}

          {/* Notable people born the same year */}
          {research?.birthYearNotables?.length ? (
            <BirthYearNotablesCard notables={research.birthYearNotables} birthYear={extracted.birthYear} />
          ) : null}

          {/* ── ZONE 3: STORY ── Their narrative (context established above) ─ */}

          <StoryCard
            graveId={pending.id}
            extracted={activeExtracted}
            research={research}
            location={location}
            personIdx={selectedPersonIdx}
            researchReady={!researchLoading && !!culturalContext}
            onStoryGenerated={async (epitaphSource, epitaphMeaning, script) => {
              setResearch((prev) => {
                const next = { ...(prev ?? {}) };
                if (selectedPersonIdx === 0) {
                  next.storyScript = script;
                  next.epitaphSource = epitaphSource;
                  next.epitaphMeaning = epitaphMeaning;
                }
                const storyScripts = [...(next.storyScripts ?? [])];
                const epitaphSources = [...(next.epitaphSources ?? [])];
                const epitaphMeanings = [...(next.epitaphMeanings ?? [])];

                const peopleCount = activePeople.length || 1;
                while (storyScripts.length < peopleCount) storyScripts.push("");
                while (epitaphSources.length < peopleCount) epitaphSources.push("");
                while (epitaphMeanings.length < peopleCount) epitaphMeanings.push("");

                storyScripts[selectedPersonIdx] = script;
                epitaphSources[selectedPersonIdx] = epitaphSource;
                epitaphMeanings[selectedPersonIdx] = epitaphMeaning;

                next.storyScripts = storyScripts;
                next.epitaphSources = epitaphSources;
                next.epitaphMeanings = epitaphMeanings;

                return next;
              });

              if (pending) {
                const existing = await getGrave(pending.id);
                if (existing) {
                  const r = { ...(existing.research ?? {}) };
                  if (selectedPersonIdx === 0) {
                    r.storyScript = script;
                    r.epitaphSource = epitaphSource;
                    r.epitaphMeaning = epitaphMeaning;
                  }
                  const storyScripts = [...(r.storyScripts ?? [])];
                  const epitaphSources = [...(r.epitaphSources ?? [])];
                  const epitaphMeanings = [...(r.epitaphMeanings ?? [])];

                  const peopleCount = activePeople.length || 1;
                  while (storyScripts.length < peopleCount) storyScripts.push("");
                  while (epitaphSources.length < peopleCount) epitaphSources.push("");
                  while (epitaphMeanings.length < peopleCount) epitaphMeanings.push("");

                  storyScripts[selectedPersonIdx] = script;
                  epitaphSources[selectedPersonIdx] = epitaphSource;
                  epitaphMeanings[selectedPersonIdx] = epitaphMeaning;

                  r.storyScripts = storyScripts;
                  r.epitaphSources = epitaphSources;
                  r.epitaphMeanings = epitaphMeanings;

                  const updated = { ...existing, research: r };
                  await saveGrave(updated);
                  syncGraveToCloud(updated);
                }
              }
            }}
          />

          {/* Divider between story and records */}
          <div className="h-px bg-gradient-to-r from-transparent via-stone-700 to-transparent my-1" />

          {/* ── ZONE 4: RECORDS ── The evidence ───────────────────────────── */}

          {/* Contextual re-analyze card: shown for archived records flagged for review */}
          {isArchivedLoad.current && !researchLoading && !refreshing && shouldReview(graveRecord) && (() => {
            const isLow = extracted.confidence === "low";
            const missingDates = extracted.birthYear == null && extracted.deathYear == null;
            const unusualChars = !!extracted.name && !TYPICAL_NAME_RE.test(extracted.name);
            const reasons = [
              isLow && "Low confidence scan",
              missingDates && "Dates missing",
              unusualChars && "Name contains unusual characters",
            ].filter(Boolean).join(" · ");
            return (
              <div className="rounded-2xl mb-1 overflow-hidden" style={{ border: "1px solid rgba(245,158,11,0.2)", background: "rgba(245,158,11,0.04)" }}>
                <div className="px-4 pt-3 pb-2">
                  <div className="flex justify-between items-center">
                    <p className="text-[0.7rem] font-bold uppercase tracking-widest text-amber-400">Needs attention</p>
                    <button
                      onClick={() => setReviewHelpOpen((o) => !o)}
                      className="text-stone-400 hover:text-amber-400 text-[0.68rem] font-semibold flex items-center gap-1 transition-colors"
                      title="Why was this flagged?"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                      </svg>
                      {reviewHelpOpen ? "Hide tips" : "Guided help"}
                    </button>
                  </div>
                  {reasons && <p className="text-stone-500 text-[0.72rem] mt-0.5">{reasons}</p>}

                  {reviewHelpOpen && (
                    <div className="mt-2.5 mb-1.5 p-3 rounded-xl bg-amber-500/5 border border-amber-500/10 text-stone-300 text-xs leading-relaxed animate-fade-in">
                      <p className="font-semibold text-amber-400 mb-1.5 flex items-center gap-1">
                        💡 How to resolve this scan:
                      </p>
                      <ul className="list-disc pl-4 space-y-1.5 text-stone-400 text-[0.72rem]">
                        {isLow && (
                          <li><strong>Verify Inscription:</strong> Use the <strong>Relief Lens</strong> on the photo to enhance weathered carvings and verify the transcription.</li>
                        )}
                        {missingDates && (
                          <li><strong>Add Missing Dates:</strong> Tap the pencil edit icon next to details to supply birth or death years if they are visible but were missed by the AI.</li>
                        )}
                        {unusualChars && (
                          <li><strong>Clean Up Name:</strong> Names containing special symbols, brackets, or numbers should be cleaned up via editing.</li>
                        )}
                        <li>If the details are fully correct, tap <strong>Looks correct</strong> to approve the scan and move it to your active Markers library.</li>
                      </ul>
                    </div>
                  )}
                </div>
                <div className="flex border-t border-amber-500/10 divide-x divide-amber-500/10">
                  <button
                    onClick={() => handleRefreshData()}
                    className="flex-1 px-2 py-2.5 text-[0.72rem] font-semibold text-amber-300 text-center active:bg-white/5 transition-colors"
                  >
                    Re-analyze photo
                  </button>
                  <button
                    onClick={() => handleRefreshData(extracted, true)}
                    className="flex-1 px-2 py-2.5 text-[0.72rem] font-semibold text-stone-400 text-center active:bg-white/5 transition-colors"
                  >
                    Refresh research
                  </button>
                  <button
                    onClick={() => handleMarkReviewed()}
                    className="flex-1 px-2 py-2.5 text-[0.72rem] font-semibold text-amber-400 text-center active:bg-white/5 transition-colors"
                  >
                    Looks correct
                  </button>
                </div>
              </div>
            );
          })()}

          {/* Stale-research banner: shown for archived graves loaded from IDB
              that haven't been refreshed this session. Fades once ↺ is tapped. */}
          {isArchivedLoad.current && !researchLoading && !refreshing && !shouldReview(graveRecord) && (
            <button
              onClick={() => handleRefreshData()}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-left mb-1 transition-colors active:opacity-80"
              style={{ background: "rgba(201,168,76,0.06)", border: "1px solid rgba(201,168,76,0.18)" }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium" style={{ color: "var(--t-gold-400)" }}>
                  Records loaded from archive
                </p>
                <p className="text-stone-500 text-[0.72rem] mt-0.5">
                  Tap to re-analyze photo and refresh all research
                </p>
              </div>
            </button>
          )}

                    {/* Sign in to unlock research card */}
          {authRequired && !researchLoading && (
            <div className="rounded-2xl p-4 mb-4 border border-amber-500/20 bg-amber-500/5 text-center">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-2 text-amber-500">
                <rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
              <h4 className="text-stone-200 text-sm font-semibold">Sign in to unlock historical research</h4>
              <p className="text-stone-500 text-xs mt-1 leading-relaxed max-w-[280px] mx-auto">
                GraveLens queries public records APIs to reconstruct this person&apos;s life history. Sign in with a free account to view them.
              </p>
              <Link
                href="/login"
                className="inline-block mt-3 px-4 py-2 rounded-xl text-xs font-semibold text-[#1a1917]"
                style={{ background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }}
              >
                Sign In / Sign Up
              </Link>
            </div>
          )}

          {!authRequired && (
            <>
              {/* Military context — most significant record type, always first */}
          {(research?.militaryContext || researchLoading) && (
            <MilitaryCard
              context={research?.militaryContext}
              naraRecords={research?.naraRecords}
              loading={researchLoading}
            />
          )}

          {/* Cross-source conflict warning — flag before user reads individual records */}
          {!researchLoading && research && (
            <ConflictWarningCard extracted={activeExtracted} research={research} />
          )}

          {/* All person-record research collapsed into one entry point (plan Step 4) */}
          <ResearchSummaryCard
            research={research}
            graveId={pending.id}
            loading={researchLoading}
          />
            </>
          )}


          {/* ── ZONE 6: CONNECTIONS ── Relationships ──────────────────────── */}

          <FamilyConnectionHints graveId={pending.id} extracted={activeExtracted} location={location} />

          {/* ── ZONE 7: ACTIONS ── Save, share, contribute ────────────────── */}

          {/* Tags */}
          <TagsCard tags={tags} onChange={handleTagsChange} />



          {/* FamilySearch Tree Collision Alert Badge */}
          {research?.treeCollision?.hit && (
            <div className="p-3.5 rounded-xl border bg-stone-900 border-amber-500/20 text-stone-300 text-xs flex items-start gap-3.5">
              <span className="text-lg leading-none mt-0.5">🌳</span>
              <div className="flex-1">
                <p className="font-semibold text-stone-200">
                  Person may already be documented
                </p>
                <p className="text-stone-400 mt-0.5 leading-relaxed">
                  A matching profile exists in the public FamilySearch Family Tree.
                </p>
                {research.treeCollision.url && (
                  <a
                    href={research.treeCollision.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center text-xs font-semibold mt-2 hover:text-white"
                    style={{ color: "var(--t-gold-500)" }}
                  >
                    View tree search results ↗
                  </a>
                )}
              </div>
            </div>
          )}

          {/* Find A Grave submission helper */}
          {!researchLoading && activeExtracted.name && (activeExtracted.birthYear || activeExtracted.deathYear) && (
            <FindAGraveSubmitCard extracted={activeExtracted} location={location} />
          )}

        </div>

        <div className="mx-5 lg:mx-8 mt-4">
          <Link
            href="/archive"
            className="flex items-center justify-center gap-2 h-11 rounded-xl border border-stone-700 text-stone-300 text-sm w-full"
          >
            View in Archive →
          </Link>
        </div>
      </main>

      {/* Desktop image panel — right column, fills height, no gradient */}
      <aside className="hidden lg:block lg:basis-[40%] lg:shrink-0 relative overflow-hidden border-l border-stone-800">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={activePhotoUrl || photoDataUrl}
          alt="Grave marker"
          className="w-full h-full object-cover object-center cursor-pointer"
          onClick={() => setPhotoFullscreen(true)}
        />
        {/* Additional photos thumbnails overlay */}
        {graveRecord?.additionalPhotos && graveRecord.additionalPhotos.length > 0 && (
          <div className="absolute bottom-4 left-4 flex gap-1.5 z-10 animate-fade-up" onClick={(e) => e.stopPropagation()}>
            {[photoDataUrl, ...graveRecord.additionalPhotos].map((photo, index) => (
              <button
                key={index}
                onClick={() => setActivePhotoUrl(photo)}
                className={`w-12 h-12 rounded-lg overflow-hidden border-2 transition-all ${
                  (activePhotoUrl || photoDataUrl) === photo ? "border-gold-500 scale-105" : "border-stone-850 opacity-70 hover:opacity-90"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo} alt="" className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        )}
        {/* Confidence badge */}
        {extracted.confidence && (
          <ConfidenceBadge confidence={extracted.confidence} extracted={extracted} offsetClass="top-4 right-4" />
        )}
        {/* Expand to fullscreen */}
        <button
          onClick={() => setPhotoFullscreen(true)}
          className="absolute bottom-4 right-4 w-8 h-8 rounded-full flex items-center justify-center bg-stone-900/70 backdrop-blur-sm hover:bg-stone-900/90 transition-colors"
          aria-label="View fullscreen"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#b0aba6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
          </svg>
        </button>
      </aside>

      </div>{/* end desktop split wrapper */}

      {/* Review prompt — shown when name is empty or confidence is low */}
      {reviewPrompt && (
        <ReviewPromptSheet
          onEnterName={(name) => {
            setReviewPrompt(false);
            handleExtractedEdit({ name });
          }}
          onSaveLater={handleSaveForLater}
          onConfirmCorrect={() => {
            setReviewPrompt(false);
            handleMarkReviewed();
          }}
          personName={(extractedOverride?.name ?? pending?.extracted.name ?? "").trim()}
          isArchived={isArchivedLoad.current}
        />
      )}

      {/* Share sheet fallback */}
      {shareOpen && (
        <ShareSheet
          record={graveRecord}
          onClose={() => setShareOpen(false)}
        />
      )}

      {/* Achievement unlock notification — single count pill or rank-up hero */}
      {unlockToast && (
        <AchievementUnlockToast state={unlockToast} onDismiss={() => setUnlockToast(null)} />
      )}

      <BottomNav />

      {/* Fullscreen photo viewer */}
      {photoFullscreen && (
        <div
          className="fixed inset-0 z-[60] flex flex-col bg-stone-950"
          style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          {/* Tap image to close */}
          <div className="flex-1 flex items-center justify-center overflow-hidden" onClick={() => setPhotoFullscreen(false)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photoDataUrl}
              alt="Grave marker"
              className="max-w-full max-h-full object-contain"
              style={{ touchAction: "pinch-zoom" }}
            />
          </div>

          {/* Action bar */}
          <div className="shrink-0 flex items-center justify-between px-6 py-4 border-t border-stone-800 bg-stone-950">
            <button
              onClick={() => setPhotoFullscreen(false)}
              className="flex items-center gap-2 text-stone-400 active:text-stone-200"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12"/>
              </svg>
              <span className="text-sm">Close</span>
            </button>

            <div className="flex items-center gap-4">
              {/* Download */}
              <a
                href={photoDataUrl}
                download={`${extracted.name || "grave-marker"}.jpg`}
                className="flex items-center gap-1.5 text-stone-300 active:text-stone-100"
                onClick={(e) => e.stopPropagation()}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                <span className="text-sm">Save</span>
              </a>

              {/* Share */}
              <button
                onClick={(e) => { e.stopPropagation(); handleShare(); }}
                className="flex items-center gap-1.5 text-stone-300 active:text-stone-100"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
                  <polyline points="16 6 12 2 8 6"/>
                  <line x1="12" y1="2" x2="12" y2="15"/>
                </svg>
                <span className="text-sm">Share</span>
              </button>

              {/* Edit photo */}
              <button
                onClick={(e) => { e.stopPropagation(); setPhotoEditing(true); }}
                className="flex items-center gap-1.5 text-stone-300 active:text-stone-100"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
                <span className="text-sm">Edit</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Photo editor */}
      {photoEditing && (
        <PhotoEditorModal
          photoDataUrl={photoDataUrl}
          graveName={extracted.name}
          onSave={handlePhotoSave}
          onClose={() => setPhotoEditing(false)}
        />
      )}

      {/* Nearby-records bulk-update prompt */}
      {nearbyPrompt && (
        <div className="fixed inset-0 z-50 flex items-end lg:items-center justify-center p-4 lg:p-6 pb-safe">
          <div className="absolute inset-0 bg-stone-950/70 backdrop-blur-sm" onClick={() => setNearbyPrompt(null)} />
          <div
            className="relative w-full max-w-sm rounded-2xl p-5 flex flex-col gap-4"
            style={{ background: "rgb(30 28 26)", border: "1px solid rgb(60 56 50)" }}
          >
            <div className="flex flex-col gap-1">
              <p className="text-stone-100 font-semibold text-base">Update nearby records?</p>
              <p className="text-stone-400 text-sm leading-relaxed">
                {nearbyPrompt.records.length} other{" "}
                {nearbyPrompt.records.length === 1 ? "record" : "records"} in this area{" "}
                {nearbyPrompt.records.every((g) => !g.location?.cemetery)
                  ? "also have no cemetery listed"
                  : "are in the same area"}
                . Set them all to{" "}
                <span className="text-stone-200 font-medium">&ldquo;{nearbyPrompt.name}&rdquo;</span>?
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setNearbyPrompt(null)}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium text-stone-300 bg-stone-800 active:bg-stone-700"
              >
                No, just this one
              </button>
              <button
                onClick={handleNearbyYes}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold"
                style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
              >
                Yes, update all
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cemetery prompt — shown when refresh finds no cemetery */}
      {cemeteryPrompt != null && (
        <div
          className="fixed left-1/2 -translate-x-1/2 z-[70] flex items-center gap-2.5 px-4 py-2.5 rounded-2xl shadow-xl"
          style={{
            top: "calc(env(safe-area-inset-top, 0px) + 3.5rem)",
            background: "rgba(var(--glass-bg-rgb), 0.96)",
            border: "1px solid rgba(201,168,76,0.3)",
            backdropFilter: "blur(12px)",
          }}
        >
          <div
            className="w-3.5 h-3.5 border-2 border-t-transparent rounded-full animate-spin shrink-0"
            style={{ borderColor: "var(--t-gold-500) transparent var(--t-gold-500) var(--t-gold-500)" }}
          />
          <span className="text-xs text-stone-300 font-medium">
            {cemeteryPrompt === "locating" ? "Getting your location…" : "Looking up cemetery location…"}
          </span>
        </div>
      )}

    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

/**
 * Return the most accurate age-at-death for display.
 * When both birthYear and deathYear are known, their difference is the ground
 * truth (±1 for pre-birthday deaths). If the inscribed ageAtDeath disagrees
 * by more than 1 year it was likely misread — use the computed value instead.
 */
function resolveAge(extracted: ExtractedGraveData): number | null {
  const { ageAtDeath, birthYear, deathYear } = extracted;
  if (birthYear != null && deathYear != null && deathYear > birthYear) {
    const computed = deathYear - birthYear;
    if (ageAtDeath == null || Math.abs(ageAtDeath - computed) > 1) return computed;
  }
  return ageAtDeath ?? null;
}

function PrimaryCard({
  extracted,
  onSave,
  people,
  selectedPersonIdx = 0,
  onSelectPerson,
}: {
  extracted: ExtractedGraveData;
  onSave?: (patch: Partial<ExtractedGraveData>) => void;
  people?: PersonData[];
  selectedPersonIdx?: number;
  onSelectPerson?: (idx: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(extracted.name ?? "");
  const [birthDate, setBirthDate] = useState(extracted.birthDate ?? "");
  const [deathDate, setDeathDate] = useState(extracted.deathDate ?? "");

  // Keep fields in sync if parent updates extracted (e.g. after refresh)
  useEffect(() => {
    if (!editing) {
      setTimeout(() => {
        setName(extracted.name ?? "");
        setBirthDate(extracted.birthDate ?? "");
        setDeathDate(extracted.deathDate ?? "");
      }, 0);
    }
  }, [extracted, editing]);

  const handleSave = () => {
    onSave?.({ name, birthDate, deathDate });
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="py-6 animate-fade-up flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[0.75rem] uppercase tracking-widest text-stone-500 font-bold">Name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="bg-stone-800 text-stone-100 text-lg font-serif rounded-lg px-3 py-2 border border-stone-700 focus:outline-none focus:border-stone-500"
          />
        </div>
        <div className="flex gap-3">
          <div className="flex flex-col gap-1 flex-1">
            <label className="text-[0.75rem] uppercase tracking-widest text-stone-500 font-bold">Birth Date</label>
            <input
              value={birthDate}
              onChange={(e) => setBirthDate(e.target.value)}
              placeholder="e.g. Mar 4, 1842"
              className="bg-stone-800 text-stone-200 text-sm rounded-lg px-3 py-2 border border-stone-700 focus:outline-none focus:border-stone-500"
            />
          </div>
          <div className="flex flex-col gap-1 flex-1">
            <label className="text-[0.75rem] uppercase tracking-widest text-stone-500 font-bold">Death Date</label>
            <input
              value={deathDate}
              onChange={(e) => setDeathDate(e.target.value)}
              placeholder="e.g. Jan 12, 1901"
              className="bg-stone-800 text-stone-200 text-sm rounded-lg px-3 py-2 border border-stone-700 focus:outline-none focus:border-stone-500"
            />
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <button
            onClick={handleSave}
            className="flex-1 h-9 rounded-lg text-[#1a1917] text-sm font-semibold"
            style={{ background: "var(--t-gold-500)" }}
          >
            Save
          </button>
          <button
            onClick={() => setEditing(false)}
            className="flex-1 h-9 rounded-lg text-stone-400 text-sm border border-stone-700"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="py-6 animate-fade-up">
      {/* Person picker — shown when marker has multiple people */}
      {people && people.length > 1 && (
        <div className="flex flex-wrap gap-2 mb-5">
          {people.map((person, idx) => (
            <button
              key={idx}
              onClick={() => onSelectPerson?.(idx)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                selectedPersonIdx === idx
                  ? "bg-gold-500/15 border-gold-500/50 text-gold-400"
                  : "bg-stone-800 border-stone-700 text-stone-400 active:border-stone-500"
              }`}
            >
              {toNameCase(person.firstName || person.name) || `Person ${idx + 1}`}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-start justify-between gap-2">
        {extracted.name ? (
          <h1 className="font-serif text-3xl font-bold text-stone-50 leading-tight mb-3">
            {toNameCase(extracted.name)}
          </h1>
        ) : (
          <h1 className="font-serif text-3xl font-bold text-stone-500 leading-tight mb-3 italic">
            Unknown
          </h1>
        )}
        {onSave && (
          <button
            onClick={() => setEditing(true)}
            className="mt-1 shrink-0 text-stone-500 active:text-stone-200"
            aria-label="Edit details"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {(extracted.birthDate || extracted.deathDate) && (
          <div>
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-0.5">Dates</p>
            <p className="text-stone-200 font-medium">
              {[extracted.birthDate, extracted.deathDate].filter(Boolean).join(" — ")}
            </p>
          </div>
        )}
        {resolveAge(extracted) != null && (
          <div>
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-0.5">Age</p>
            <p className="text-stone-200 font-medium">{resolveAge(extracted)} years</p>
          </div>
        )}
        {extracted.markerType && extracted.markerType !== "headstone" && (
          <div>
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-0.5">Marker</p>
            <p className="text-stone-200 font-medium capitalize">{extracted.markerType}</p>
          </div>
        )}
        {extracted.material && extracted.material !== "unknown" && (
          <div>
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-0.5">Material</p>
            <p className="text-stone-200 font-medium capitalize">{extracted.material}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function CemeteryCard({
  location,
  research,
  onSave,
  onLocate,
}: {
  location: GeoLocation;
  research: ResearchData | null;
  onSave?: (name: string) => Promise<void>;
  onLocate?: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(location.cemetery ?? "");
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);

  const handleLocate = async () => {
    if (!onLocate) return;
    setLocating(true);
    await onLocate();
    setLocating(false);
  };
  const cemeteryUrl = research?.cemetery?.wikipediaUrl;

  const handleSave = async () => {
    const name = editValue.trim();
    if (!name || !onSave) return;
    setSaving(true);
    await onSave(name);
    setSaving(false);
    setEditing(false);
  };

  return (
    <div className="py-5 animate-fade-up" style={{ animationDelay: "0.05s" }}>
      <SectionHeader icon="📍" title="Location" />
      <div className="flex flex-col gap-1 mt-3">
        {editing ? (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") setEditing(false); }}
              placeholder="Cemetery name"
              className="flex-1 bg-stone-800 text-stone-200 text-sm rounded-lg px-3 py-1.5 border border-stone-600 focus:outline-none focus:border-stone-400"
            />
            <button
              onClick={handleSave}
              disabled={saving || !editValue.trim()}
              className="px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-40"
              style={{ background: "var(--t-gold-500)", color: "#1a1917" }}
            >
              {saving ? "…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="px-2 py-1.5 rounded-lg text-sm text-stone-400 active:text-stone-200"
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              {location.cemetery ? (
                <p className="text-stone-200 font-medium">{location.cemetery}</p>
              ) : (
                <p className="text-stone-500 text-sm italic">No cemetery on record</p>
              )}
              {cemeteryUrl && (
                <a
                  href={cemeteryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gold-500 text-xs underline"
                >
                  Wikipedia →
                </a>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0 mt-0.5">
              {onLocate && !location.cemetery && (
                <button
                  onClick={handleLocate}
                  disabled={locating}
                  className="text-stone-500 active:text-stone-300 disabled:opacity-40"
                  aria-label="Detect cemetery location"
                  title="Detect cemetery location"
                >
                  {locating ? (
                    <div className="w-3.5 h-3.5 border border-t-transparent rounded-full animate-spin" style={{ borderColor: "currentColor transparent currentColor currentColor" }} />
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                      <circle cx="12" cy="9" r="2.5"/>
                    </svg>
                  )}
                </button>
              )}
              {onSave && (
                <button
                  onClick={() => { setEditValue(location.cemetery ?? ""); setEditing(true); }}
                  className="text-stone-500 active:text-stone-300"
                  aria-label="Edit cemetery"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </button>
              )}
            </div>
          </div>
        )}
        {location.city && location.state && (
          <p className="text-stone-400 text-sm">
            {location.city}, {location.state}
          </p>
        )}
        {location.lat !== 0 && (
          <div className="flex gap-2 mt-2">
            <a
              href={`https://maps.apple.com/?q=${encodeURIComponent(location.cemetery || "Grave Location")}&ll=${location.lat},${location.lng}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[0.8rem] font-semibold text-stone-200 border border-stone-700 bg-stone-800 active:bg-stone-700 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#007AFF"/><path d="M12 7l4 10-4-2-4 2 4-10z" fill="white"/></svg>
              Apple Maps
            </a>
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location.cemetery || "Grave Location")}&center=${location.lat},${location.lng}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[0.8rem] font-semibold text-stone-200 border border-stone-700 bg-stone-800 active:bg-stone-700 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#4285F4"/><circle cx="12" cy="9" r="2.5" fill="#FBBC05"/></svg>
              Google Maps
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function HistoricalCard({
  historical,
  extracted,
  loading,
}: {
  historical: ResearchData["historical"] | undefined;
  extracted: ExtractedGraveData;
  loading: boolean;
}) {
  const [landmarksExpanded, setLandmarksExpanded] = useState(false);

  if (loading && !historical) {
    return (
      <div className="py-5 animate-fade-up" style={{ animationDelay: "0.1s" }}>
        <SectionHeader icon="📖" title="Historical Context" />
        <div className="mt-3 space-y-4">
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {[1, 2].map((n) => (
              <div key={n} className="w-24">
                <div className="h-3 shimmer rounded w-2/3 mb-1.5" />
                <div className="h-4 shimmer rounded w-5/6" />
              </div>
            ))}
          </div>
          <div className="p-3 rounded-xl bg-stone-800/40 border border-stone-700/50">
            <div className="h-3 shimmer rounded w-16 mb-2" />
            <div className="h-4 shimmer rounded w-5/6" />
          </div>
        </div>
      </div>
    );
  }

  if (!historical) return null;

  const hasContent =
    historical.birthEra ||
    historical.deathEra ||
    historical.birthYearEvents?.length ||
    historical.deathYearEvents?.length ||
    historical.lifetimeLandmarks?.length;

  if (!hasContent) return null;

  const landmarks = historical.lifetimeLandmarks ?? [];
  const visibleLandmarks = landmarksExpanded ? landmarks : landmarks.slice(0, 5);

  return (
    <div className="py-5 animate-fade-up" style={{ animationDelay: "0.1s" }}>
      <SectionHeader icon="📖" title="Historical Context" />
      <div className="mt-3 space-y-4">

        {/* Era + life expectancy */}
        {(historical.birthEra || historical.deathEra) && (
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            {historical.birthEra && (
              <div>
                <p className="text-xs text-stone-500 uppercase tracking-widest mb-0.5">Born in</p>
                <p className="text-stone-300 text-sm">{historical.birthEra}</p>
              </div>
            )}
            {historical.deathEra && historical.deathEra !== historical.birthEra && (
              <div>
                <p className="text-xs text-stone-500 uppercase tracking-widest mb-0.5">Died in</p>
                <p className="text-stone-300 text-sm">{historical.deathEra}</p>
              </div>
            )}
            {historical.lifeExpectancyAtDeath && resolveAge(extracted) != null && (
              <div>
                <p className="text-xs text-stone-500 uppercase tracking-widest mb-0.5">Life expectancy then</p>
                <p className="text-stone-300 text-sm">
                  ~{historical.lifeExpectancyAtDeath} yrs
                  <span className="text-stone-500 ml-1">
                    (lived to {resolveAge(extracted)})
                  </span>
                </p>
              </div>
            )}
          </div>
        )}

        {/* Birth year events */}
        {historical.birthYearEvents && historical.birthYearEvents.length > 0 && (
          <div className="p-3 rounded-xl bg-stone-800 border border-stone-700/60">
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">
              The World in {extracted.birthYear}
            </p>
            <ul className="space-y-1.5">
              {historical.birthYearEvents.map((e, i) => (
                <li key={i} className="text-stone-300 text-sm leading-relaxed flex gap-2">
                  <span className="text-stone-600 mt-0.5 shrink-0">—</span>
                  <span>{e}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Death year events */}
        {historical.deathYearEvents && historical.deathYearEvents.length > 0 && (
          <div className="p-3 rounded-xl bg-stone-800 border border-stone-700/60">
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">
              The World in {extracted.deathYear}
            </p>
            <ul className="space-y-1.5">
              {historical.deathYearEvents.map((e, i) => (
                <li key={i} className="text-stone-300 text-sm leading-relaxed flex gap-2">
                  <span className="text-stone-600 mt-0.5 shrink-0">—</span>
                  <span>{e}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Landmark events lived through */}
        {landmarks.length > 0 && (
          <div>
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">
              Events witnessed in their lifetime
            </p>
            <div className="relative">
              {/* Timeline line */}
              <div className="absolute left-[52px] top-0 bottom-0 w-px bg-stone-700" />
              <ul className="space-y-3">
                {visibleLandmarks.map((lm, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <div className="text-right shrink-0 w-10">
                      <span className="text-gold-500 text-xs font-mono">{lm.year}</span>
                    </div>
                    {/* Timeline dot */}
                    <div className="w-2.5 h-2.5 rounded-full bg-stone-600 border border-stone-500 mt-1 shrink-0 relative z-10" />
                    <div className="flex-1 min-w-0">
                      <p className="text-stone-300 text-sm leading-snug">{lm.event}</p>
                      <p className="text-stone-600 text-xs mt-0.5">Age {lm.age}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            {landmarks.length > 5 && (
              <button
                onClick={() => setLandmarksExpanded((e) => !e)}
                className="text-gold-500 text-xs mt-3 ml-[52px]"
              >
                {landmarksExpanded
                  ? "Show fewer events"
                  : `Show all ${landmarks.length} events`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function InscriptionCard({
  inscription,
  epitaph,
  epitaphSource,
  epitaphMeaning,
  onSave,
}: {
  inscription: string;
  epitaph: string;
  epitaphSource?: string;
  epitaphMeaning?: string;
  onSave?: (inscription: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(inscription ?? "");
  const shouldTruncate = !editing && inscription.length > 200;

  useEffect(() => {
    if (!editing) {
      setTimeout(() => {
        setDraft(inscription ?? "");
      }, 0);
    }
  }, [inscription, editing]);

  const handleSave = () => {
    onSave?.(draft);
    setEditing(false);
  };

  return (
    <div className="py-5 animate-fade-up" style={{ animationDelay: "0.15s" }}>
      <div className="flex items-center justify-between mb-1">
        <SectionHeader icon="✦" title="Inscription" />
        {onSave && !editing && (
          <button
            onClick={() => setEditing(true)}
            className="text-stone-500 active:text-stone-200"
            aria-label="Edit inscription"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
        )}
      </div>

      {epitaph && !editing && (
        <div className="mt-3 mb-3">
          <p className="font-serif text-stone-300 italic text-base leading-relaxed border-l-2 border-stone-600 pl-3">
            &ldquo;{epitaph}&rdquo;
          </p>
          {(epitaphSource || epitaphMeaning) && (
            <div className="mt-2 pl-3 space-y-1">
              {epitaphSource && <p className="text-stone-500 text-xs font-medium">{epitaphSource}</p>}
              {epitaphMeaning && <p className="text-stone-400 text-xs leading-relaxed">{epitaphMeaning}</p>}
            </div>
          )}
        </div>
      )}

      {editing ? (
        <div className="flex flex-col gap-2 mt-2">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            className="w-full bg-stone-800 text-stone-200 text-sm font-mono rounded-lg px-3 py-2 border border-stone-700 focus:outline-none focus:border-stone-500 resize-none leading-relaxed"
          />
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              className="flex-1 h-9 rounded-lg text-[#1a1917] text-sm font-semibold"
              style={{ background: "var(--t-gold-500)" }}
            >
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              className="flex-1 h-9 rounded-lg text-stone-400 text-sm border border-stone-700"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {inscription ? (
            <div
              className={`mt-2 font-mono text-stone-400 text-sm leading-relaxed whitespace-pre-wrap ${
                !expanded && shouldTruncate ? "line-clamp-6" : ""
              }`}
            >
              {inscription}
            </div>
          ) : (
            <p className="mt-2 text-stone-600 text-sm italic">No inscription recorded.</p>
          )}
          {shouldTruncate && (
            <button onClick={() => setExpanded((e) => !e)} className="text-stone-500 text-xs mt-2">
              {expanded ? "Show less" : "Show full inscription"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function SymbolsCard({ symbols }: { symbols: string[] }) {
  const interpretations = interpretSymbols(symbols);

  return (
    <div className="py-5 animate-fade-up" style={{ animationDelay: "0.2s" }}>
      <SectionHeader icon="✦" title="Symbols & Emblems" />
      <div className="mt-3 space-y-3">
        {symbols.map((s, i) => {
          const interp = interpretations.get(s);
          return (
            <div key={i} className="rounded-xl bg-stone-800 border border-stone-700/60 p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-gold-500 text-xs">✦</span>
                <p className="text-stone-200 text-sm font-medium">{s}</p>
                {interp && (
                  <span className="text-[0.65rem] uppercase tracking-widest text-stone-600 capitalize ml-1">
                    {interp.category}
                  </span>
                )}
              </div>
              {interp ? (
                <>
                  <p className="text-stone-300 text-xs leading-relaxed">{interp.meaning}</p>
                  {interp.era && (
                    <p className="text-stone-500 text-xs italic mt-1">{interp.era}</p>
                  )}
                </>
              ) : (
                <p className="text-stone-500 text-xs italic">Symbol noted on marker</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MilitaryCard({
  context,
  naraRecords,
  loading,
}: {
  context: import("@/types").MilitaryContext | undefined;
  naraRecords: import("@/types").NaraRecord[] | undefined;
  loading: boolean;
}) {
  if (loading && !context) {
    return (
      <div className="py-5 animate-fade-up" style={{ animationDelay: "0.08s" }}>
        <SectionHeader icon="🎖" title="Military Service" />
        <div className="mt-3 space-y-4">
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {[1, 2, 3].map((n) => (
              <div key={n} className="w-24">
                <div className="h-3 shimmer rounded w-2/3 mb-1.5" />
                <div className="h-4 shimmer rounded w-5/6" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!context) return null;

  const naraSearchName = context.likelyConflict
    ? `https://catalog.archives.gov/search?q=${encodeURIComponent(context.likelyConflict)}&levelOfDescription=item`
    : "https://catalog.archives.gov";

  return (
    <div className="py-5 animate-fade-up" style={{ animationDelay: "0.08s" }}>
      <SectionHeader icon="🎖" title="Military Service" />

      <div className="mt-3 space-y-4">
        {/* Conflict + service dates */}
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {context.likelyConflict && (
            <div>
              <p className="text-xs text-stone-500 uppercase tracking-widest mb-0.5">Conflict</p>
              <p className="text-stone-200 font-medium">{context.likelyConflict}</p>
            </div>
          )}
          {context.servedDuring && (
            <div>
              <p className="text-xs text-stone-500 uppercase tracking-widest mb-0.5">US Service Period</p>
              <p className="text-stone-200 font-medium">{context.servedDuring}</p>
            </div>
          )}
          {context.theater && (
            <div>
              <p className="text-xs text-stone-500 uppercase tracking-widest mb-0.5">Theater</p>
              <p className="text-stone-200 font-medium">{context.theater}</p>
            </div>
          )}
        </div>

        {/* Role + description */}
        {(context.role || context.roleDescription) && (
          <div className="p-3 rounded-xl bg-stone-800 border border-stone-700/60">
            {context.role && (
              <p className="text-xs text-stone-500 uppercase tracking-widest mb-1.5">{context.role}</p>
            )}
            {context.roleDescription && (
              <p className="text-stone-300 text-sm leading-relaxed">{context.roleDescription}</p>
            )}
          </div>
        )}

        {/* Historical note */}
        {context.historicalNote && (
          <p className="text-stone-400 text-sm leading-relaxed italic border-l-2 border-stone-700 pl-3">
            {context.historicalNote}
          </p>
        )}

        {/* Inferred disclaimer */}
        {context.inferredFrom === "dates" && (
          <p className="text-stone-600 text-xs">
            Conflict inferred from life dates — not confirmed by inscription.
          </p>
        )}

        {/* NARA records if found */}
        {naraRecords && naraRecords.length > 0 && (
          <div>
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">National Archives Records</p>
            <ul className="space-y-2">
              {naraRecords.map((r, i) => (
                <li key={i}>
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block p-3 rounded-xl bg-stone-800 border border-stone-700 active:bg-stone-750"
                  >
                    <p className="text-stone-200 text-sm font-medium line-clamp-2">{r.title}</p>
                    {r.recordGroup && (
                      <p className="text-stone-500 text-xs mt-0.5">Record Group {r.recordGroup}</p>
                    )}
                    {r.description && (
                      <p className="text-stone-400 text-xs mt-1 line-clamp-2">{r.description}</p>
                    )}
                    <p className="text-gold-500 text-xs mt-1">View in NARA →</p>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Always offer a NARA search link */}
        <a
          href={naraSearchName}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-gold-500 text-sm"
        >
          Search National Archives
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 6h8M6 2l4 4-4 4" />
          </svg>
        </a>
      </div>
    </div>
  );
}

// ── Tags ─────────────────────────────────────────────────────────────────────

const PRESET_TAGS = [
  "Relative",
  "Ancestor",
  "Veteran",
  "Notable",
  "Historic",
  "Needs research",
  "Mystery",
];

function TagsCard({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (next: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [customValue, setCustomValue] = useState("");

  const customTags = tags.filter((t) => !PRESET_TAGS.includes(t));

  const toggle = (tag: string) => {
    onChange(tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag]);
  };

  const addCustom = () => {
    const val = customValue.trim();
    if (!val || tags.includes(val)) return;
    onChange([...tags, val]);
    setCustomValue("");
    setAdding(false);
  };

  const remove = (tag: string) => onChange(tags.filter((t) => t !== tag));

  return (
    <div className="py-5 animate-fade-up" style={{ animationDelay: "0.22s" }}>
      <SectionHeader icon="🏷" title="Tags" />
      <div className="mt-3 flex flex-wrap gap-2">
        {PRESET_TAGS.map((tag) => {
          const active = tags.includes(tag);
          return (
            <button
              key={tag}
              onClick={() => toggle(tag)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                active
                  ? "bg-gold-500/15 border-gold-500/50 text-gold-400"
                  : "bg-stone-800 border-stone-700 text-stone-400 active:border-stone-500"
              }`}
            >
              {active && <span className="mr-1 text-gold-500">✓</span>}
              {tag}
            </button>
          );
        })}

        {/* Custom tags */}
        {customTags.map((tag) => (
          <span
            key={tag}
            className="flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium bg-moss-700/30 border border-moss-600/40 text-moss-400"
          >
            {tag}
            <button
              onClick={() => remove(tag)}
              className="text-stone-500 active:text-red-400 ml-0.5 leading-none"
              aria-label={`Remove ${tag}`}
            >
              ×
            </button>
          </span>
        ))}

        {/* Add custom tag */}
        {adding ? (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              type="text"
              value={customValue}
              onChange={(e) => setCustomValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addCustom();
                if (e.key === "Escape") { setAdding(false); setCustomValue(""); }
              }}
              placeholder="Tag name…"
              className="px-3 py-1.5 rounded-full text-xs bg-stone-800 border border-stone-600 text-stone-200 w-28 outline-none focus:border-gold-500"
            />
            <button
              onClick={addCustom}
              disabled={!customValue.trim()}
              className="text-gold-500 text-xs disabled:opacity-40"
            >
              Add
            </button>
            <button
              onClick={() => { setAdding(false); setCustomValue(""); }}
              className="text-stone-500 text-xs"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="px-3 py-1.5 rounded-full text-xs border border-dashed border-stone-600 text-stone-500 active:border-stone-400"
          >
            + Custom
          </button>
        )}
      </div>
    </div>
  );
}

// ── Local History Card ────────────────────────────────────────────────────────

function LocalHistoryCard({
  localHistory,
  location,
  loading,
}: {
  localHistory: import("@/types").LocalHistoryContext | undefined;
  location: GeoLocation | null;
  loading: boolean;
}) {
  const [decadeExpanded, setDecadeExpanded] = useState(false);
  const [censusExpanded, setCensusExpanded] = useState(false);

  if (loading && !localHistory) {
    return (
      <div className="py-5 animate-fade-up" style={{ animationDelay: "0.13s" }}>
        <SectionHeader icon="🗺" title="Local History" />
        <div className="mt-3 space-y-5">
          <div>
            <div className="h-3 shimmer rounded w-1/4 mb-2" />
            <div className="space-y-1.5">
              <div className="h-3.5 shimmer rounded w-full" />
              <div className="h-3.5 shimmer rounded w-5/6" />
              <div className="h-3.5 shimmer rounded w-4/5" />
            </div>
            <div className="h-3 shimmer rounded w-32 mt-2" />
          </div>
        </div>
      </div>
    );
  }

  if (!localHistory) return null;

  const hasContent =
    localHistory.cityArticle ||
    localHistory.countyArticle ||
    localHistory.decadeSnapshots?.length ||
    localHistory.localNewspaper?.length ||
    localHistory.nrhpSites?.length ||
    localHistory.censusPopulation?.length ||
    localHistory.wikidataEvents?.length ||
    localHistory.sanbornMap ||
    localHistory.usGenWebRecords?.length;

  if (!hasContent) return null;

  const placeName = location?.city || location?.county || location?.state || "this area";

  return (
    <div className="py-5 animate-fade-up" style={{ animationDelay: "0.13s" }}>
      <SectionHeader icon="🗺" title="Local History" />
      <div className="mt-3 space-y-5">

        {/* City article */}
        {localHistory.cityArticle && (
          <div>
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-1.5">
              {localHistory.cityArticle.title}
            </p>
            <p className="text-stone-300 text-sm leading-relaxed">
              {localHistory.cityArticle.summary}
            </p>
            <a
              href={localHistory.cityArticle.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gold-500 text-xs mt-1 inline-block"
            >
              Read more on Wikipedia →
            </a>
          </div>
        )}

        {/* County article — only if different from city */}
        {localHistory.countyArticle &&
          localHistory.countyArticle.title !== localHistory.cityArticle?.title && (
          <div>
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-1.5">
              {localHistory.countyArticle.title}
            </p>
            <p className="text-stone-300 text-sm leading-relaxed">
              {localHistory.countyArticle.summary}
            </p>
            <a
              href={localHistory.countyArticle.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gold-500 text-xs mt-1 inline-block"
            >
              Read more on Wikipedia →
            </a>
          </div>
        )}

        {/* Decade snapshots */}
        {localHistory.decadeSnapshots && localHistory.decadeSnapshots.length > 0 && (
          <div>
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">
              The Region Through the Decades
            </p>
            <div className="space-y-3">
              {(decadeExpanded
                ? localHistory.decadeSnapshots
                : localHistory.decadeSnapshots.slice(0, 2)
              ).map((snap, i) => (
                <div key={i} className="p-3 rounded-xl bg-stone-800 border border-stone-700/60">
                  <p className="text-stone-400 text-xs uppercase tracking-wide mb-1.5">
                    {snap.label}
                  </p>
                  <ul className="space-y-1">
                    {snap.events.map((e, j) => (
                      <li key={j} className="text-stone-300 text-xs leading-relaxed flex gap-2">
                        <span className="text-stone-600 shrink-0">—</span>
                        <span>{e}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {localHistory.decadeSnapshots.length > 2 && (
              <button
                onClick={() => setDecadeExpanded((e) => !e)}
                className="text-gold-500 text-xs mt-2"
              >
                {decadeExpanded
                  ? "Show fewer decades"
                  : `Show all ${localHistory.decadeSnapshots.length} decades`}
              </button>
            )}
          </div>
        )}

        {/* NRHP historic sites */}
        {localHistory.nrhpSites && localHistory.nrhpSites.length > 0 && (
          <div>
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">
              Historic Sites Nearby
            </p>
            <ul className="space-y-2">
              {localHistory.nrhpSites.map((site, i) => (
                <li key={i} className="p-3 rounded-xl bg-stone-800 border border-stone-700/60">
                  <p className="text-stone-200 text-sm font-medium leading-snug">{site.name}</p>
                  {site.address && (
                    <p className="text-stone-500 text-xs mt-0.5">{site.address}</p>
                  )}
                  {site.wikidataUrl && (
                    <a
                      href={site.wikidataUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gold-500 text-xs mt-1 inline-block"
                    >
                      View on Wikidata →
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Wikidata local events */}
        {localHistory.wikidataEvents && localHistory.wikidataEvents.length > 0 && (
          <div>
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">
              Events Near {placeName}
            </p>
            <ul className="space-y-2">
              {localHistory.wikidataEvents.map((evt, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="text-gold-500 text-xs font-mono shrink-0 w-10 text-right">
                    {evt.year}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-stone-300 text-sm leading-snug">{evt.label}</p>
                    {evt.description && (
                      <p className="text-stone-500 text-xs mt-0.5 leading-snug">{evt.description}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Census county population */}
        {localHistory.censusPopulation && localHistory.censusPopulation.length > 0 && (
          <div>
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">
              {localHistory.censusPopulation[0].countyName
                ? `${localHistory.censusPopulation[0].countyName} Population`
                : "County Population"}
            </p>
            <div className="flex flex-wrap gap-3">
              {(censusExpanded
                ? localHistory.censusPopulation
                : localHistory.censusPopulation.slice(0, 3)
              ).map((entry, i) => (
                <div
                  key={i}
                  className="px-3 py-2 rounded-xl bg-stone-800 border border-stone-700/60 text-center"
                >
                  <p className="text-stone-500 text-[0.75rem] uppercase tracking-wide">{entry.year}</p>
                  <p className="text-stone-200 text-sm font-medium mt-0.5">
                    {entry.population.toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
            {localHistory.censusPopulation.length > 3 && (
              <button
                onClick={() => setCensusExpanded((e) => !e)}
                className="text-gold-500 text-xs mt-2"
              >
                {censusExpanded ? "Show fewer" : "Show all census years"}
              </button>
            )}
            <p className="text-stone-600 text-[0.75rem] mt-1.5">
              Census Bureau data — coverage begins 1990.
            </p>
          </div>
        )}

        {/* Local newspaper coverage */}
        {localHistory.localNewspaper && localHistory.localNewspaper.length > 0 && (
          <div>
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">
              Local Newspaper Coverage
            </p>
            <ul className="space-y-2">
              {localHistory.localNewspaper.map((article, i) => (
                <li key={i}>
                  <a
                    href={article.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block p-3 rounded-xl bg-stone-800 border border-stone-700 active:bg-stone-750"
                  >
                    <p className="text-stone-200 text-sm font-medium line-clamp-1">
                      {article.newspaper}
                    </p>
                    <p className="text-stone-500 text-xs mt-0.5">{article.date}</p>
                    {article.snippet && (
                      <p className="text-stone-400 text-xs mt-1 line-clamp-2">{article.snippet}</p>
                    )}
                    <p className="text-gold-500 text-xs mt-1">View page →</p>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Sanborn Fire Insurance Map */}
        {localHistory.sanbornMap && (
          <div className="bg-stone-900 border border-stone-800 rounded-xl overflow-hidden shadow-md flex flex-col sm:flex-row">
            {localHistory.sanbornMap.thumbnailUrl && (
              <div className="sm:w-1/3 shrink-0 relative bg-stone-950 flex items-center justify-center border-b sm:border-b-0 sm:border-r border-stone-800">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={localHistory.sanbornMap.thumbnailUrl}
                  alt="Historical Sanborn Map thumbnail"
                  className="max-h-48 sm:max-h-none sm:h-full w-full object-cover"
                  loading="lazy"
                />
              </div>
            )}
            <div className="p-4 flex flex-col justify-between flex-1 min-w-0">
              <div>
                <span className="text-[0.65rem] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide bg-amber-500/10 text-amber-500 border border-amber-500/20">
                  Historical Map
                </span>
                <h4 className="font-serif text-stone-100 text-sm font-semibold mt-2 mb-1.5 leading-snug">
                  {localHistory.sanbornMap.title}
                </h4>
                <p className="text-stone-400 text-xs leading-normal">
                  View the high-resolution fire insurance maps for this city and decade from the Library of Congress collections.
                </p>
              </div>
              <div className="mt-4 pt-3 border-t border-stone-800/60">
                <a
                  href={localHistory.sanbornMap.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center text-xs font-semibold hover:text-white"
                  style={{ color: "var(--t-gold-500)" }}
                >
                  Explore map sheets on loc.gov ↗
                </a>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

// ── Story Card (flagship "Hear Their Story") ──────────────────────────────────

function StoryCard({
  graveId,
  extracted,
  research,
  location,
  personIdx = 0,
  researchReady = false,
  onStoryGenerated,
}: {
  graveId: string;
  extracted: ExtractedGraveData;
  research: ResearchData | null;
  location: GeoLocation | null;
  personIdx?: number;
  /** True when research + cultural context are both loaded — triggers background pre-gen */
  researchReady?: boolean;
  onStoryGenerated: (epitaphSource: string, epitaphMeaning: string, script: string) => void;
}) {
  const gender = inferGender(extracted);
  const origin = inferOrigin(location, research);
  const voice  = selectVoice(gender, extracted.ageAtDeath, origin);
  // Include person index in cache key so each person's audio is stored separately
  const cacheKey = personIdx === 0 ? `story_${voice}` : `story_${voice}_p${personIdx}`;
  const initialScript = personIdx === 0
    ? (research?.storyScript ?? research?.storyScripts?.[0] ?? null)
    : (research?.storyScripts?.[personIdx] ?? null);

  const [audioDataUrl, setAudioDataUrl]   = useState<string | null>(null);
  const [loadingPhase, setLoadingPhase]   = useState<null | "crafting" | "recording">(null);
  const [hasError, setHasError]           = useState(false);
  const [scriptText, setScriptText]       = useState<string | null>(initialScript);
  const [scriptOpen, setScriptOpen]       = useState(false);
  const [playing, setPlaying]             = useState(false);
  const [progress, setProgress]           = useState(0);
  const [currentTime, setCurrentTime]     = useState(0);
  const [duration, setDuration]           = useState(0);
  const audioRef  = useRef<HTMLAudioElement | null>(null);
  const preGenRef = useRef<AbortController | null>(null);

  const hasEnoughData = !!(extracted.birthYear || extracted.deathYear || extracted.name);

  // Load cached audio on mount; reset script when person changes
  useEffect(() => {
    const script = personIdx === 0
      ? (research?.storyScript ?? research?.storyScripts?.[0] ?? null)
      : (research?.storyScripts?.[personIdx] ?? null);
    setScriptText(script);
    setAudioDataUrl(null);
    getAudio(graveId, cacheKey).then((cached) => {
      if (cached) setAudioDataUrl(cached);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graveId, cacheKey, personIdx]);

  // Wire audio events
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !audioDataUrl) return;
    // Only update src if not actively playing — setting src resets the media pipeline
    // and would interrupt in-progress playback.
    if (el.paused) {
      el.src = audioDataUrl;
    }
    // Always wire event listeners — they're cleaned up and re-added on each change.
    const onTime  = () => { setCurrentTime(el.currentTime); setProgress(el.duration ? el.currentTime / el.duration : 0); };
    const onDur   = () => setDuration(el.duration || 0);
    const onEnded = () => { setPlaying(false); setProgress(0); setCurrentTime(0); el.currentTime = 0; };
    const onPlay  = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("durationchange", onDur);
    el.addEventListener("ended", onEnded);
    el.addEventListener("play",  onPlay);
    el.addEventListener("pause", onPause);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("durationchange", onDur);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("play",  onPlay);
      el.removeEventListener("pause", onPause);
    };
  }, [audioDataUrl]);

  // ── Background pre-generation ─────────────────────────────────────────────
  // Fires once when research + cultural context are both ready (researchReady=true).
  // Generates story + TTS silently so audio is already cached when user taps.
  // Aborted immediately on unmount (navigation away) to avoid orphaned requests.
  useEffect(() => {
    if (!researchReady) return;
    if (personIdx !== 0) return;           // secondary persons only on explicit tap
    if (audioDataUrl || scriptText) return; // already have audio or script in state
    if (!hasEnoughData) return;
    if (!research?.culturalContext) return; // cultural context must be in memory

    const abort = new AbortController();
    preGenRef.current = abort;

    (async () => {
      try {
        // One shared id + action label for every AI call in this "Hear their
        // story" pre-generation, so the estimator sums them into one action.
        const hearStoryPromptId = crypto.randomUUID();
        let script: string;
        let epitaphSource = "";
        let epitaphMeaning = "";

        const savedScript = research?.storyScript ?? research?.storyScripts?.[0] ?? null;
        if (savedScript) {
          script = savedScript;
          epitaphSource = research.epitaphSource ?? research.epitaphSources?.[0] ?? "";
          epitaphMeaning = research.epitaphMeaning ?? research.epitaphMeanings?.[0] ?? "";
        } else {
          const storyRes = await fetch("/api/story", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: abort.signal,
            body: JSON.stringify({
              promptId: hearStoryPromptId,
              ...HEAR_STORY_USAGE,
              name: extracted.name,
              birthDate: extracted.birthDate,
              deathDate: extracted.deathDate,
              birthYear: extracted.birthYear,
              deathYear: extracted.deathYear,
              ageAtDeath: extracted.ageAtDeath,
              inscription: extracted.inscription,
              epitaph: extracted.epitaph,
              symbols: extracted.symbols ?? [],
              city: location?.city,
              state: location?.state,
              country: location?.country,
              cemetery: location?.cemetery,
              historical: research?.historical,
              militaryContext: research?.militaryContext,
              culturalSummary: (research.culturalContext as { categories?: unknown[] } | null)?.categories ?? [],
              ssdi: research?.ssdi?.filter((r) => r.matchConfidence === "high").slice(0, 1),
              historicalCensus: research?.historicalCensus?.slice(0, 2),
              immigration: research?.immigration?.slice(0, 1),
              symbolMeanings: (() => {
                const syms = extracted.symbols ?? [];
                if (!syms.length) return undefined;
                const map = interpretSymbols(syms);
                return syms.map((s) => {
                  const interp = map.get(s.toLowerCase());
                  return interp ? { symbol: s, meaning: interp.meaning, category: interp.category } : null;
                }).filter(Boolean);
              })(),
            }),
          });
          if (abort.signal.aborted || !storyRes.ok) return;
          ({ script, epitaphSource = "", epitaphMeaning = "" } = await storyRes.json());
          setScriptText(script);
          onStoryGenerated(epitaphSource, epitaphMeaning, script);
        }

        const ttsRes = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abort.signal,
          body: JSON.stringify({ text: script, voice, promptId: hearStoryPromptId, ...HEAR_STORY_USAGE }),
        });
        if (abort.signal.aborted || !ttsRes.ok) return;

        const audioBlob = await ttsRes.blob();
        if (abort.signal.aborted) return;

        // Save to IDB and expose as a data URL (no auto-play in background mode)
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(audioBlob);
        });
        await saveAudio(graveId, cacheKey, dataUrl);
        if (!abort.signal.aborted) setAudioDataUrl(dataUrl);
      } catch {
        // Abort errors are expected on unmount — all others are non-fatal
      }
    })();

    return () => { abort.abort(); preGenRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [researchReady, personIdx]);

  const handleHearStory = async () => {
    // Cancel any in-flight background pre-gen to avoid a race where both
    // compete to write the same IDB key at the same time.
    preGenRef.current?.abort();
    preGenRef.current = null;

    setHasError(false);
    setLoadingPhase("crafting");
    // One shared id + action label for every AI call in this tap, so the usage
    // estimator sums cultural + story + narration into one "Hear their story".
    const hearStoryPromptId = crypto.randomUUID();
    try {
      // ── Optimisation 1: reuse already-loaded cultural context ────────────
      // The page auto-loads cultural context after research arrives.
      // No need to re-fetch it — use what's already in memory.
      const cultural = research?.culturalContext ?? await fetch("/api/cultural", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "summary",
          promptId: hearStoryPromptId,
          ...HEAR_STORY_USAGE,
          name: extracted.name,
          birthYear: extracted.birthYear,
          deathYear: extracted.deathYear,
          ageAtDeath: extracted.ageAtDeath,
          city: location?.city,
          state: location?.state,
          ...getPersonalizationDetails(research),
        }),
      }).then((r) => r.ok ? r.json() : null).catch(() => null);

      // ── Optimisation 2: reuse cached story script ────────────────────────
      // If the script was already generated (stored in research.storyScript),
      // skip the Claude call entirely and jump straight to TTS.
      let script: string;
      let epitaphSource = "";
      let epitaphMeaning = "";

      const savedScript = personIdx === 0
        ? (research?.storyScript ?? research?.storyScripts?.[0] ?? null)
        : (research?.storyScripts?.[personIdx] ?? null);

      if (savedScript) {
        script = savedScript;
        epitaphSource = (personIdx === 0
          ? (research?.epitaphSource ?? research?.epitaphSources?.[0])
          : research?.epitaphSources?.[personIdx]) ?? "";
        epitaphMeaning = (personIdx === 0
          ? (research?.epitaphMeaning ?? research?.epitaphMeanings?.[0])
          : research?.epitaphMeanings?.[personIdx]) ?? "";
      } else {
        const storyRes = await fetch("/api/story", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            promptId: hearStoryPromptId,
            ...HEAR_STORY_USAGE,
            name: extracted.name,
            birthDate: extracted.birthDate,
            deathDate: extracted.deathDate,
            birthYear: extracted.birthYear,
            deathYear: extracted.deathYear,
            ageAtDeath: extracted.ageAtDeath,
            inscription: extracted.inscription,
            epitaph: extracted.epitaph,
            symbols: extracted.symbols ?? [],
            city: location?.city,
            state: location?.state,
            country: location?.country,
            cemetery: location?.cemetery,
            historical: research?.historical,
            militaryContext: research?.militaryContext,
            culturalSummary: (cultural as { categories?: unknown[] } | null)?.categories ?? [],
            ssdi: research?.ssdi?.filter((r) => r.matchConfidence === "high").slice(0, 1),
            historicalCensus: research?.historicalCensus?.slice(0, 2),
            immigration: research?.immigration?.slice(0, 1),
            symbolMeanings: (() => {
              const syms = extracted.symbols ?? [];
              if (!syms.length) return undefined;
              const map = interpretSymbols(syms);
              return syms
                .map((s) => {
                  const interp = map.get(s.toLowerCase());
                  return interp ? { symbol: s, meaning: interp.meaning, category: interp.category } : null;
                })
                .filter(Boolean);
            })(),
          }),
        });
        if (!storyRes.ok) throw new Error("story " + storyRes.status);
        ({ script, epitaphSource = "", epitaphMeaning = "" } = await storyRes.json());
        setScriptText(script);
        onStoryGenerated(epitaphSource, epitaphMeaning, script);
      }

      // ── TTS: fetch audio, play immediately via blob URL ──────────────────
      // ttsRes.blob() drains the streamed OpenAI response into memory, then
      // createObjectURL gives us a synchronous, instant src to hand the player.
      setLoadingPhase("recording");
      const ttsRes = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: script, voice, promptId: hearStoryPromptId, ...HEAR_STORY_USAGE }),
      });
      if (!ttsRes.ok) throw new Error("tts " + ttsRes.status);

      const audioBlob = await ttsRes.blob();
      const blobUrl = URL.createObjectURL(audioBlob);

      // Set src and play directly on the DOM element — no setTimeout race condition.
      // setAudioDataUrl triggers the useEffect which wires event listeners; the
      // el.paused guard in that effect skips resetting src once we've started playing.
      const el = audioRef.current;
      if (el) {
        el.src = blobUrl;
        el.play().catch(() => {});
      }
      setAudioDataUrl(blobUrl);

      // Background: convert to base64 and persist to IDB for future sessions.
      // We do NOT revoke blobUrl or swap audioDataUrl here — swapping mid-session
      // removes and fails to re-add event listeners, freezing the progress bar.
      // The blobUrl is valid for this page session; next session loads from IDB.
      (async () => {
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload  = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(audioBlob);
          });
          await saveAudio(graveId, cacheKey, dataUrl);
        } catch { /* non-fatal — blobUrl keeps working for this session */ }
      })();

    } catch {
      setHasError(true);
    } finally {
      setLoadingPhase(null);
    }
  };

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) el.pause(); else el.play().catch(() => {});
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = audioRef.current;
    if (!el || !el.duration) return;
    el.currentTime = parseFloat(e.target.value) * el.duration;
    setProgress(parseFloat(e.target.value));
  };

  if (!hasEnoughData) return null;

  return (
    <div className="py-5 animate-fade-up" style={{ animationDelay: "0.04s" }}>
      <audio ref={audioRef} preload="none" />

      {/* Idle: flagship CTA button */}
      {!audioDataUrl && !loadingPhase && (
        <>
          <button
            onClick={handleHearStory}
            className="relative w-full flex items-center justify-center gap-3 h-14 rounded-2xl text-base font-bold text-[#1a1917] transition-all active:scale-[0.97] overflow-hidden"
            style={{
              background: "linear-gradient(135deg, #eadd9a 0%, var(--t-gold-500) 50%, #9e7f33 100%)",
              boxShadow: "0 0 0 0 rgba(201,168,76,0.4)",
              animation: "pulse-gold 2.5s ease-in-out infinite",
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
            </svg>
            {hasError ? "Try again — hear their story" : "Hear their story"}
          </button>
          <p className="text-stone-500 text-xs text-center mt-2 leading-relaxed px-2">
            A fictional first-person narrative inspired by the name, place, and dates on this marker — meant to evoke the era, not recount verified facts about this individual.
          </p>
        </>
      )}

      {/* Loading states */}
      {loadingPhase && (
        <div
          className="w-full flex items-center justify-center gap-3 h-14 rounded-2xl"
          style={{ background: "rgba(201,168,76,0.08)", border: "1px solid rgba(201,168,76,0.2)" }}
        >
          <div
            className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin shrink-0"
            style={{ borderColor: "var(--t-gold-500) transparent var(--t-gold-500) var(--t-gold-500)" }}
          />
          <span className="text-sm font-medium" style={{ color: "var(--t-gold-400)" }}>
            {loadingPhase === "crafting" ? "Crafting my story…" : "Finding my voice…"}
          </span>
        </div>
      )}

      {/* Player */}
      {audioDataUrl && !loadingPhase && (
        <div className="flex flex-col gap-2">
          <div
            className="flex items-center gap-3 px-4 py-3 rounded-2xl"
            style={{ background: "rgba(201,168,76,0.08)", border: "1px solid rgba(201,168,76,0.2)" }}
          >
            <button
              onClick={togglePlay}
              className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-all active:scale-90"
              style={{ background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#1a1917" stroke="none">
                  <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#1a1917" stroke="none">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
              )}
            </button>
            <button
              onClick={() => {
                const el = audioRef.current;
                if (!el) return;
                el.pause();
                el.currentTime = 0;
                setPlaying(false);
                setProgress(0);
                setCurrentTime(0);
              }}
              className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-stone-400 active:text-stone-200 transition-all active:scale-90"
              style={{ background: "rgba(255,255,255,0.06)" }}
              aria-label="Stop"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <rect x="4" y="4" width="16" height="16" rx="2"/>
              </svg>
            </button>
            <div className="flex-1 flex flex-col gap-1 min-w-0">
              <input
                type="range" min={0} max={1} step={0.001} value={progress}
                onChange={handleSeek}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                style={{
                  background: `linear-gradient(to right, var(--t-gold-500) ${progress * 100}%, rgb(68 64 60) ${progress * 100}%)`,
                  accentColor: "var(--t-gold-500)",
                }}
              />
              <div className="flex justify-between text-[0.7rem] text-stone-500 select-none">
                <span>{formatTime(currentTime)}</span>
                {duration > 0 && <span>{formatTime(duration)}</span>}
              </div>
            </div>
          </div>

          {/* Collapsible script */}
          {scriptText && (
            <div>
              <button
                onClick={() => setScriptOpen((o) => !o)}
                className="flex items-center gap-1.5 text-[0.75rem] text-stone-500 py-1"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  style={{ transform: scriptOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
                {scriptOpen ? "Hide script" : "Read the script"}
              </button>
              {scriptOpen && (
                <div className="mt-2 space-y-3 pl-1 border-l-2 border-stone-800">
                  {scriptText.split(/\n\n+/).filter(Boolean).map((p, i) => (
                    <p key={i} className="text-stone-400 text-sm leading-relaxed italic">{p}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Cultural Context Card ─────────────────────────────────────────────────────

const CULTURAL_DEFS = [
  { id: "popculture",    label: "Pop Culture",            icon: "🎵" },
  { id: "transport",     label: "Getting Around",         icon: "🚂" },
  { id: "homelife",      label: "Home & Daily Life",      icon: "🏡" },
  { id: "health",        label: "Health & Medicine",      icon: "🩺" },
  { id: "communication", label: "News & Communication",   icon: "📻" },
];

function CulturalContextCard({
  context,
  loading,
  expandingCategory,
  onExpand,
  extracted,
}: {
  context: CulturalContext | null;
  loading: boolean;
  expandingCategory: string | null;
  onExpand: (id: string, label: string) => void;
  extracted: ExtractedGraveData;
}) {
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const hasEnoughData = !!(extracted.birthYear || extracted.deathYear);
  if (!hasEnoughData) return null;
  // Summaries are auto-loaded; no placeholder button needed
  if (!context && !loading) return null;

  if (loading && !context) {
    return (
      <div className="py-5 animate-fade-up" style={{ animationDelay: "0.14s" }}>
        <SectionHeader icon="🌎" title="A Life in Their Era" />
        <div className="mt-3 space-y-2">
          {CULTURAL_DEFS.map((def) => (
            <div key={def.id} className="p-3 rounded-xl bg-stone-800 border border-stone-700/60">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm">{def.icon}</span>
                <div className="h-3 shimmer rounded w-24" />
              </div>
              <div className="space-y-1.5">
                <div className="h-3 shimmer rounded w-full" />
                <div className="h-3 shimmer rounded w-5/6" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!context) return null;

  return (
    <div className="py-5 animate-fade-up" style={{ animationDelay: "0.14s" }}>
      <SectionHeader icon="🌎" title="A Life in Their Era" />
      <div className="mt-3 space-y-2">
        {context.categories.map((cat) => {
          const def = CULTURAL_DEFS.find((d) => d.id === cat.id);
          const isOpen = openCategory === cat.id;
          const isExpanding = expandingCategory === cat.id;

          return (
            <div key={cat.id} className="rounded-xl bg-stone-800 border border-stone-700/60 overflow-hidden">
              <div className="p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-sm">{def?.icon ?? "✦"}</span>
                  <p className="text-xs font-semibold uppercase tracking-widest text-stone-500">
                    {def?.label ?? cat.id}
                  </p>
                </div>
                <p className="text-stone-300 text-sm leading-relaxed">{cat.summary}</p>
                {!isOpen && (
                  <button
                    onClick={() => {
                      setOpenCategory(cat.id);
                      if (!cat.detail && !isExpanding) onExpand(cat.id, def?.label ?? cat.id);
                    }}
                    className="mt-2 text-xs flex items-center gap-1"
                    style={{ color: "var(--t-gold-500)" }}
                  >
                    Tell me more
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m9 18 6-6-6-6"/>
                    </svg>
                  </button>
                )}
              </div>

              {isOpen && (
                <div className="border-t border-stone-700/60 px-3 pb-3 pt-2">
                  {isExpanding ? (
                    <div className="space-y-1.5 py-1">
                      <div className="h-3 shimmer rounded w-full" />
                      <div className="h-3 shimmer rounded w-5/6" />
                      <div className="h-3 shimmer rounded w-full" />
                      <div className="h-3 shimmer rounded w-4/5" />
                      <div className="h-3 shimmer rounded w-full mt-3" />
                      <div className="h-3 shimmer rounded w-3/4" />
                      <div className="h-3 shimmer rounded w-5/6" />
                    </div>
                  ) : cat.detail ? (
                    <>
                      {cat.detail.split(/\n\n+/).filter(Boolean).map((p, i) => (
                        <p key={i} className="text-stone-400 text-sm leading-relaxed mt-2 first:mt-0">
                          {p.trim()}
                        </p>
                      ))}
                      <button
                        onClick={() => setOpenCategory(null)}
                        className="mt-3 text-stone-500 text-xs"
                      >
                        Show less
                      </button>
                    </>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-stone-600 text-[0.75rem] italic mt-3">
        Era context generated by AI. Reflects the period and region — not specific to this individual.
      </p>
    </div>
  );
}

// ── Born the Same Year ────────────────────────────────────────────────────────

function BirthYearNotablesCard({
  notables,
  birthYear,
}: {
  notables: Array<{ name: string; description?: string; wikipediaUrl?: string }>;
  birthYear?: number | null;
}) {
  return (
    <div className="py-5 animate-fade-up">
      <SectionHeader icon="🌟" title={`Born in ${birthYear ?? "the same year"}`} />
      <div className="mt-3 space-y-2">
        {notables.slice(0, 5).map((n, i) => (
          <div key={i} className="flex items-start gap-3 py-1">
            <span className="text-stone-600 text-xs mt-0.5 shrink-0 w-4">{i + 1}.</span>
            <div className="flex-1 min-w-0">
              {n.wikipediaUrl ? (
                <a
                  href={n.wikipediaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-stone-200 text-sm font-medium hover:underline"
                  style={{ color: "var(--t-gold-400)" }}
                >
                  {n.name}
                </a>
              ) : (
                <span className="text-stone-200 text-sm font-medium">{n.name}</span>
              )}
              {n.description && (
                <p className="text-stone-500 text-xs mt-0.5 leading-relaxed capitalize">{n.description}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Household Card ────────────────────────────────────────────────────────────

function FindAGraveSubmitCard({
  extracted,
  location,
}: {
  extracted: ExtractedGraveData;
  location: GeoLocation | null;
}) {
  const [copied, setCopied] = useState(false);

  const firstName  = extracted.firstName  ?? extracted.name?.split(" ")[0]       ?? "";
  const lastName   = extracted.lastName   ?? extracted.name?.split(" ").slice(-1)[0] ?? "";
  const birthYear  = extracted.birthYear  ?? "";
  const deathYear  = extracted.deathYear  ?? "";
  const cemetery   = location?.cemetery   ?? "";

  const addUrl = `https://www.findagrave.com/memorial/add?fn=${encodeURIComponent(firstName)}&ln=${encodeURIComponent(lastName)}${birthYear ? `&bd=${birthYear}` : ""}${deathYear ? `&dd=${deathYear}` : ""}${cemetery ? `&mc=${encodeURIComponent(cemetery)}` : ""}`;

  const details = [
    `Name: ${extracted.name ?? "Unknown"}`,
    birthYear ? `Born: ${birthYear}` : null,
    deathYear ? `Died: ${deathYear}` : null,
    cemetery  ? `Cemetery: ${cemetery}` : null,
    location?.city  ? `City: ${location.city}` : null,
    location?.state ? `State: ${location.state}` : null,
  ].filter(Boolean).join("\n");

  const handleCopy = () => {
    navigator.clipboard.writeText(details).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="py-5 animate-fade-up">
      <SectionHeader icon="🪦" title="Not on Find A Grave?" />
      <p className="text-stone-500 text-xs mt-1 mb-3 leading-relaxed">
        {"Help build the world's largest memorial database. Your scan opens a pre-filled Add Memorial form."}
      </p>
      <div
        className="rounded-xl p-3 mb-3 font-mono text-xs text-stone-300 leading-relaxed"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
      >
        {details.split("\n").map((line) => <div key={line}>{line}</div>)}
      </div>
      <div className="flex gap-2">
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all active:scale-95"
          style={{ background: "rgba(255,255,255,0.06)", color: copied ? "#92cc92" : "#a09a94", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          {copied ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          )}
          {copied ? "Copied!" : "Copy details"}
        </button>
        <a
          href={addUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all active:scale-95"
          style={{ background: "rgba(201,168,76,0.12)", color: "var(--t-gold-500)", border: "1px solid rgba(201,168,76,0.25)" }}
        >
          Add Memorial on Find A Grave →
        </a>
      </div>
      <p className="text-stone-600 text-[0.7rem] mt-2">Requires a free Find A Grave account.</p>
    </div>
  );
}

// ── Family Connection Hints (P4.3) ────────────────────────────────────────────

function FamilyConnectionHints({
  graveId,
  extracted,
  location,
}: {
  graveId: string;
  extracted: ExtractedGraveData;
  location: GeoLocation | null;
}) {
  const [relatives, setRelatives] = useState<GraveRecord[]>([]);
  // Cross-user matches from the pooled burial index, excluding anyone already
  // shown from the local archive above.
  const [communityRelatives, setCommunityRelatives] = useState<BurialIndexRelative[]>([]);

  useEffect(() => {
    const lastName = extracted.lastName ?? extracted.name?.split(" ").slice(-1)[0];
    const cemetery = location?.cemetery;
    if (!lastName || (!cemetery && !location?.lat)) return;

    // Identity keys of local same-plot records, to dedupe them out of the
    // community section (name-string dedupe breaks on nicknames/middle names).
    let localKeys = new Set<string>();

    const lastNameLc = lastName.toLowerCase();
    const cemeteryLc = cemetery?.toLowerCase();
    const subjLat = location?.lat;
    const subjLng = location?.lng;

    getAllGraves().then((all) => {
      const matches = all.filter((g) => {
        if (g.id === graveId) return false;
        const gLastName = (g.extracted.lastName ?? g.extracted.name?.split(" ").slice(-1)[0] ?? "").toLowerCase();
        if (!gLastName || gLastName !== lastNameLc) return false;
        // Same cemetery by name, or by GPS proximity when a name is missing —
        // mirrors the pooled-index matcher so own records aren't mislabelled.
        const sameCemetery = !!cemeteryLc && g.location?.cemetery?.toLowerCase() === cemeteryLc;
        const nearby =
          typeof subjLat === "number" && typeof subjLng === "number" &&
          typeof g.location?.lat === "number" && typeof g.location?.lng === "number" &&
          Math.abs(g.location.lat - subjLat) < 0.01 && Math.abs(g.location.lng - subjLng) < 0.01;
        return sameCemetery || nearby;
      });
      setRelatives(matches.slice(0, 5));
      // Local records also live in the pooled index — dedupe by identity key.
      localKeys = new Set(
        matches
          .map((g) => computePersonIdentityKey({
            givenName: g.extracted.firstName,
            surname: g.extracted.lastName ?? g.extracted.name?.split(" ").slice(-1)[0],
            birthYear: g.extracted.birthYear, deathYear: g.extracted.deathYear,
            state: g.location?.state,
          }))
          .filter((k): k is string => !!k)
      );
    }).catch(() => {}).finally(() => {
      // Query the community index (own scans + everyone else's).
      (async () => {
        try {
          const supabase = createClient();
          const identityKey = computePersonIdentityKey({
            givenName: extracted.firstName, surname: lastName,
            birthYear: extracted.birthYear, deathYear: extracted.deathYear,
            state: location?.state,
          });
          const pooled = await fetchBurialIndexRelatives(supabase, {
            surname: lastName,
            cemetery: cemetery ?? undefined,
            lat: location?.lat, lng: location?.lng,
            excludeIdentityKey: identityKey,
          });
          setCommunityRelatives(
            pooled.filter((r) => r.identityKey !== identityKey && !localKeys.has(r.identityKey)).slice(0, 6)
          );
        } catch { /* non-fatal */ }
      })();
    });
  }, [graveId, extracted, location]);

  if (relatives.length === 0 && communityRelatives.length === 0) return null;

  return (
    <div className="py-5 animate-fade-up">
      <SectionHeader icon="👨‍👩‍👧" title="Possible Relatives Nearby" />

      {relatives.length > 0 && (
        <>
          <p className="text-stone-500 text-xs mt-1 mb-3">
            Same surname and cemetery in your archive — likely family members.
          </p>
          <ul className="space-y-1.5">
            {relatives.map((g) => {
              const name = g.extracted.name || "Unknown";
              const dates = [g.extracted.birthDate, g.extracted.deathDate].filter(Boolean).join(" – ") ||
                [g.extracted.birthYear, g.extracted.deathYear].filter(Boolean).map(String).join(" – ") || "";
              return (
                <li key={g.id}>
                  <a
                    href={`/result/${g.id}`}
                    className="flex items-center gap-3 p-3 rounded-xl bg-stone-800 border border-stone-700 active:bg-stone-750 transition-colors"
                  >
                    {g.photoDataUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={g.photoDataUrl} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-stone-200 text-sm font-medium font-serif truncate">{name}</p>
                      {dates && <p className="text-stone-500 text-xs mt-0.5">{dates}</p>}
                    </div>
                    <p className="text-xs shrink-0" style={{ color: "var(--t-gold-500)" }}>View →</p>
                  </a>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {communityRelatives.length > 0 && (
        <>
          <p className="text-stone-500 text-xs mt-3 mb-2">
            Same surname in {location?.cemetery || "this cemetery"}, recorded across GraveLens community scans.
          </p>
          <ul className="space-y-1.5">
            {communityRelatives.map((r, i) => {
              const dates = [r.birthYear, r.deathYear].filter(Boolean).map(String).join(" – ");
              // identityKey format: given|surname|birthYear|deathYear|state —
              // exact fields for a pre-filled /research launch.
              const [kGiven, kSurname, kBirth, kDeath, kState] = r.identityKey.split("|");
              const researchUrl = `/research?${new URLSearchParams({
                ...(kGiven ? { firstName: kGiven } : {}),
                lastName: kSurname ?? "",
                ...(kBirth ? { birthYear: kBirth } : {}),
                ...(kDeath ? { deathYear: kDeath } : {}),
                ...(kState ? { state: kState.replace(/\b\w/g, (c) => c.toUpperCase()) } : {}),
              })}`;
              return (
                <li key={i}>
                  <Link
                    href={researchUrl}
                    className="flex items-center gap-3 p-3 rounded-xl bg-stone-800/60 border border-stone-700/60 active:bg-stone-750 transition-colors"
                  >
                    <span className="shrink-0 w-8 h-8 rounded-lg bg-stone-700/50 flex items-center justify-center text-stone-400 text-xs" aria-hidden>
                      🪦
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-stone-300 text-sm font-medium font-serif truncate">{r.name}</p>
                      {dates && <p className="text-stone-500 text-xs mt-0.5">{dates}</p>}
                    </div>
                    <span className="text-[0.6rem] shrink-0 px-1.5 py-0.5 rounded uppercase tracking-wide text-stone-500 bg-stone-700/40">
                      Community
                    </span>
                    <span className="text-xs shrink-0" style={{ color: "var(--t-gold-500)" }}>Research →</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

// ── Research Links Card (P3) ──────────────────────────────────────────────────

function ConflictWarningCard({
  extracted,
  research,
}: {
  extracted: ExtractedGraveData;
  research: ResearchData;
}) {
  const [open, setOpen] = useState(false);
  const conflicts = detectConflicts(extracted, research);
  if (conflicts.length === 0) return null;

  const FIELD_LABEL: Record<string, string> = {
    birthYear: "Birth year",
    deathYear: "Death year",
    name: "Name",
  };

  return (
    <div className="py-5 animate-fade-up">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-start gap-3 p-3 rounded-xl border transition-colors text-left"
        style={{ background: "rgba(220,60,40,0.06)", borderColor: "rgba(220,60,40,0.25)" }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e88888" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: "#e88888" }}>
            {conflicts.length === 1 ? "1 date conflict detected" : `${conflicts.length} date conflicts detected`}
          </p>
          <p className="text-xs text-stone-500 mt-0.5">
            Sources disagree — verify before citing. Tap to review.
          </p>
        </div>
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6a6560" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-1 transition-transform"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {open && (
        <div className="mt-2 space-y-2 animate-fade-in">
          {conflicts.map((c, i) => (
            <div key={i} className="p-3 rounded-xl bg-stone-800 border border-stone-700">
              <p className="text-xs font-semibold text-stone-400 uppercase tracking-widest mb-1.5">{FIELD_LABEL[c.field] ?? c.field}</p>
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <div>
                  <p className="text-[0.7rem] text-stone-500">{c.source1}</p>
                  <p className="text-stone-200 text-sm font-medium">{c.value1}</p>
                </div>
                <div>
                  <p className="text-[0.7rem] text-stone-500">{c.source2}</p>
                  <p className="text-stone-200 text-sm font-medium">{c.value2}</p>
                </div>
              </div>
              {c.deltaYears != null && (
                <p className="text-xs text-stone-500 mt-1.5">{c.deltaYears} year{c.deltaYears !== 1 ? "s" : ""} apart — check primary sources to confirm.</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── External Links Card ───────────────────────────────────────────────────────

function ConfidenceBadge({
  confidence,
  extracted,
  offsetClass = "top-3 right-3"
}: {
  confidence: string;
  extracted: ExtractedGraveData;
  offsetClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const info = CONFIDENCE_INFO[confidence];
  if (!info) return null;

  const label =
    confidence === "high"   ? "High confidence" :
    confidence === "medium" ? "Medium confidence" :
    "Low confidence";

  const reasons = (() => {
    const list: string[] = [];
    if (confidence === "high") return list;

    if (!extracted.name) {
      list.push("Name was not identified on the stone.");
    } else if (!TYPICAL_NAME_RE.test(extracted.name)) {
      list.push("Name contains unusual characters or OCR noise.");
    }

    if (extracted.birthYear == null && extracted.deathYear == null) {
      list.push("No birth or death years were extracted.");
    }

    const issues = validateExtraction(extracted as unknown as Record<string, unknown>);
    issues.forEach((issue) => {
      list.push(issue.problem);
    });

    if (list.length === 0) {
      list.push("Hard-to-read text or weathered stone surface.");
    }

    return list;
  })();

  return (
    <div className={`absolute ${offsetClass}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold"
        style={{
          background: "rgba(10, 9, 8, 0.72)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          border: "1px solid currentColor",
          color: info.color,
        }}
        aria-label={`Confidence: ${label}`}
      >
        {label}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-full mt-2 z-50 w-56 rounded-xl px-3.5 py-3 text-xs text-stone-300 leading-relaxed shadow-xl animate-fade-up"
            style={{ background: "#1c1b19", border: "1px solid rgba(255,255,255,0.08)" }}
          >
            <p className="font-semibold mb-1" style={{ color: info.color }}>{label}</p>
            <p className="mb-1.5">{info.tip}</p>
            {reasons.length > 0 && (
              <div className="border-t border-white/5 pt-1.5 mt-1.5 flex flex-col gap-1 text-[0.68rem] text-stone-400">
                <p className="font-semibold text-stone-500">Key reasons:</p>
                {reasons.map((r, i) => (
                  <p key={i} className="flex gap-1 items-start">
                    <span className="text-red-400/70 select-none">•</span>
                    <span>{r}</span>
                  </p>
                ))}
              </div>
            )}
            {confidence !== "high" && (
              <p className="mt-2 text-stone-500 text-[0.68rem]">Tap the refresh icon to re-analyze after re-scanning.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Section Header ────────────────────────────────────────────────────────────

// ── Review Prompt Sheet ───────────────────────────────────────────────────────

function ReviewPromptSheet({
  onEnterName,
  onSaveLater,
  onConfirmCorrect,
  personName = "",
  isArchived = false,
}: {
  onEnterName: (name: string) => void;
  onSaveLater: () => void;
  /** Shown when the scan has a name but was flagged (e.g. low confidence). */
  onConfirmCorrect?: () => void;
  personName?: string;
  isArchived?: boolean;
}) {
  const [nameValue, setNameValue] = useState(personName);
  const [entering, setEntering] = useState(false);
  // Two modes: no name yet → enter it; name present but flagged → verify it.
  const verifying = !!personName && !!onConfirmCorrect;

  return (
    <div className="fixed inset-0 z-[60] flex items-end lg:items-center justify-center lg:p-6">
      <div className="absolute inset-0 bg-stone-950/70 backdrop-blur-sm" onClick={onSaveLater} />
      <div
        className="relative w-full max-w-sm rounded-t-3xl lg:rounded-2xl flex flex-col overflow-hidden"
        style={{
          background: "rgba(var(--glass-bg-rgb), 0.98)",
          border: "1px solid var(--t-stone-700)",
          paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
        }}
      >
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-stone-700" />
        </div>
        <div className="px-5 pt-3 pb-4">
          <p className="text-stone-100 font-semibold text-base leading-snug">
            {verifying ? "Verify this scan" : "Couldn't read the name"}
          </p>
          <p className="text-stone-400 text-sm mt-1 leading-relaxed">
            {verifying ? (
              <>The scanner wasn&apos;t confident about this stone. Check <span className="text-stone-300 font-medium">{personName}</span> and the dates against the photo — if they match, approve the scan.</>
            ) : (
              <>Enter the name now to start research, or save this scan to <span className="text-stone-300 font-medium">Working Scans</span> to complete later.</>
            )}
          </p>
        </div>

        <div className="flex flex-col gap-2 px-5">
          {verifying && !entering && (
            <button
              onClick={onConfirmCorrect}
              className="w-full py-3 rounded-2xl text-sm font-semibold text-[#1a1917]"
              style={{ background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }}
            >
              Looks correct
            </button>
          )}
          {entering ? (
            <div className="flex gap-2">
              <input
                autoFocus
                type="text"
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && nameValue.trim()) onEnterName(nameValue.trim()); }}
                placeholder="Full name as inscribed"
                className="flex-1 bg-stone-800 text-stone-100 text-sm rounded-xl px-3 py-2.5 border border-stone-600 focus:outline-none focus:border-stone-400"
              />
              <button
                onClick={() => { if (nameValue.trim()) onEnterName(nameValue.trim()); }}
                disabled={!nameValue.trim()}
                className="px-4 py-2.5 rounded-xl text-sm font-semibold text-[#1a1917] disabled:opacity-40"
                style={{ background: "var(--t-gold-500)" }}
              >
                Save
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEntering(true)}
              className={
                verifying
                  ? "w-full py-3 rounded-2xl text-sm font-medium text-stone-300 border border-stone-600"
                  : "w-full py-3 rounded-2xl text-sm font-semibold text-[#1a1917]"
              }
              style={verifying ? undefined : { background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))" }}
            >
              {verifying ? "Fix the name" : "Enter Name"}
            </button>
          )}
          <button
            onClick={onSaveLater}
            className="w-full py-3 rounded-2xl text-sm font-medium text-stone-400 border border-stone-700"
          >
            {isArchived ? "Keep in review" : "Save to Working Scans — complete later"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ShareSheet({
  record,
  onClose,
}: {
  record: GraveRecord;
  onClose: () => void;
}) {
  const emailUrl = buildEmailShareUrl(record);
  const smsUrl = buildSmsShareUrl(record);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end lg:items-center lg:p-6"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative w-full max-w-sm mx-auto bg-stone-800 rounded-t-3xl lg:rounded-2xl p-6 animate-fade-up"
        style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-stone-600 rounded-full mx-auto mb-6" />
        <h3 className="font-serif text-lg text-stone-100 mb-4">
          Share {record.extracted.name || "this grave"}
        </h3>
        <div className="flex flex-col gap-3">
          <a
            href={smsUrl}
            className="flex items-center gap-4 p-4 rounded-2xl bg-stone-700 text-stone-200"
          >
            <span className="text-2xl">💬</span>
            <span className="font-medium">Send as Text Message</span>
          </a>
          <a
            href={emailUrl}
            className="flex items-center gap-4 p-4 rounded-2xl bg-stone-700 text-stone-200"
          >
            <span className="text-2xl">✉️</span>
            <span className="font-medium">Send via Email</span>
          </a>
          <button
            onClick={async () => {
              const { copyToClipboard } = await import("@/lib/share");
              const text = [
                record.extracted.name,
                [record.extracted.birthDate, record.extracted.deathDate]
                  .filter(Boolean)
                  .join(" — "),
                record.location?.cemetery,
              ]
                .filter(Boolean)
                .join("\n");
              await copyToClipboard(text);
              onClose();
            }}
            className="flex items-center gap-4 p-4 rounded-2xl bg-stone-700 text-stone-200 w-full text-left"
          >
            <span className="text-2xl">📋</span>
            <span className="font-medium">Copy to Clipboard</span>
          </button>
        </div>
      </div>
    </div>
  );
}
