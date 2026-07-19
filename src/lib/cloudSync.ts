/**
 * Cloud sync utilities for GraveLens.
 *
 * All functions require a Supabase browser client and a user ID. They are
 * intentionally fire-and-forget — every caller should treat cloud failures
 * as non-fatal, since IndexedDB is the source of truth for offline use.
 *
 * Photo storage layout in the "grave-photos" bucket:
 *   {userId}/{graveId}.jpg
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GraveRecord } from "@/types";
import { getAllGraves, getGrave, saveGrave } from "@/lib/storage";
import { photoProxyUrl } from "@/lib/photoUrl";
import {
  loadUnlocks,
  loadStats,
  updateStats,
  isUnlockSeen,
  ACHIEVEMENT_UNSEEN_EVENT,
  type UnlockRecord,
  type AppStats,
  totalXP,
  getRank,
} from "@/lib/achievements";

/**
 * Merge two unlock lists: union by id, keeping the earliest `unlockedAt` and
 * treating a record as seen if it was viewed on EITHER device (unseen only when
 * both sides are unseen). This keeps the Explorer "unseen" badge consistent
 * across devices — viewing on one device clears it everywhere after sync.
 */
function mergeUnlockLists(a: UnlockRecord[], b: UnlockRecord[]): UnlockRecord[] {
  const map = new Map<string, UnlockRecord>();
  for (const u of [...a, ...b]) {
    const prev = map.get(u.id);
    if (!prev) {
      map.set(u.id, { ...u });
      continue;
    }
    map.set(u.id, {
      id: u.id,
      unlockedAt: Math.min(prev.unlockedAt, u.unlockedAt),
      seen: isUnlockSeen(prev) || isUnlockSeen(u),
    });
  }
  return Array.from(map.values());
}

const BUCKET = "grave-photos";
const SYNC_KEY = "gl_synced_at";

/** Best-effort human-readable message out of an unknown thrown value. */
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * Fired (on `window`) after the archive is pushed to the cloud — by the manual
 * "Back Up Data" action or the background auto-backup. UI that shows a pending
 * count (e.g. the avatar badge) listens for this to refresh.
 */
export const ARCHIVE_SYNCED_EVENT = "gl:archive-synced";

export function notifyArchiveSynced(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(ARCHIVE_SYNCED_EVENT));
  }
}

/**
 * Fired (on `window`) when local explorer progress changes — i.e. new
 * achievements unlocked, which may raise the user's rank and make a rank reward
 * claimable. The ecosystem context listens for this to refresh the claimable-
 * rewards indicator (the account-badge dot) without waiting for the next load.
 */
export const EXPLORER_PROGRESS_EVENT = "gl:explorer-progress";

export function notifyExplorerProgress(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(EXPLORER_PROGRESS_EVENT));
  }
}

// ── Photo upload ──────────────────────────────────────────────────────────────

/**
 * Ensure a grave's photo bytes are in the PRIVATE grave-photos bucket and return
 * its storage path ({userId}/{graveId}.jpg), which is what gets stored in the
 * gravelens_graves.photo_url column. The bucket is no longer public — photos are
 * served through the authenticated /api/photo/[id] proxy (see photoProxyUrl).
 *
 * The write goes through POST /api/photo/upload, which uploads via the SERVICE
 * ROLE (bypassing Storage RLS) and derives the owner from the session. This means
 * the browser never needs a client-side write policy on the bucket — the same
 * server-enforced model the read proxy already uses. `userId` is used only to
 * build the returned path (the server independently derives the real owner).
 *
 * Idempotent: if `dataUrl` is not a fresh `data:` URL (i.e. it's an already-
 * uploaded path or proxy URL), the upload is skipped and the path is returned.
 */
export async function uploadPhoto(
  userId: string,
  graveId: string,
  dataUrl: string
): Promise<string> {
  // Research-only records (no photo scanned) carry a tiny inline SVG
  // placeholder — return it as-is instead of POSTing bytes to storage.
  if (dataUrl.startsWith("data:image/svg+xml")) return dataUrl;

  const path = `${userId}/${graveId}.jpg`;

  // Already uploaded (value is a storage path or /api/photo URL, not raw bytes).
  if (!dataUrl.startsWith("data:")) return path;

  const res = await fetch("/api/photo/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ graveId, dataUrl }),
    // Bound a hung upload so background cloud sync can't stall indefinitely.
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error || `Photo upload failed (HTTP ${res.status})`);
  }

  const { path: uploadedPath } = (await res.json()) as { path?: string };
  return uploadedPath || path;
}

