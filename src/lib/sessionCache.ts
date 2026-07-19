"use client";

/**
 * Per-user sessionStorage cache for stale-while-revalidate paints.
 *
 * A module-level variable gives instant repaint on client-side (soft) navigation
 * but is wiped by a hard reload / external entry. sessionStorage survives the
 * reload while staying scoped to the tab session, so a returning user sees their
 * last-known balance/rewards immediately instead of a spinner. Every read
 * validates the stored userId so one account never renders another's data.
 *
 * Reads MUST happen after mount (a layout effect), never in a useState
 * initializer: the server renders without storage, so seeding initial state from
 * it would desync hydration. Use `useIsomorphicLayoutEffect` below to hydrate
 * before the browser paints (no spinner flash).
 */

import { useEffect, useLayoutEffect } from "react";

interface Envelope<T> {
  userId: string;
  data: T;
}

export function readSessionCache<T>(key: string, userId: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Envelope<T>;
    return parsed?.userId === userId ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeSessionCache<T>(key: string, userId: string, data: T): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(key, JSON.stringify({ userId, data } satisfies Envelope<T>));
  } catch {
    /* quota exceeded / storage disabled — non-fatal, we just lose the fast path */
  }
}

export function clearSessionCache(key: string): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * useLayoutEffect on the client (hydrate cached data before paint), useEffect on
 * the server (avoids the "useLayoutEffect does nothing on the server" warning).
 */
export const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;
