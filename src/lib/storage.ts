import { openDB, type IDBPDatabase } from "idb";
import type { GraveRecord, QueuedCapture, CemeteryRecord } from "@/types";

const DB_NAME = "gravelens";
const DB_VERSION = 6;          // ← bumped from 5 to add audio store
const STORE_NAME = "graves";
const PENDING_STORE = "pending";
const QUEUE_STORE = "queue";
const CEMETERY_STORE = "cemeteries";
const AUDIO_STORE = "audio";

// Singleton promise — DB is opened once per session and reused.
// Avoids re-scheduling the upgrade transaction on every operation.
let _dbPromise: Promise<IDBPDatabase> | null = null;

const AUDIO_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getDB(): Promise<IDBPDatabase> {
  if (!_dbPromise) {
    _dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, newVersion) {
        console.log(`[Storage] Upgrading DB from ${oldVersion} to ${newVersion}`);
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex("timestamp", "timestamp");
        }
        if (!db.objectStoreNames.contains(PENDING_STORE)) {
          db.createObjectStore(PENDING_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(QUEUE_STORE)) {
          db.createObjectStore(QUEUE_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(CEMETERY_STORE)) {
          db.createObjectStore(CEMETERY_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(AUDIO_STORE)) {
          db.createObjectStore(AUDIO_STORE, { keyPath: "id" });
        }
      },
    }).then(async (db) => {
      // Fire-and-forget: prune audio cache entries older than 30 days
      pruneAudioCache(db).catch(() => {});
      return db;
    });
  }
  return _dbPromise;
}

async function pruneAudioCache(db: IDBPDatabase): Promise<void> {
  const cutoff = Date.now() - AUDIO_TTL_MS;
  const tx = db.transaction(AUDIO_STORE, "readwrite");
  const all = await tx.store.getAll();
  const stale = all.filter((entry) => (entry.createdAt ?? 0) < cutoff);
  await Promise.all(stale.map((entry) => tx.store.delete(entry.id)));
  await tx.done;
  if (stale.length > 0) {
    console.log(`[Storage] Pruned ${stale.length} stale audio cache entries (>${30}d old).`);
  }
}

// ── Saved archive ─────────────────────────────────────────────────────────

export async function saveGrave(record: GraveRecord): Promise<void> {
  // Non-blocking quota check — warn at 80% so the user can cloud-sync before
  // the browser starts silently evicting IDB data.
  if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
    navigator.storage.estimate().then(({ usage = 0, quota = Infinity }) => {
      if (usage / quota > 0.80) {
        console.warn(
          `[Storage] IDB at ${Math.round((usage / quota) * 100)}% of quota` +
          ` (${Math.round(usage / 1024 / 1024)} MB / ${Math.round(quota / 1024 / 1024)} MB).` +
          ` Consider syncing to cloud to free space.`
        );
      }
    }).catch(() => { /* estimate not available in all contexts */ });
  }
  const db = await getDB();
  await db.put(STORE_NAME, record);
}


export async function getGrave(id: string): Promise<GraveRecord | undefined> {
  const db = await getDB();
  return db.get(STORE_NAME, id);
}

export async function getAllGraves(): Promise<GraveRecord[]> {
  try {
    const db = await getDB();
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      console.error(`[Storage] Store ${STORE_NAME} missing!`);
      return [];
    }
    // Use the timestamp index so IDB handles ordering natively (O(n) reverse
    // beats O(n log n) JS sort for large archives).
    const records = await db.getAllFromIndex(STORE_NAME, "timestamp");
    return records.reverse(); // index is ascending; reverse for newest-first
  } catch (err) {
    console.error("[Storage] Failed to get all graves:", err);
    throw err;
  }
}

export async function deleteGrave(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_NAME, id);
}

export async function getGraveCount(): Promise<number> {
  const db = await getDB();
  return db.count(STORE_NAME);
}

/**
 * Count local graves not yet backed up to the cloud. A grave gets `syncedAt`
 * set once it has successfully reached Supabase (on capture/edit while online +
 * signed in, or via a manual Back Up Data run). Scans made offline or while
 * signed out have no `syncedAt`, so this is the "needs backup" signal used to
 * enable the Back Up Data action and show the avatar badge.
 */
export async function countUnsyncedGraves(): Promise<number> {
  try {
    const graves = await getAllGraves();
    return graves.filter((g) => !g.syncedAt).length;
  } catch {
    return 0;
  }
}

// ── In-flight analysis results (replaces sessionStorage) ──────────────────

