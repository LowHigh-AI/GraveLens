#!/usr/bin/env node
/**
 * GraveLens → LowHigh data migration (app tables + storage).
 *
 * Migrates GraveLens app data and photos from the OLD GraveLens Supabase project
 * into LowHigh's project (the gravelens_* tables created by
 * gravelens_01_consolidation.sql). Idempotent and re-runnable.
 *
 * ⚠️ AUTH USERS ARE NOT MIGRATED HERE. Copying auth.users while PRESERVING each
 *    user's UUID + bcrypt password hash requires a direct Postgres dump/restore
 *    of the `auth.users` (+ `auth.identities`) rows — see the runbook section
 *    "Auth user import". Run that FIRST so the NEW project already contains the
 *    users; this script then maps old→new user ids by email and re-points data.
 *
 * For the CLEAN set (email not already in LowHigh) imported with the same UUID,
 * old id === new id, so no re-keying happens. For the MERGE set (email already
 * in LowHigh), this script re-points data onto the existing LowHigh UUID.
 *
 * Usage:
 *   OLD_SUPABASE_URL=...            (GraveLens project)
 *   OLD_SUPABASE_SERVICE_ROLE_KEY=...
 *   NEW_SUPABASE_URL=...            (LowHigh project)
 *   NEW_SUPABASE_SERVICE_ROLE_KEY=...
 *   node scripts/migrate-to-lowhigh.mjs            # dry run (no writes)
 *   node scripts/migrate-to-lowhigh.mjs --apply    # perform the migration
 *
 * Requires @supabase/supabase-js (already a GraveLens dependency).
 */

import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const BUCKET = "grave-photos";

