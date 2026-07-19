/**
 * Small shared formatting helpers.
 *
 * `fmtDate` was duplicated across billing surfaces (rewards, transaction
 * history) — lifted here so those pages share one implementation.
 */

/** Format an ISO timestamp for compact display (e.g. "Jul 5, 2026"). */
export const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};
