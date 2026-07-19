import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { requireRateLimit } from "@/lib/rateLimit";
import { searchNaraRecords } from "@/lib/apis/nara";

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const rl = await requireRateLimit(auth.userId, "genealogy");
  if (rl) return rl;

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "Invalid or missing 'name' input" }, { status: 400 });
    }
    const { name, birthYear, deathYear } = body;
    const naraRecords = await searchNaraRecords(
      name,
      typeof birthYear === "number" ? birthYear : null,
      typeof deathYear === "number" ? deathYear : null
    );
    return NextResponse.json({ naraRecords });
  } catch (error) {
    console.error("[NARA route] Search failed:", error);
    return NextResponse.json({ naraRecords: [], error: "Internal search error" }, { status: 500 });
  }
}
