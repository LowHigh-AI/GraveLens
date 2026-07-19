import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { enrichCemetery, fetchOsmCemeteryDetails, cemeteryId } from "@/lib/apis/cemetery";
import { createClient } from "@/lib/supabase/server";
import { checkCemeteryCache, saveCemeteryCache } from "@/lib/community";
import { requireRateLimit } from "@/lib/rateLimit";

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  // Calls Overpass + Wikipedia; rate-limit so it can't be looped against them.
  const rl = await requireRateLimit(auth.userId, "enrich");
  if (rl) return rl;

  try {
    const { name, lat, lng, city, state, force } = await req.json();
    if (!name || typeof lat !== "number" || typeof lng !== "number") {
      return NextResponse.json({ error: "name, lat, lng required" }, { status: 400 });
    }

    // The force-refresh path bypasses the cache and always hits the upstream
    // APIs — gate it behind a much tighter sub-limit.
    if (force) {
      const forceRl = await requireRateLimit(auth.userId, "enrich-force");
      if (forceRl) return forceRl;
    }

    const supabase = await createClient();

    // 1. Run OSM query to get osmId (pass name for better candidate selection)
    const osmData = (await fetchOsmCemeteryDetails(lat, lng, name).catch(() => ({}))) as {
      osmId?: string;
      openingHours?: string;
      phone?: string;
      website?: string;
      denomination?: string;
    };
    if (osmData.osmId && !force) {
      // 2. Check cache first (skipped on explicit force-refresh)
      const cached = await checkCemeteryCache(supabase, osmData.osmId);
      if (cached) {
        return NextResponse.json({
          id: cemeteryId(name, lat, lng, osmData.osmId),
          name: cached.name || name,
          lat,
          lng,
          osmId: osmData.osmId,
          openingHours: osmData.openingHours,
          phone: osmData.phone,
          website: osmData.website,
          wikipediaUrl: cached.wikipediaUrl,
          denomination: osmData.denomination,
          established: cached.established,
          description: cached.description,
          notableFeatures: cached.notableFeatures,
          historicalEvents: cached.historicalEvents,
        });
      }
    }

    // 3. Cache miss: perform full enrichment
    const result = await enrichCemetery(name, lat, lng, city, state);

    // 4. Save to cache
    if (result.osmId) {
      await saveCemeteryCache(supabase, result.osmId, {
        name: result.name,
        description: result.description,
        wikipediaUrl: result.wikipediaUrl,
        established: result.established,
        denomination: result.denomination,
        notableFeatures: result.notableFeatures,
        historicalEvents: result.historicalEvents,
      }).catch((err) => console.error("[cemetery-cache-save] failed:", err));
    }

    return NextResponse.json({
      ...result,
      osmId: result.osmId ?? null
    });
  } catch (err) {
    console.error("[enrich-cemetery]", err);
    return NextResponse.json({ error: "enrichment failed" }, { status: 500 });
  }
}

