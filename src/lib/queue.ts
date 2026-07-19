/**
 * Offline capture queue processor.
 *
 * Items are stored in IndexedDB by CapturePage (Cemetery Mode) when the
 * user wants to defer AI analysis. This module processes them once the
 * device is back online, saving each result directly to the graves archive.
 */

import {
  getQueuedItems,
  updateQueueItem,
  removeFromQueue,
  saveGrave,
} from "@/lib/storage";
import { generateId } from "@/lib/exif";
import { SCAN_USAGE } from "@/lib/usageActions";
import { localContrastBoost, unsharpMask } from "@/lib/relief";
import type { QueuedCapture, ExtractedGraveData, ResearchData, GraveRecord } from "@/types";

const MAX_RETRIES = 3;

class RateLimitError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs = 10000) {
    super("rate_limited");
    this.retryAfterMs = retryAfterMs;
  }
}

// Custom event name used to notify UI of queue changes
export const QUEUE_CHANGED_EVENT = "gravelens:queue-changed";

function notifyQueueChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(QUEUE_CHANGED_EVENT));
  }
}

/**
 * Preprocess a stored data URL for sending to Claude:
 * contrast stretch → CLAHE-lite → unsharp mask → resize to ≤ 1568 px.
 * Matches the pipeline used by live captures in CapturePage.
 */
function preprocessForClaude(
  dataUrl: string
): Promise<{ base64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const maxPx = 1568;
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Canvas unavailable"));
      ctx.drawImage(img, 0, 0, w, h);

      const imageData = ctx.getImageData(0, 0, w, h);
      const data = imageData.data;

      // 1. Global contrast stretch
      let min = 255, max = 0;
      for (let i = 0; i < data.length; i += 4) {
        const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (luma < min) min = luma;
        if (luma > max) max = luma;
      }
      const range = max - min || 1;
      for (let i = 0; i < data.length; i += 4) {
        data[i]     = Math.min(255, Math.max(0, ((data[i]     - min) / range) * 255));
        data[i + 1] = Math.min(255, Math.max(0, ((data[i + 1] - min) / range) * 255));
        data[i + 2] = Math.min(255, Math.max(0, ((data[i + 2] - min) / range) * 255));
      }

      // 2. CLAHE-lite: local contrast boost (8×8 tile grid)
      localContrastBoost(data, w, h);

      // 3. Unsharp mask (0.5 strength)
      unsharpMask(data, w, h, 0.5);

      ctx.putImageData(imageData, 0, 0);
      const resized = canvas.toDataURL("image/jpeg", 0.78);
      resolve({ base64: resized.split(",")[1], mimeType: "image/jpeg" });
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function processItem(item: QueuedCapture): Promise<void> {
  const loc = item.location ?? { lat: 0, lng: 0 };
  // Mark as processing (temporarily — we still use "pending" as the stored status)
  let extracted: ExtractedGraveData | null = null;

  try {
    const preprocessed = await preprocessForClaude(item.photoDataUrl);
    const claudeRes = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64: preprocessed.base64,
        mimeType: preprocessed.mimeType,
        // Label queued scans as "Scan a marker" too. (prompt_id is a uuid column,
        // and item.id isn't a uuid, so mint one; the cultural summary the result
        // page auto-loads for a queued grave logs under its own id — acceptable
        // for this uncommon offline path.)
        promptId: crypto.randomUUID(),
        ...SCAN_USAGE,
      }),
      // Cap a hung connection so the background queue worker can't stall
      // indefinitely; a timeout throws and the item retries.
      signal: AbortSignal.timeout(30000),
    });
    if (claudeRes.status === 429) {
      // Respect Retry-After header if present, otherwise back off 15 s
      const retryAfter = claudeRes.headers.get("retry-after");
      const retryAfterSec = retryAfter ? parseInt(retryAfter) : 0;
      const ms = (retryAfterSec && !isNaN(retryAfterSec)) ? retryAfterSec * 1000 : 15000;
      throw new RateLimitError(ms);
    }
    if (claudeRes.ok) {
      const json = await claudeRes.json();
      if (json.extracted) extracted = json.extracted;
    }
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    // Network or API failure — will retry
    throw new Error("Claude analysis failed");
  }

  if (!extracted) throw new Error("No extraction result");

  // Research lookup — best effort, non-blocking on failure
  let research: ResearchData = {};
  if (extracted.name) {
    try {
      const lookupRes = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: extracted.name,
          firstName: extracted.firstName,
          lastName: extracted.lastName,
          birthYear: extracted.birthYear,
          deathYear: extracted.deathYear,
          lat: loc.lat,
          lng: loc.lng,
          city: loc.city,
          county: loc.county,
          state: loc.state,
          cemetery: loc.cemetery,
          inscription: extracted.inscription ?? "",
          symbols: extracted.symbols ?? [],
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (lookupRes.ok) {
        const d = await lookupRes.json();
        research = {
          newspapers: d.newspapers ?? [],
          naraRecords: d.naraRecords ?? [],
          landRecords: d.landRecords ?? [],
          historical: d.historical ?? {},
          militaryContext: d.militaryContext ?? undefined,
          localHistory: d.localHistory ?? undefined,
          cemetery: loc.cemetery
            ? { name: loc.cemetery, location: loc }
            : undefined,
        };
      }
    } catch {
      // Non-fatal — save with empty research
    }
  }

  // Tag with session name if present
  const tags = item.sessionName ? [item.sessionName] : [];

  const record: GraveRecord = {
    id: item.id,
    timestamp: item.timestamp,
    photoDataUrl: item.photoDataUrl,
    location: loc,
    extracted,
    research,
    tags,
  };

  await saveGrave(record);
  await removeFromQueue(item.id);
  notifyQueueChanged();
}

