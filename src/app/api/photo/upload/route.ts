import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { getServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const BUCKET = "grave-photos";
// Photos are resized client-side to well under 1 MB; this is a sanity ceiling.
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * POST /api/photo/upload — body { graveId, dataUrl }.
 *
 * Writes a grave photo to the PRIVATE grave-photos bucket using the service role
 * (which bypasses Storage RLS), so the browser never needs a client-side write
 * policy on the bucket. This is the write counterpart to the read proxy in
 * /api/photo/[id] — both use the service role, keeping photo access entirely
 * server-enforced.
 *
 * Security: the object path is derived from the SERVER-verified user id, never
 * from anything the client sends, so a caller can only ever write under their own
 * {userId}/ folder. Returns { path } = "{userId}/{graveId}.jpg".
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const graveId = typeof body?.graveId === "string" ? body.graveId.trim() : "";
  const dataUrl = typeof body?.dataUrl === "string" ? body.dataUrl : "";

  if (!graveId) {
    return NextResponse.json({ error: "graveId is required" }, { status: 400 });
  }
  if (!dataUrl.startsWith("data:")) {
    return NextResponse.json({ error: "dataUrl must be a data: URL" }, { status: 400 });
  }

  const base64 = dataUrl.split(",")[1];
  if (!base64) {
    return NextResponse.json({ error: "Invalid data URL" }, { status: 400 });
  }

  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: "Photo is empty or too large" }, { status: 400 });
  }

  const supabase = getServiceClient();
  if (!supabase) {
    return NextResponse.json({ error: "Storage unavailable" }, { status: 503 });
  }

  // Owner comes from the verified session — the client's claim is irrelevant.
  const path = `${auth.userId}/${graveId}.jpg`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, bytes, { upsert: true, contentType: "image/jpeg" });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }

  return NextResponse.json({ path });
}
