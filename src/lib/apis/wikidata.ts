// Wikidata SPARQL utilities for GraveLens historical enrichment.
// Finds items with a geo-coordinate within ~50 km of the grave that have a
// point-in-time (P585) date falling within birth–death years.
// Excludes NRHP heritage sites (covered separately by nrhp.ts).

import type { WikidataEvent, NotableFigure } from "@/types";

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

// Reject anything that isn't a real finite number — prevents SPARQL injection
// from crafted API payloads where typed params may carry non-numeric runtime values.
function safeNum(val: unknown): number | null {
  return typeof val === "number" && Number.isFinite(val) ? val : null;
}

export async function getLocalWikidataEvents(
  lat: number,
  lng: number,
  birthYear: number | null,
  deathYear: number | null
): Promise<WikidataEvent[]> {
  const safeLat  = safeNum(lat);
  const safeLng  = safeNum(lng);
  const safeBirth = safeNum(birthYear);
  const safeDeath = safeNum(deathYear);
  if (safeLat === null || safeLng === null || safeBirth === null || safeDeath === null) return [];

  // WKT format: Point(longitude latitude)
  const point = `Point(${safeLng} ${safeLat})`;
  const radiusKm = 50;

  const query = `
SELECT DISTINCT ?item ?itemLabel ?date ?desc WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "${point}"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
  }
  ?item wdt:P585 ?date .
  FILTER(YEAR(?date) >= ${safeBirth} && YEAR(?date) <= ${safeDeath})
  FILTER NOT EXISTS { ?item wdt:P1435 wd:Q652150 }
  OPTIONAL { ?item schema:description ?desc FILTER(LANG(?desc) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
ORDER BY ?date
LIMIT 20`.trim();

  try {
    const res = await fetch(
      `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`,
      {
        headers: {
          Accept: "application/sparql-results+json",
          "User-Agent": "GraveLens/1.0 (genealogy research app)",
        },
        signal: AbortSignal.timeout(6000),
      }
    );

    if (!res.ok) return [];

    const data = await res.json();
    const bindings: Array<Record<string, { value: string }>> =
      data?.results?.bindings ?? [];

    return bindings
      .map((b) => {
        const label = b.itemLabel?.value ?? "";
        const wikidataId = b.item?.value?.split("/").pop() ?? "";

        // Skip if the label is just the Wikidata ID (no human-readable name)
        if (!label || label === wikidataId || /^Q\d+$/.test(label)) return null;

        const rawDate = b.date?.value ?? "";
        const year = rawDate ? new Date(rawDate).getFullYear() : 0;
        if (!year) return null;

        const evt: WikidataEvent = {
          label,
          year,
          description: b.desc?.value,
          wikidataId,
        };
        return evt;
      })
      .filter((e): e is WikidataEvent => e !== null);
  } catch {
    return [];
  }
}

// ── Notable figures in viewport ──────────────────────────────────────────────

const OCCUPATION_MAP: Record<string, NotableFigure["category"]> = {
  // Political
  Q82955: "political",  // Politician
  Q48352: "political",  // Head of state
  Q193391: "political", // Diplomat
  Q116: "political",    // Monarch
  Q30461: "political",  // President
  // Military
  Q189290: "military",  // Military officer
  Q210706: "military",  // General
  Q11533: "military",   // Soldier
  Q211140: "military",  // Strategist
  // Artist
  Q48350: "artist",     // Artist
  Q102818: "artist",    // Painter
  Q128161: "artist",    // Sculptor
  // Musician
  Q639669: "musician",  // Musician
  Q36834: "musician",   // Composer
  Q177220: "musician",  // Singer
  // Actor
  Q33999: "actor",      // Actor
  Q214917: "actor",     // Playwright
  Q252625: "actor",     // Film director
};