// ── Grave upsert ──────────────────────────────────────────────────────────────

/**
 * Write or update a single grave record in the cloud database.
 * The photoUrl should be the CDN URL returned by uploadPhoto.
 */
export async function upsertGrave(
  supabase: SupabaseClient,
  userId: string,
  record: GraveRecord,
  photoUrl: string
): Promise<void> {
  const { error } = await supabase.from("gravelens_scans").upsert({
    id: record.id,
    user_id: userId,
    // captured_at is a timestamptz; the local record holds a Unix-ms number.
    captured_at: new Date(record.timestamp).toISOString(),
    photo_url: photoUrl,
    location: record.location ?? {},
    extracted: record.extracted ?? {},
    research: record.research ?? {},
    tags: record.tags ?? [],
    user_notes: record.userNotes ?? null,
    is_public: record.isPublic ?? false,
    community_note: record.communityNote ?? null,
    synced_at: new Date().toISOString(),
  });

  if (error) throw error;
}

// ── Cloud delete ──────────────────────────────────────────────────────────────

/**
 * Remove a grave record and its photo from the cloud.
 * Non-fatal — local delete always proceeds regardless.
 */
export async function deleteFromCloud(
  supabase: SupabaseClient,
  userId: string,
  graveId: string
): Promise<void> {
  await supabase.from("gravelens_scans").delete().eq("id", graveId);
  await supabase.storage.from(BUCKET).remove([`${userId}/${graveId}.jpg`]);
}

// ── Fetch all from cloud ──────────────────────────────────────────────────────

/**
 * Fetch all grave records for the current user from Supabase.
 * Maps the DB row shape back to GraveRecord.
 */
export async function fetchAllFromCloud(
  supabase: SupabaseClient,
  userId: string
): Promise<GraveRecord[]> {
  const { data, error } = await supabase
    .from("gravelens_scans")
    .select("*")
    .eq("user_id", userId)
    .order("captured_at", { ascending: false });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    // captured_at is an ISO timestamptz string; the local record holds Unix ms.
    timestamp: new Date(row.captured_at).getTime(),
    // Render via the authenticated proxy, not the raw (now private) storage path.
    photoDataUrl: photoProxyUrl(row.id),
    location: row.location ?? {},
    extracted: row.extracted ?? {},
    research: row.research ?? {},
    tags: row.tags ?? [],
    userNotes: row.user_notes ?? undefined,
    syncedAt: new Date(row.synced_at).getTime(),
  })) as GraveRecord[];
}

// ── Bulk migration ────────────────────────────────────────────────────────────

/**
 * One-time migration: push all local IndexedDB records to Supabase.
 * Already-synced records (by id) are skipped.
 * Runs at most 3 uploads concurrently to avoid rate-limiting.
 */
export async function syncLocalToCloud(
  supabase: SupabaseClient,
  userId: string
): Promise<{ synced: number; failed: number; firstError?: string }> {
  const local = await getAllGraves();
  if (local.length === 0) return { synced: 0, failed: 0 };

  // Get IDs already in the cloud so we don't re-upload
  const { data: existing } = await supabase
    .from("gravelens_scans")
    .select("id")
    .in(
      "id",
      local.map((r) => r.id)
    );
  const syncedIds = new Set((existing ?? []).map((r: { id: string }) => r.id));
  const pending = local.filter((r) => !syncedIds.has(r.id));

  let synced = 0;
  let failed = 0;
  // Surface the first underlying error so the UI can show WHY a backup failed,
  // instead of only a silent count (the console.warn below is unreadable on a
  // mobile PWA where there is no DevTools).
  let firstError: string | undefined;

  // Process in batches of 3
  const CONCURRENCY = 3;
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (record) => {
        // Track which boundary we're crossing so a failure reports the exact
        // layer (photo storage vs. database row) rather than a bare message.
        let step = "photo upload";
        try {
          const photoPath = await uploadPhoto(
            userId,
            record.id,
            record.photoDataUrl
          );

          // Re-read from IDB before writing to cloud so any research data
          // fetched concurrently during the photo upload is not clobbered.
          const fresh = await getGrave(record.id);
          const latest = fresh ?? record;
          step = "database write";
          await upsertGrave(supabase, userId, latest, photoPath);

          // Point the local copy at the authenticated proxy so images load from
          // the private bucket online, and from the service-worker cache offline.
          await saveGrave({ ...latest, photoDataUrl: photoProxyUrl(record.id), syncedAt: Date.now() });
          synced++;
        } catch (err) {
          // Full technical detail (HTTP status + raw error) goes to the console;
          // the user-facing caption gets a concise, honest reason.
          const httpStatus =
            (err as { status?: number; statusCode?: string | number })?.status ??
            (err as { statusCode?: string | number })?.statusCode;
          console.warn(
            `[Sync] grave ${record.id} failed during ${step}` +
              (httpStatus != null ? ` (HTTP ${httpStatus})` : ""),
            err
          );
          if (!firstError) firstError = `${step}: ${errorMessage(err)}`;
          failed++;
        }
      })
    );
  }

  if (synced > 0) {
    try {
      localStorage.setItem(SYNC_KEY, new Date().toISOString());
    } catch { /* ignore */ }
  }

  return { synced, failed, firstError };
}

