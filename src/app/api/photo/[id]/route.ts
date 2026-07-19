import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { getServiceClient } from "@/lib/supabase/service";

const BUCKET = "grave-photos";

/**
 * Authenticated photo proxy for the now-PRIVATE grave-photos bucket.
 *
 * Access is enforced server-side (the rule cannot be bypassed by hitting a CDN
 * URL directly): a viewer may see a grave's photo if they are the owner, OR the
 * grave is public, OR they are a confirmed friend of the owner. Bytes are read
 * via the service role and streamed back so the service worker can cache them
 * for offline display.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const { id: graveId } = await ctx.params;
  if (!graveId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const supabase = getServiceClient();
  if (!supabase) return NextResponse.json({ error: "Storage unavailable" }, { status: 503 });

  // Look up the grave to determine ownership / visibility.
  const { data: grave } = await supabase
    .from("gravelens_scans")
    .select("user_id, is_public")
    .eq("id", graveId)
    .maybeSingle();

  if (!grave) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const ownerId = (grave as { user_id: string }).user_id;
  const isPublic = (grave as { is_public?: boolean }).is_public === true;

  let allowed = ownerId === auth.userId || isPublic;

  // Confirmed-friend check (only if not already allowed).
  if (!allowed) {
    const { data: rel } = await supabase
      .from("gravelens_user_relationships")
      .select("id")
      .eq("type", "friend")
      .or(
        `and(from_user_id.eq.${auth.userId},to_user_id.eq.${ownerId}),` +
          `and(from_user_id.eq.${ownerId},to_user_id.eq.${auth.userId})`
      )
      .maybeSingle();
    allowed = !!rel;
  }

  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Photos are stored at {ownerId}/{graveId}.jpg.
  const path = `${ownerId}/${graveId}.jpg`;
  const { data: blob, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !blob) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return new NextResponse(blob, {
    headers: {
      "Content-Type": blob.type || "image/jpeg",
      // Private to the authenticated viewer; the service worker caches a copy
      // for offline use. Edits overwrite the same path, so keep this short.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
