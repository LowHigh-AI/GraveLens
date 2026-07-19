/**
 * Community feature utilities for GraveLens.
 *
 * Provides:
 *  - Fetching public graves from friends and the broader community for map display
 *  - User profile upsert / fetch
 *  - Shared AI-result caches (local history, cemetery, military context, grave identity)
 *
 * All functions are non-fatal — callers should treat failures gracefully since
 * community data is supplemental to the user's own local-first archive.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CommunityGraveRecord,
  UserProfile,
  LocalHistoryContext,
  MilitaryContext,
} from "@/types";
import { photoProxyUrl } from "@/lib/photoUrl";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Truncate a coordinate to 1 decimal place for geo-cell keying (~11 km grid). */
function geoCell(lat: number, lng: number): string {
  return `${lat.toFixed(1)}_${lng.toFixed(1)}`;
}

/**
 * Resolve the public display label for a contributor given their profile row.
 *
 * Identity is the single account Display Name, mirrored into `display_name` only
 * while the contributor has opted to show it (`show_username`). When hidden, the
 * mirror is null and the contributor is anonymous.
 */
function resolveContributorLabel(profile: {
  display_name?: string | null;
  show_username?: boolean | null;
}): string {
  if (profile.show_username && profile.display_name) return profile.display_name;
  return "Community Member";
}

// ── User profiles ─────────────────────────────────────────────────────────────

/**
 * Upsert the current user's profile.
 * Called on login and after significant stat changes.
 */
export async function upsertUserProfile(
  supabase: SupabaseClient,
  userId: string,
  patch: Partial<{
    username: string;
    displayName: string | null;
    showUsername: boolean;
    shareAllByDefault: boolean;
    explorerXp: number;
    explorerRank: number;
    graveCount: number;
    publicGraveCount: number;
  }>
): Promise<void> {
  const row: Record<string, unknown> = { user_id: userId, updated_at: new Date().toISOString() };
  if (patch.username !== undefined)          row.username              = patch.username;
  if (patch.displayName !== undefined)       row.display_name          = patch.displayName;
  if (patch.showUsername !== undefined)      row.show_username         = patch.showUsername;
  if (patch.shareAllByDefault !== undefined) row.share_all_by_default  = patch.shareAllByDefault;
  if (patch.explorerXp !== undefined)        row.explorer_xp           = patch.explorerXp;
  if (patch.explorerRank !== undefined)      row.explorer_rank         = patch.explorerRank;
  if (patch.graveCount !== undefined)        row.scan_count           = patch.graveCount;
  if (patch.publicGraveCount !== undefined)  row.public_scan_count    = patch.publicGraveCount;

  const { error } = await supabase.from("gravelens_user_profiles").upsert(row);
  if (error) throw error;
}

/**
 * Fetch the current user's own profile. Returns null if not yet created.
 */
export async function fetchOwnProfile(
  supabase: SupabaseClient,
  userId: string
): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from("gravelens_user_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) return null;

  return {
    userId: data.user_id,
    username: data.username ?? undefined,
    displayName: data.display_name ?? undefined,
    showUsername: data.show_username ?? true,
    shareAllByDefault: data.share_all_by_default ?? false,
    explorerXp: data.explorer_xp ?? 0,
    explorerRank: data.explorer_rank ?? 1,
    graveCount: data.scan_count ?? 0,
    publicGraveCount: data.public_scan_count ?? 0,
    joinedAt: data.joined_at,
  };
}

// ── Community graves ──────────────────────────────────────────────────────────

/**
 * Fetch public graves within a lat/lng bounding box, excluding the current
 * user's own graves. Attaches contributor display info from user_profiles.
 *
 * Returns both "friend" and "community" tier records in one call, distinguished
 * by the `tier` field. The caller can split or render them differently.
 *
 * Limit: 200 records per call to keep map performance acceptable.
 */