export function hasEverSynced(): boolean {
  try {
    return !!localStorage.getItem(SYNC_KEY);
  } catch {
    return false;
  }
}

// ── Explorer points (achievements + stats) sync ───────────────────────────────

/**
 * Push local achievement unlocks and app stats to the cloud, merging with any
 * existing cloud data so progress is never lost on either device.
 *
 * Merge rules:
 *   unlocks  — union by id; keep earliest unlockedAt timestamp
 *   stats    — take max of sharesCount / cemeteryNamesAdded; union daysActive
 */
export async function pushExplorerPoints(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  const localUnlocks = loadUnlocks();
  const localStats = loadStats();

  // Fetch existing cloud row (may not exist yet)
  const { data: existing } = await supabase
    .from("gravelens_user_profiles")
    .select("achievement_unlocks, app_stats")
    .eq("user_id", userId)
    .maybeSingle();

  const cloudUnlocks: UnlockRecord[] = existing?.achievement_unlocks ?? [];
  const cloudStats: AppStats = existing?.app_stats ?? {
    sharesCount: 0,
    cemeteryNamesAdded: 0,
    daysActive: [],
  };

  // Merge unlocks — union by id, earliest timestamp, seen if seen anywhere
  const mergedUnlocks = mergeUnlockLists(cloudUnlocks, localUnlocks);

  // Merge stats
  const mergedStats: AppStats = {
    sharesCount: Math.max(localStats.sharesCount, cloudStats.sharesCount),
    cemeteryNamesAdded: Math.max(
      localStats.cemeteryNamesAdded,
      cloudStats.cemeteryNamesAdded
    ),
    daysActive: Array.from(
      new Set([...localStats.daysActive, ...cloudStats.daysActive])
    ).sort(),
  };

  const xp = totalXP(mergedUnlocks);
  const rank = getRank(xp).level;

  const { error } = await supabase.from("gravelens_user_profiles").upsert({
    user_id: userId,
    achievement_unlocks: mergedUnlocks,
    app_stats: mergedStats,
    explorer_xp: xp,
    explorer_rank: rank,
    updated_at: new Date().toISOString(),
  });

  if (error) throw error;
}

/**
 * Pull achievement unlocks and stats from the cloud and merge into local
 * storage, so a new device immediately inherits all Explorer progress.
 *
 * Uses the same merge rules as pushExplorerPoints so the operation is safe
 * to call concurrently on multiple devices.
 */
export async function pullExplorerPoints(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  const { data, error } = await supabase
    .from("gravelens_user_profiles")
    .select("achievement_unlocks, app_stats")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) return;

  const cloudUnlocks: UnlockRecord[] = data.achievement_unlocks ?? [];
  const cloudStats: AppStats = data.app_stats ?? {
    sharesCount: 0,
    cemeteryNamesAdded: 0,
    daysActive: [],
  };

  // Merge with what's already local
  const localUnlocks = loadUnlocks();
  const localStats = loadStats();

  const mergedUnlocks = mergeUnlockLists(localUnlocks, cloudUnlocks);

  const mergedStats: AppStats = {
    sharesCount: Math.max(localStats.sharesCount, cloudStats.sharesCount),
    cemeteryNamesAdded: Math.max(
      localStats.cemeteryNamesAdded,
      cloudStats.cemeteryNamesAdded
    ),
    daysActive: Array.from(
      new Set([...localStats.daysActive, ...cloudStats.daysActive])
    ).sort(),
  };

  // Write merged data back to localStorage
  try {
    localStorage.setItem(
      "gl_achievement_unlocks",
      JSON.stringify(mergedUnlocks)
    );
    updateStats(mergedStats);
    // A pulled unseen unlock from another device should light the badge here.
    notifyExplorerProgress();
    window.dispatchEvent(new Event(ACHIEVEMENT_UNSEEN_EVENT));
  } catch { /* ignore */ }
}
