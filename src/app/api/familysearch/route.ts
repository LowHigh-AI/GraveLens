import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { requireRateLimit } from "@/lib/rateLimit";
import { searchFamilySearchHints } from "@/lib/apis/familysearch";

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const rl = await requireRateLimit(auth.userId, "genealogy");
  if (rl) return rl;

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.lastName !== "string" || !body.lastName.trim()) {
      return NextResponse.json({ error: "Invalid or missing 'lastName' input" }, { status: 400 });
    }
    const { firstName, lastName, birthYear, deathYear } = body;
    const result = await searchFamilySearchHints(
      typeof firstName === "string" ? firstName : "",
      lastName,
      typeof birthYear === "number" ? birthYear : null,
      typeof deathYear === "number" ? deathYear : null
    );
    return NextResponse.json({
      familySearchHints: result.records,
      sourceStatus: { familySearchHints: { status: result.status, fallbackUrl: result.fallbackUrl } },
    });
  } catch (error) {
    console.error("[FamilySearch route] Search failed:", error);
    return NextResponse.json({ familySearchHints: [], error: "Internal search error" }, { status: 500 });
  }
}
