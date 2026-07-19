/**
 * Photo URL helper (client-safe).
 *
 * Grave photos live in a PRIVATE Supabase Storage bucket and are served only
 * through the authenticated proxy at /api/photo/[id], which enforces
 * owner / is_public / friend access server-side. Anything that renders a synced
 * grave photo should point at this proxy URL rather than a storage/CDN URL.
 *
 * Unsynced, locally-captured photos keep their inline `data:` URL until upload.
 */
export function photoProxyUrl(graveId: string): string {
  return `/api/photo/${encodeURIComponent(graveId)}`;
}