export async function savePendingResult(
  id: string,
  data: unknown
): Promise<void> {
  const db = await getDB();
  await db.put(PENDING_STORE, { id, data, timestamp: Date.now() });
}

export async function getPendingResult(
  id: string
): Promise<unknown | undefined> {
  const db = await getDB();
  const record = await db.get(PENDING_STORE, id);
  return record?.data;
}

export async function deletePendingResult(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(PENDING_STORE, id);
}

// ── Offline capture queue ──────────────────────────────────────────────────

export async function addToQueue(item: QueuedCapture): Promise<void> {
  const db = await getDB();
  await db.put(QUEUE_STORE, item);
}

export async function getQueuedItems(): Promise<QueuedCapture[]> {
  const db = await getDB();
  const items = await db.getAll(QUEUE_STORE);
  return items.sort((a, b) => a.timestamp - b.timestamp);
}

export async function updateQueueItem(item: QueuedCapture): Promise<void> {
  const db = await getDB();
  await db.put(QUEUE_STORE, item);
}

export async function removeFromQueue(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(QUEUE_STORE, id);
}

export async function getQueueCount(): Promise<number> {
  const db = await getDB();
  return db.count(QUEUE_STORE);
}

// ── Cemetery archive ───────────────────────────────────────────────────────

export async function saveCemetery(record: CemeteryRecord): Promise<void> {
  const db = await getDB();
  await db.put(CEMETERY_STORE, record);
}

export async function getCemetery(id: string): Promise<CemeteryRecord | undefined> {
  const db = await getDB();
  return db.get(CEMETERY_STORE, id);
}

export async function getAllCemeteries(): Promise<CemeteryRecord[]> {
  const db = await getDB();
  const records = await db.getAll(CEMETERY_STORE);
  return records.sort((a, b) => b.lastVisited - a.lastVisited);
}

export async function deleteCemetery(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(CEMETERY_STORE, id);
}

/**
 * Upserts a cemetery visit.  If the cemetery already exists in the archive
 * the visitCount and lastVisited are incremented; otherwise a new record is
 * created with the supplied data.
 */
export async function recordCemeteryVisit(
  partial: Omit<CemeteryRecord, "visitCount" | "firstVisited" | "lastVisited"> & { id: string }
): Promise<CemeteryRecord> {
  const db = await getDB();
  const existing: CemeteryRecord | undefined = await db.get(CEMETERY_STORE, partial.id);
  const now = Date.now();

  const record: CemeteryRecord = existing
    ? {
        ...existing,
        // Merge enriched data if it arrives after the first visit
        ...Object.fromEntries(
          Object.entries(partial).filter(([, v]) => v !== undefined && v !== null)
        ),
        visitCount: existing.visitCount + 1,
        lastVisited: now,
      }
    : {
        ...partial,
        visitCount: 1,
        firstVisited: now,
        lastVisited: now,
      };

  await db.put(CEMETERY_STORE, record);
  return record;
}

// ── Audio cache ────────────────────────────────────────────────────────────

export async function saveAudio(graveId: string, voice: string, dataUrl: string): Promise<void> {
  // Non-blocking quota check — warn at 80% so the user can cloud-sync before
  // the browser starts silently evicting IDB data.
  if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
    navigator.storage.estimate().then(({ usage = 0, quota = Infinity }) => {
      if (usage / quota > 0.80) {
        console.warn(
          `[Storage] IDB at ${Math.round((usage / quota) * 100)}% of quota` +
          ` (${Math.round(usage / 1024 / 1024)} MB / ${Math.round(quota / 1024 / 1024)} MB).` +
          ` Consider syncing to cloud to free space.`
        );
      }
    }).catch(() => { /* estimate not available in all contexts */ });
  }
  const db = await getDB();
  await db.put(AUDIO_STORE, { id: `${graveId}_${voice}`, dataUrl, createdAt: Date.now() });
}

export async function getAudio(graveId: string, voice: string): Promise<string | undefined> {
  const db = await getDB();
  const record = await db.get(AUDIO_STORE, `${graveId}_${voice}`);
  return record?.dataUrl;
}

export async function deleteAudio(graveId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(AUDIO_STORE, "readwrite");
  const keys = await tx.store.getAllKeys();
  const prefix = `${graveId}_`;
  await Promise.all(
    keys
      .filter((k) => String(k).startsWith(prefix))
      .map((k) => tx.store.delete(k))
  );
  await tx.done;
}