export async function getNotableFiguresInBounds(
  south: number,
  west: number,
  north: number,
  east: number,
  minSitelinks = 2,
  signal?: AbortSignal
): Promise<NotableFigure[]> {
  const safeSouth = safeNum(south);
  const safeWest  = safeNum(west);
  const safeNorth = safeNum(north);
  const safeEast  = safeNum(east);
  const safeLinks = safeNum(minSitelinks);
  if (safeSouth === null || safeWest === null || safeNorth === null || safeEast === null || safeLinks === null) return [];

  const query = `
SELECT DISTINCT ?item ?itemLabel ?coords ?occupation ?occupationLabel ?wikipedia WHERE {
  ?item wdt:P119 ?burialPlace .
  ?item wdt:P31 wd:Q5 .
  SERVICE wikibase:box {
    ?burialPlace wdt:P625 ?coords .
    bd:serviceParam wikibase:cornerSouthWest "Point(${safeWest} ${safeSouth})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(${safeEast} ${safeNorth})"^^geo:wktLiteral .
  }
  ?item wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks >= ${safeLinks})

  OPTIONAL { ?item wdt:P106 ?occupation . }
  OPTIONAL {
    ?wikipedia schema:about ?item ;
               schema:isPartOf <https://en.wikipedia.org/> .
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY DESC(?sitelinks)
LIMIT 100`.trim();

  try {
    const res = await fetch(
      `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`,
      {
        headers: {
          Accept: "application/sparql-results+json",
          "User-Agent": "GraveLens/1.0 (genealogy research app)",
        },
        signal: signal ? AbortSignal.any([AbortSignal.timeout(12000), signal]) : AbortSignal.timeout(12000),
      }
    );

    if (!res.ok) return [];

    const data = await res.json();
    const bindings: Array<Record<string, { value: string }>> =
      data?.results?.bindings ?? [];

    return bindings
      .map((b) => {
        const id = b.item?.value?.split("/").pop() ?? "";
        const label = b.itemLabel?.value ?? "";
        const coordsRaw = b.coords?.value ?? ""; // e.g. "Point(-73.9 40.7)"
        const wikipediaUrl = b.wikipedia?.value;

        // Parse coords
        const match = coordsRaw.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
        if (!match) return null;
        const lng = parseFloat(match[1]);
        const lat = parseFloat(match[2]);

        const occupationId = b.occupation?.value?.split("/").pop() ?? "";
        const occupationLabel = b.occupationLabel?.value;
        const category = occupationId ? (OCCUPATION_MAP[occupationId] ?? "other") : "other";

        return {
          id,
          label,
          lat,
          lng,
          occupationId,
          occupationLabel,
          wikipediaUrl,
          category,
        } as NotableFigure;
      })
      .filter((n): n is NotableFigure => n !== null);
  } catch (err) {
    // Propagate caller-initiated cancellation; degrade other failures to empty.
    if ((err as Error)?.name === "AbortError") throw err;
    console.warn("Wikidata notable figures fetch failed:", err);
    return [];
  }
}

// ── Notable people born in the same year ─────────────────────────────────────

export async function getBirthYearNotables(
  year: number
): Promise<Array<{ name: string; description?: string; wikipediaUrl?: string }>> {
  const safeYear = safeNum(year);
  if (safeYear === null || safeYear < 1400 || safeYear > new Date().getFullYear()) return [];

  const query = `
SELECT DISTINCT ?person ?personLabel ?desc ?wikipedia WHERE {
  ?person wdt:P569 ?dob .
  FILTER(YEAR(?dob) = ${safeYear})
  ?person wdt:P31 wd:Q5 .
  ?person wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks >= 8)
  OPTIONAL { ?person schema:description ?desc FILTER(LANG(?desc) = "en") }
  OPTIONAL {
    ?wikipedia schema:about ?person ;
               schema:isPartOf <https://en.wikipedia.org/> .
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
ORDER BY DESC(?sitelinks)
LIMIT 6`.trim();

  try {
    const res = await fetch(
      `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`,
      {
        headers: {
          Accept: "application/sparql-results+json",
          "User-Agent": "GraveLens/1.0 (genealogy research app)",
        },
        signal: AbortSignal.timeout(6000),
      }
    );
    if (!res.ok) return [];

    const data = await res.json();
    const bindings: Array<Record<string, { value: string }>> =
      data?.results?.bindings ?? [];

    type Notable = { name: string; description?: string; wikipediaUrl?: string };
    return bindings
      .map((b): Notable | null => {
        const name = b.personLabel?.value ?? "";
        const wikidataId = b.person?.value?.split("/").pop() ?? "";
        if (!name || name === wikidataId || /^Q\d+$/.test(name)) return null;
        return {
          name,
          description: b.desc?.value,
          wikipediaUrl: b.wikipedia?.value,
        };
      })
      .filter((n): n is Notable => n !== null);
  } catch {
    return [];
  }
}