export async function fetchCommunityGravesInBounds(
  supabase: SupabaseClient,
  userId: string,
  south: number,
  west: number,
  north: number,
  east: number
): Promise<CommunityGraveRecord[]> {
  // 1. Get confirmed friend IDs so we can tag their graves differently
  const { data: friendRows } = await supabase
    .from("gravelens_user_relationships")
    .select("from_user_id, to_user_id")
    .eq("type", "friend")
    .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`);

  const friendIds = new Set<string>();
  for (const row of friendRows ?? []) {
    const otherId = row.from_user_id === userId ? row.to_user_id : row.from_user_id;
    friendIds.add(otherId);
  }

  // 2. Fetch public graves in bounds (exclude own graves)
  //    Filter by location jsonb lat/lng — cast to float for comparison
  const { data: graveRows, error } = await supabase
    .from("gravelens_scans")
    .select(`
      id,
      user_id,
      photo_url,
      location,
      extracted,
      community_note,
      user_profiles!inner (
        display_name,
        show_username,
        explorer_rank
      )
    `)
    .eq("is_public", true)
    .neq("user_id", userId)
    .limit(200);

  if (error || !graveRows) return [];

  const results: CommunityGraveRecord[] = [];

  for (const row of graveRows) {
    const loc = row.location as { lat?: number; lng?: number; cemetery?: string } | null;
    if (!loc?.lat || !loc?.lng) continue;

    // Client-side bounds filter (Supabase doesn't support jsonb range queries without PostGIS)
    if (loc.lat < south || loc.lat > north || loc.lng < west || loc.lng > east) continue;

    const profile = Array.isArray(row.user_profiles)
      ? row.user_profiles[0]
      : row.user_profiles;
    const extracted = row.extracted as {
      name?: string;
      birthDate?: string;
      deathDate?: string;
    } | null;

    results.push({
      id: row.id,
      lat: loc.lat,
      lng: loc.lng,
      name: extracted?.name || "Unknown",
      birthDate: extracted?.birthDate,
      deathDate: extracted?.deathDate,
      cemetery: loc.cemetery,
      // Served through the authenticated proxy (the bucket is private); the
      // proxy authorizes cross-user views via the grave's is_public flag.
      photoUrl: photoProxyUrl(row.id),
      communityNote: row.community_note ?? undefined,
      tier: friendIds.has(row.user_id) ? "friend" : "community",
      contributorLabel: profile ? resolveContributorLabel(profile) : "Community Member",
      contributorRank: profile?.explorer_rank ?? 1,
    });
  }

  return results;
}

/**
 * Bulk-set all of the current user's graves to public or private.
 * Used by the "Share all my discoveries" global toggle.
 */
export async function bulkSetGravesPublic(
  supabase: SupabaseClient,
  userId: string,
  isPublic: boolean
): Promise<void> {
  const { error } = await supabase
    .from("gravelens_scans")
    .update({ is_public: isPublic })
    .eq("user_id", userId);

  if (error) throw error;
}

/**
 * Set a single grave's public flag.
 */
export async function setGravePublic(
  supabase: SupabaseClient,
  graveId: string,
  isPublic: boolean
): Promise<void> {
  const { error } = await supabase
    .from("gravelens_scans")
    .update({ is_public: isPublic })
    .eq("id", graveId);

  if (error) throw error;
}

// ── Local history cache ───────────────────────────────────────────────────────

export interface LocalHistoryCacheEntry {
  localHistory: LocalHistoryContext;
  wikidataEvents?: unknown;
  nrhpSites?: unknown;
  sources?: unknown;
}

/**
 * Check the shared local history cache for a given lat/lng.
 * Returns null if no fresh entry exists (stale or missing).
 */
export async function checkLocalHistoryCache(
  supabase: SupabaseClient,
  lat: number,
  lng: number
): Promise<LocalHistoryCacheEntry | null> {
  const cell = geoCell(lat, lng);

  const { data, error } = await supabase
    .from("gravelens_local_history_cache")
    .select("local_history, wikidata_events, nrhp_sites, sources, expires_at")
    .eq("geo_cell", cell)
    .maybeSingle();

  if (error || !data) return null;
  if (new Date(data.expires_at) < new Date()) return null; // stale

  return {
    localHistory: data.local_history as LocalHistoryContext,
    wikidataEvents: data.wikidata_events,
    nrhpSites: data.nrhp_sites,
    sources: data.sources,
  };
}

/**
 * Write a local history result to the shared cache.
 * Safe to call fire-and-forget; errors are non-fatal.
 */
export async function saveLocalHistoryCache(
  supabase: SupabaseClient,
  lat: number,
  lng: number,
  entry: LocalHistoryCacheEntry
): Promise<void> {
  const cell = geoCell(lat, lng);

  await supabase.from("gravelens_local_history_cache").upsert({
    geo_cell: cell,
    local_history: entry.localHistory,
    wikidata_events: entry.wikidataEvents ?? null,
    nrhp_sites: entry.nrhpSites ?? null,
    sources: entry.sources ?? null,
    generated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
  });
}

// ── Cemetery research cache ───────────────────────────────────────────────────

export interface CemeteryResearchEntry {
  name?: string;
  description?: string;
  wikipediaUrl?: string;
  established?: string;
  denomination?: string;
  notableFeatures?: string[];
  historicalEvents?: string[];
}

/**
 * Check the shared cemetery cache by OSM ID.
 * Returns null if missing or stale.
 */
export async function checkCemeteryCache(
  supabase: SupabaseClient,
  osmId: string
): Promise<CemeteryResearchEntry | null> {
  const { data, error } = await supabase
    .from("gravelens_cemetery_cache")
    .select("*")
    .eq("osm_id", osmId)
    .maybeSingle();

  if (error || !data) return null;
  if (new Date(data.expires_at) < new Date()) return null;

  return {
    name: data.name ?? undefined,
    description: data.description ?? undefined,
    wikipediaUrl: data.wikipedia_url ?? undefined,
    established: data.established ?? undefined,
    denomination: data.denomination ?? undefined,
    notableFeatures: data.notable_features ?? undefined,
    historicalEvents: data.historical_events ?? undefined,
  };
}

/**
 * Write a cemetery research result to the shared cache.
 */
export async function saveCemeteryCache(
  supabase: SupabaseClient,
  osmId: string,
  entry: CemeteryResearchEntry
): Promise<void> {
  await supabase.from("gravelens_cemetery_cache").upsert({
    osm_id: osmId,
    name: entry.name ?? null,
    description: entry.description ?? null,
    wikipedia_url: entry.wikipediaUrl ?? null,
    established: entry.established ?? null,
    denomination: entry.denomination ?? null,
    notable_features: entry.notableFeatures ?? null,
    historical_events: entry.historicalEvents ?? null,
    generated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
  });
}

// ── Military context cache ────────────────────────────────────────────────────

/**
 * Fetch a pre-generated military conflict context by conflict key.
 * e.g. "world_war_i", "civil_war_union", "vietnam_war"
 */
export async function getMilitaryContextCache(
  supabase: SupabaseClient,
  conflictKey: string
): Promise<MilitaryContext | null> {
  const { data, error } = await supabase
    .from("gravelens_military_context_cache")
    .select("context")
    .eq("conflict_key", conflictKey)
    .maybeSingle();

  if (error || !data) return null;
  return data.context as MilitaryContext;
}

// ── Grave identity index (deduplication) ─────────────────────────────────────

/**
 * Compute a stable identity hash for cross-user research reuse.
 *
 * Key = firstName | lastName | birthYear | deathYear | geo-cell.
 *
 * We deliberately key on a rounded geo-cell (the ~11 km grid used for the local
 * history cache) rather than a cemetery OSM id: OSM tags drift, get re-numbered,
 * or go missing over time, whereas a grave's physical coordinates are stable, and
 * an ~11 km cell is coarse enough that GPS jitter never splits the same grave yet
 * fine enough to separate two unrelated same-named people in different regions.
 *
 * Requires at least a surname + death year to identify someone safely; firstName,
 * birthYear and the geo-cell are folded in whenever present to reduce the chance
 * of attaching one person's research to a different same-surname individual.
 * Returns null when the inputs are too sparse to identify safely.
 */
export function computeGraveIdentityHash(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  birthYear: number | null | undefined,
  deathYear: number | null | undefined,
  lat?: number | null,
  lng?: number | null
): string | null {
  const last = (lastName ?? "").trim().toLowerCase();
  if (!last || !deathYear) return null;

  const first = (firstName ?? "").trim().toLowerCase();
  const hasCoords =
    typeof lat === "number" && typeof lng === "number" && (lat !== 0 || lng !== 0);
  const cell = hasCoords ? geoCell(lat as number, lng as number) : "";

  // Simple deterministic key — not cryptographic, just stable for deduplication.
  return [first, last, birthYear ? String(birthYear) : "", String(deathYear), cell].join("|");
}

export interface GraveIdentityMatch {
  identityHash: string;
  researchSnapshot: unknown;
  contributorCount: number;
}

/**
 * Check if this grave has already been scanned and enriched by another user.
 * Returns the cached research snapshot if found, or null if first scan.
 */
export async function checkGraveIdentityIndex(
  supabase: SupabaseClient,
  identityHash: string
): Promise<GraveIdentityMatch | null> {
  const { data, error } = await supabase
    .from("gravelens_scan_identity_index")
    .select("identity_hash, research_snapshot, contributor_count, expires_at")
    .eq("identity_hash", identityHash)
    .maybeSingle();

  if (error || !data) return null;
  if (new Date(data.expires_at) < new Date()) return null;

  return {
    identityHash: data.identity_hash,
    researchSnapshot: data.research_snapshot,
    contributorCount: data.contributor_count,
  };
}

/**
 * Register a newly scanned grave in the identity index, or increment the
 * contributor count if it was already there.
 */
export async function upsertGraveIdentityIndex(
  supabase: SupabaseClient,
  identityHash: string,
  researchSnapshot: unknown
): Promise<void> {
  const { error } = await supabase.rpc("gravelens_upsert_scan_identity", {
    hash: identityHash,
    snapshot: researchSnapshot,
  });
  if (error) {
    console.error("[Community] Failed to upsert grave identity:", error);
    throw error;
  }
}

// ── GraveLens burial index (pooled person DB) + person identity key ──────────
// Appended from the pre-v1.0.0 research work; rewired to the shared
// gravelens_ schema. Research-response caching uses THEIR
// checkGraveIdentityIndex/upsertGraveIdentityIndex above (D2 decision).

export function computePersonIdentityKey(p: {
  givenName?: string;
  surname?: string;
  birthYear?: number | null;
  deathYear?: number | null;
  state?: string;
}): string | null {
  const surname = p.surname?.trim().toLowerCase();
  if (!surname) return null;
  if (!p.birthYear && !p.deathYear) return null;
  return [
    (p.givenName ?? "").trim().toLowerCase(),
    surname,
    p.birthYear ?? "",
    p.deathYear ?? "",
    (p.state ?? "").trim().toLowerCase(),
  ].join("|");
}


export interface BurialIndexEntry {
  identityKey: string;
  givenName?: string;
  surname: string;
  fullName?: string;
  surnameSoundex?: string;
  birthYear?: number | null;
  deathYear?: number | null;
  birthDate?: string;
  deathDate?: string;
  cemetery?: string;
  city?: string;
  county?: string;
  state?: string;
  lat?: number;
  lng?: number;
}

/**
 * Harvest a scan into the pooled burial index. Repeat scans of the same
 * person increment scan_count and back-fill missing facts. Non-fatal.
 */
export async function upsertBurialIndex(
  supabase: SupabaseClient,
  e: BurialIndexEntry
): Promise<void> {
  const { error } = await supabase.rpc("gravelens_upsert_burial_index", {
    p_identity_key:    e.identityKey,
    p_given_name:      e.givenName ?? null,
    p_surname:         e.surname,
    p_full_name:       e.fullName ?? null,
    p_surname_soundex: e.surnameSoundex ?? null,
    p_birth_year:      e.birthYear ?? null,
    p_death_year:      e.deathYear ?? null,
    p_birth_date:      e.birthDate || null,
    p_death_date:      e.deathDate || null,
    p_cemetery:        e.cemetery || null,
    p_city:            e.city || null,
    p_county:          e.county || null,
    p_state:           e.state || null,
    p_lat:             e.lat ?? null,
    p_lng:             e.lng ?? null,
  });
  if (error) console.error("[burial-index] upsert failed:", error.message);
}

export interface BurialIndexPerson {
  identityKey: string;
  name: string;
  birthYear?: number;
  deathYear?: number;
  birthDate?: string;
  deathDate?: string;
  cemetery?: string;
  city?: string;
  state?: string;
  /** How many community scans contributed this person */
  scanCount: number;
}

/**
 * Person search over the pooled burial index — the "instant tier" of the
 * /research page. Matches surname (+ optional given-name prefix), narrows by
 * year windows and state when provided. Runs before any external call: a hit
 * means someone already scanned/researched this person and the shared
 * research cache will answer the full lookup for free.
 */
export async function searchBurialIndexPeople(
  supabase: SupabaseClient,
  opts: {
    lastName: string;
    firstName?: string;
    birthYear?: number | null;
    deathYear?: number | null;
    state?: string;
  }
): Promise<BurialIndexPerson[]> {
  const lastName = opts.lastName?.trim();
  if (!lastName || lastName.length < 2) return [];

  let query = supabase
    .from("gravelens_burial_index")
    .select("identity_key, given_name, surname, birth_year, death_year, birth_date, death_date, cemetery, city, state, scan_count")
    .ilike("surname", lastName)
    .limit(20);

  if (opts.firstName?.trim()) query = query.ilike("given_name", `${opts.firstName.trim()}%`);
  // Year windows exclude null-year rows by design — precision over recall here.
  if (opts.birthYear) query = query.gte("birth_year", opts.birthYear - 2).lte("birth_year", opts.birthYear + 2);
  if (opts.deathYear) query = query.gte("death_year", opts.deathYear - 2).lte("death_year", opts.deathYear + 2);
  if (opts.state?.trim()) query = query.ilike("state", opts.state.trim());

  const { data, error } = await query;
  if (error || !data) return [];

  return data.map((row) => ({
    identityKey: row.identity_key,
    name: [row.given_name, row.surname].filter(Boolean).join(" ").trim() || row.surname,
    birthYear: row.birth_year ?? undefined,
    deathYear: row.death_year ?? undefined,
    birthDate: row.birth_date ?? undefined,
    deathDate: row.death_date ?? undefined,
    cemetery: row.cemetery ?? undefined,
    city: row.city ?? undefined,
    state: row.state ?? undefined,
    scanCount: row.scan_count ?? 1,
  })).sort((a, b) => (a.deathYear ?? 9999) - (b.deathYear ?? 9999));
}

export interface BurialIndexRelative {
  /** Pooled identity key — stable dedup handle against local records */
  identityKey: string;
  name: string;
  birthYear?: number;
  deathYear?: number;
  cemetery?: string;
}

/**
 * Query the pooled burial index for other people with the same surname in the
 * same cemetery — the cross-user "who else is in this family plot" view built
 * from every GraveLens user's scans. Anonymous facts only (no user id/photos).
 *
 * Matches surname (case-insensitive) then narrows to the same cemetery, or to
 * a ~1 km GPS radius when the cemetery name is missing. Excludes the subject
 * via their identity key. Non-fatal — returns [] on any error.
 */
export async function fetchBurialIndexRelatives(
  supabase: SupabaseClient,
  opts: {
    surname: string;
    cemetery?: string;
    lat?: number;
    lng?: number;
    excludeIdentityKey?: string | null;
  }
): Promise<BurialIndexRelative[]> {
  const surname = opts.surname?.trim();
  if (!surname || surname.length < 2) return [];

  const { data, error } = await supabase
    .from("gravelens_burial_index")
    .select("identity_key, given_name, surname, birth_year, death_year, cemetery, lat, lng")
    .ilike("surname", surname)
    .limit(50);

  if (error || !data) return [];

  const cemeteryLc = opts.cemetery?.trim().toLowerCase();
  const hasGps = typeof opts.lat === "number" && typeof opts.lng === "number";

  const seen = new Set<string>();
  const out: BurialIndexRelative[] = [];

  for (const row of data) {
    if (opts.excludeIdentityKey && row.identity_key === opts.excludeIdentityKey) continue;

    // Narrow to the same cemetery (preferred) or GPS proximity (~0.01° ≈ 1 km).
    const sameCemetery = cemeteryLc && (row.cemetery ?? "").toLowerCase() === cemeteryLc;
    const nearby =
      hasGps &&
      typeof row.lat === "number" &&
      typeof row.lng === "number" &&
      Math.abs(row.lat - opts.lat!) < 0.01 &&
      Math.abs(row.lng - opts.lng!) < 0.01;
    if (!sameCemetery && !nearby) continue;

    const name = [row.given_name, row.surname].filter(Boolean).join(" ").trim() || row.surname;
    if (seen.has(row.identity_key)) continue;
    seen.add(row.identity_key);

    out.push({
      identityKey: row.identity_key,
      name,
      birthYear: row.birth_year ?? undefined,
      deathYear: row.death_year ?? undefined,
      cemetery: row.cemetery ?? undefined,
    });
  }

  // Sort by death year (chronological family view), unknowns last.
  out.sort((a, b) => (a.deathYear ?? 9999) - (b.deathYear ?? 9999));
  return out.slice(0, 10);
}