let processing = false;
let activeItemId: string | null = null;

export function getActiveItemId(): string | null {
  return activeItemId;
}

export async function processQueue(): Promise<void> {
  if (processing) return;
  if (typeof navigator !== "undefined" && !navigator.onLine) return;

  processing = true;
  try {
    const items = await getQueuedItems();
    const pending = items.filter(
      (i) => i.status === "pending" && i.retries < MAX_RETRIES
    );

    for (const item of pending) {
      activeItemId = item.id;
      notifyQueueChanged();
      try {
        await processItem(item);
        // Small gap between items so we don't immediately re-trigger rate limits
        await new Promise((r) => setTimeout(r, 1500));
      } catch (err) {
        if (err instanceof RateLimitError) {
          // Don't count rate limiting as a failure — just pause and stop this pass
          console.log(`[Queue] Rate limited — backing off ${err.retryAfterMs}ms`);
          activeItemId = null;
          notifyQueueChanged();
          await new Promise((r) => setTimeout(r, err.retryAfterMs));
          // Re-trigger a fresh pass after the backoff
          setTimeout(() => processQueue(), 100);
          return;
        }
        const updated: QueuedCapture = {
          ...item,
          retries: item.retries + 1,
          status: item.retries + 1 >= MAX_RETRIES ? "failed" : "pending",
        };
        await updateQueueItem(updated);
        notifyQueueChanged();
      } finally {
        activeItemId = null;
      }
    }
  } finally {
    processing = false;
    activeItemId = null;
    notifyQueueChanged();
  }
}

/**
 * Start the background queue processor.
 * Processes immediately if online, then re-processes whenever the device
 * comes back online or the tab regains focus.
 * Returns a cleanup function.
 */
export function startQueueProcessor(): () => void {
  const onOnline = () => processQueue();
  const onVisible = () => {
    if (document.visibilityState === "visible") processQueue();
  };

  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);

  // Process immediately on start
  processQueue();

  return () => {
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

export async function retryQueueItem(id: string): Promise<void> {
  const items = await getQueuedItems();
  const item = items.find((i) => i.id === id);
  if (item) {
    item.retries = 0;
    item.status = "pending";
    await updateQueueItem(item);
    notifyQueueChanged();
    processQueue();
  }
}

export async function retryAllFailedItems(): Promise<void> {
  const items = await getQueuedItems();
  const failed = items.filter((i) => i.status === "failed");
  for (const item of failed) {
    item.retries = 0;
    item.status = "pending";
    await updateQueueItem(item);
  }
  if (failed.length > 0) {
    notifyQueueChanged();
    processQueue();
  }
}

export async function deleteQueueItem(id: string): Promise<void> {
  await removeFromQueue(id);
  notifyQueueChanged();
}

// Re-export generateId so callers can create IDs without importing exif directly
export { generateId };
