import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { requireRateLimit } from "@/lib/rateLimit";
import { searchNewspapers } from "@/lib/apis/chronicling";

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
    const { name, deathYear, deathDateIso, state } = body;
    const result = await searchNewspapers({
      name,
      deathYear: typeof deathYear === "number" ? deathYear : null,
      deathDateIso: typeof deathDateIso === "string" ? deathDateIso : undefined,
      state: typeof state === "string" ? state : undefined,
    });
    return NextResponse.json({
      newspapers: result.records,
      sourceStatus: { newspapers: { status: result.status, fallbackUrl: result.fallbackUrl } },
    });
  } catch (error) {
    console.error("[Newspapers route] Search failed:", error);
    return NextResponse.json({ newspapers: [], error: "Internal search error" }, { status: 500 });
  }
}
