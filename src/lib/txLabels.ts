/**
 * Human-readable labels for token_transactions rows, shared by the Rewards card
 * and the Transaction History page so both read the same.
 *
 * Labels favor plain customer language over internal terms ("Monthly tokens"
 * not "allocation", "Reward" not "bonus"). `txDescription` also defends against
 * legacy machine descriptions (`goal:<slug>`, `referral:<slug>:<name>`) that
 * leaked into the ledger before the write-time fix + backfill.
 */

export const TX_TYPE_LABELS: Record<string, string> = {
  top_up: "Top-up",
  debit: "Usage",
  allocation: "Monthly tokens",
  rollover: "Rollover",
  bonus: "Reward",
  gift: "Gift",
  refund: "Refund",
  adjustment: "Adjustment",
};

/** Short category name for a transaction type. */
export function txTypeLabel(type: string): string {
  return TX_TYPE_LABELS[type] ?? type.replace(/_/g, " ");
}

const prettifySlug = (slug: string): string => {
  const s = slug.replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Reward";
};

/**
 * Primary display label for a ledger row. Uses the stored description, but
 * rewrites legacy machine descriptions to something human, and falls back to the
 * type label when there's no description.
 */
export function txDescription(tx: { type: string; description: string | null }): string {
  const d = tx.description?.trim();
  if (!d) return txTypeLabel(tx.type);
  if (d.startsWith("goal:")) return prettifySlug(d.slice(5));
  if (d.startsWith("referral:")) {
    const name = d.split(":")[2]?.trim();
    return name ? `Referred ${name}` : "Referral reward";
  }
  return d;
}