const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing env ${k}`);
    process.exit(1);
  }
  return v;
};

const oldDb = createClient(need("OLD_SUPABASE_URL"), need("OLD_SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});
const newDb = createClient(need("NEW_SUPABASE_URL"), need("NEW_SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let writes = 0;

// Live GraveLens tables have drifted from the clean schema (extra columns like
// `email`). The destination gravelens_* tables only have these columns, so we
// strip anything else before upserting to avoid "column not found" errors.
const TARGET_COLS = {
  gravelens_graves: ["id", "user_id", "timestamp", "photo_url", "location", "extracted", "research", "tags", "user_notes", "is_public", "community_note", "synced_at", "created_at"],
  gravelens_user_profiles: ["user_id", "username", "display_name", "show_username", "share_all_by_default", "explorer_xp", "explorer_rank", "achievement_unlocks", "app_stats", "grave_count", "public_grave_count", "joined_at", "updated_at"],
  gravelens_user_relationships: ["id", "from_user_id", "to_user_id", "type", "created_at"],
  gravelens_local_history_cache: ["geo_cell", "local_history", "wikidata_events", "nrhp_sites", "sources", "generated_at", "expires_at"],
  gravelens_cemetery_cache: ["osm_id", "name", "description", "wikipedia_url", "established", "denomination", "notable_features", "historical_events", "generated_at", "expires_at"],
  gravelens_military_context_cache: ["conflict_key", "context", "updated_at"],
  gravelens_grave_identity_index: ["identity_hash", "research_snapshot", "contributor_count", "confirmed_at", "expires_at"],
};
const pick = (row, table) => {
  const cols = TARGET_COLS[table];
  if (!cols) return row;
  const out = {};
  for (const c of cols) if (c in row) out[c] = row[c];
  return out;
};

/** List all auth users (paginated) → array of { id, email }. */
async function listUsers(db) {
  const out = [];
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    out.push(...data.users.map((u) => ({ id: u.id, email: (u.email || "").toLowerCase().trim() })));
    if (data.users.length < 1000) break;
  }
  return out;
}

/** Copy rows from an OLD public table into a NEW gravelens_* table, re-keying user_id. */
async function migrateUserTable({ oldTable, newTable, userCols, remap, idCol = "id" }) {
  const { data: rows, error } = await oldDb.from(oldTable).select("*");
  if (error) throw new Error(`read ${oldTable}: ${error.message}`);
  log(`  ${oldTable}: ${rows.length} rows`);

  let skipped = 0;
  const out = [];
  for (const row of rows) {
    let ok = true;
    for (const col of userCols) {
      const newId = remap.get(row[col]);
      if (!newId) {
        ok = false;
        break;
      }
      row[col] = newId;
    }
    if (!ok) {
      skipped++;
      continue;
    }
    out.push(pick(row, newTable));
  }
  if (skipped) log(`    skipped ${skipped} rows (user not migrated)`);

  if (!APPLY) {
    log(`    [dry-run] would upsert ${out.length} rows into ${newTable}`);
    return;
  }
  // Upsert in chunks.
  for (let i = 0; i < out.length; i += 500) {
    const chunk = out.slice(i, i + 500);
    const { error: upErr } = await newDb.from(newTable).upsert(chunk, { onConflict: idCol });
    if (upErr) throw new Error(`write ${newTable}: ${upErr.message}`);
    writes += chunk.length;
  }
  log(`    upserted ${out.length} rows into ${newTable}`);
}

/** Copy a shared (user-agnostic) cache table verbatim. */
async function migrateSharedTable({ oldTable, newTable, idCol }) {
  const { data: rows, error } = await oldDb.from(oldTable).select("*");
  if (error) throw new Error(`read ${oldTable}: ${error.message}`);
  log(`  ${oldTable}: ${rows.length} rows`);
  if (!APPLY) {
    log(`    [dry-run] would upsert ${rows.length} rows into ${newTable}`);
    return;
  }
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => pick(r, newTable));
    const { error: upErr } = await newDb.from(newTable).upsert(chunk, { onConflict: idCol });
    if (upErr) throw new Error(`write ${newTable}: ${upErr.message}`);
    writes += chunk.length;
  }
  log(`    upserted ${rows.length} rows into ${newTable}`);
}

/** Copy storage objects, re-keying the {userId}/ path prefix for merged users. */
async function migrateStorage(remap) {
  log("  storage: grave-photos");
  let copied = 0;
  let skipped = 0;
  for (const [oldId, newId] of remap.entries()) {
    const { data: files, error } = await oldDb.storage.from(BUCKET).list(oldId, { limit: 1000 });
    if (error) {
      log(`    list ${oldId}: ${error.message}`);
      continue;
    }
    for (const f of files || []) {
      const oldPath = `${oldId}/${f.name}`;
      const newPath = `${newId}/${f.name}`;
      if (!APPLY) {
        copied++;
        continue;
      }
      let ok = false;
      let lastErr = "";
      for (let attempt = 1; attempt <= 5 && !ok; attempt++) {
        const { data: blob, error: dlErr } = await oldDb.storage.from(BUCKET).download(oldPath);
        if (dlErr) {
          lastErr = `download: ${dlErr.message}`;
          await sleep(400 * attempt);
          continue;
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const { error: upErr } = await newDb.storage
          .from(BUCKET)
          .upload(newPath, bytes, { upsert: true, contentType: blob.type || "image/jpeg" });
        if (upErr) {
          lastErr = `upload: ${upErr.message}`;
          await sleep(400 * attempt);
          continue;
        }
        ok = true;
      }
      if (ok) {
        copied++;
      } else {
        log(`    ${newPath}: ${lastErr} (gave up after 5 tries)`);
        skipped++;
      }
    }
  }
  log(`    ${APPLY ? "copied" : "[dry-run] would copy"} ${copied} objects${skipped ? `, ${skipped} skipped` : ""}`);
}

async function main() {
  log(`GraveLens → LowHigh migration ${APPLY ? "(APPLY)" : "(dry run)"}\n`);

  // Build old→new user-id map by email.
  log("Building user id map…");
  const [oldUsers, newUsers] = await Promise.all([listUsers(oldDb), listUsers(newDb)]);
  const emailToNew = new Map(newUsers.filter((u) => u.email).map((u) => [u.email, u.id]));
  const remap = new Map(); // oldId → newId
  let unmatched = 0;
  for (const u of oldUsers) {
    const newId = u.email && emailToNew.get(u.email);
    if (newId) remap.set(u.id, newId);
    else unmatched++;
  }
  log(`  ${oldUsers.length} old users, ${remap.size} mapped, ${unmatched} unmatched (not yet in LowHigh)\n`);
  if (unmatched > 0) {
    log("  ⚠️ Unmatched users have no LowHigh account yet — run the auth import first");
    log("     (see runbook 'Auth user import'). Their data will be skipped below.\n");
  }

  log("Migrating user-keyed tables…");
  await migrateUserTable({
    oldTable: "graves",
    newTable: "gravelens_graves",
    userCols: ["user_id"],
    remap,
  });
  await migrateUserTable({
    oldTable: "user_profiles",
    newTable: "gravelens_user_profiles",
    userCols: ["user_id"],
    remap,
    idCol: "user_id",
  });
  await migrateUserTable({
    oldTable: "user_relationships",
    newTable: "gravelens_user_relationships",
    userCols: ["from_user_id", "to_user_id"],
    remap,
  });

  log("\nMigrating shared caches…");
  await migrateSharedTable({ oldTable: "local_history_cache", newTable: "gravelens_local_history_cache", idCol: "geo_cell" });
  await migrateSharedTable({ oldTable: "cemetery_cache", newTable: "gravelens_cemetery_cache", idCol: "osm_id" });
  await migrateSharedTable({ oldTable: "military_context_cache", newTable: "gravelens_military_context_cache", idCol: "conflict_key" });
  await migrateSharedTable({ oldTable: "grave_identity_index", newTable: "gravelens_grave_identity_index", idCol: "identity_hash" });

  log("\nMigrating storage…");
  await migrateStorage(remap);

  log(`\nDone. ${APPLY ? `${writes} rows written.` : "Dry run — no writes performed."}`);
  if (!APPLY) log("Re-run with --apply to perform the migration.");
}

main().catch((e) => {
  console.error("\nMigration failed:", e.message);
  process.exit(1);
});
