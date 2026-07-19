"use client";

/**
 * App-wide background auto-backup.
 *
 * Most scans already upload the moment they are captured (ResultPage), but a
 * scan made offline or while signed out lands in IndexedDB with no `syncedAt`.
 * This component retries those automatically whenever the device is in a state
 * where a backup can succeed — on reconnect and when the app returns to the
 * foreground — so the manual "Back Up Data" button and the avatar badge become
 * a rare safety net rather than a routine chore.
 *
 * It is fire-and-forget and self-throttling: it only does network work when the
 * user is signed in, online, and there is genuinely unsynced data, and it
 * dispatches ARCHIVE_SYNCED_EVENT so the badge refreshes.
 */

import { useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth";
import { createClient } from "@/lib/supabase/browser";
import { syncLocalToCloud, pushExplorerPoints, notifyArchiveSynced } from "@/lib/cloudSync";
import { countUnsyncedGraves } from "@/lib/storage";

const COOLDOWN_MS = 15000; // collapse online+visibility double-fires

export default function AutoBackup() {
  const { user } = useAuth();
  const userId = user?.id;
  const runningRef = useRef(false);
  const lastRunRef = useRef(0);

  useEffect(() => {
    if (!userId) return;

    const maybeBackup = async () => {
      if (runningRef.current) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (Date.now() - lastRunRef.current < COOLDOWN_MS) return;

      // Cheap local check first — avoid any network work when fully backed up.
      const pending = await countUnsyncedGraves().catch(() => 0);
      if (pending === 0) return;

      runningRef.current = true;
      try {
        const supabase = createClient();
        await syncLocalToCloud(supabase, userId);
        await pushExplorerPoints(supabase, userId).catch(() => {});
        notifyArchiveSynced();
      } catch {
        /* offline / transient — will retry on the next online or foreground */
      } finally {
        runningRef.current = false;
        lastRunRef.current = Date.now();
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") maybeBackup();
    };

    // Attempt once on mount (e.g. app opened with a backlog), then on reconnect
    // and whenever the app returns to the foreground.
    maybeBackup();
    window.addEventListener("online", maybeBackup);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", maybeBackup);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId]);

  return null;
}
