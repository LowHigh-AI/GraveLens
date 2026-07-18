# GraveLens — Branch Reconciliation Plan (v1.0.0 backend ⟷ research features)

**Situation (2026-07-18):** Two branches diverged from common ancestor `5f13ae5`.
- **Our branch** (local `62707b8`, backed up to tag `backup/local-work-pre-merge-20260718` + branch `backup-local-work`): ~30 commits of research features — WikiTree inline source, /research page, family-plot connections, `burial_index` pooled DB, extraction validation, audit fixes F1–F10, global-error boundary, review-lifecycle fix, archive edit sheet, family grouping, vitest + CI.
- **Their branch** (`origin/main` = `c5a77f5`, by Robert Luebbert w/ Opus 4.8): 2 commits = a large v1.0.0 (billing/Stripe, LowHigh ecosystem SSO, rewards/goals) + a **full Supabase rename** (`gravelens_` prefix, `db/migrations/` folder, hardened cache). Built from the old base — has **none** of our work. Force-pushed over our work on the remote (recoverable from local/backup).

**User decisions (locked):** merge preserving both · adopt their `gravelens_` schema + naming as authoritative and rewire our code · re-issue `burial_index` in their convention · pull in their new skills/MD files · **surface feature duplications for per-case choice** · plan + structural merge on a NEW branch first, review before pushing to main.

---

## Naming convention (theirs = authoritative)
Every table is `gravelens_`-prefixed. Full inventory in `db/schema/gravelens_reference_schema.sql`. Migrations live in `db/migrations/*.sql` (no more root `supabase-schema.sql` — they deleted it).

| Old (our code) | New (their schema) |
|---|---|
| `graves` | `gravelens_graves` |
| `user_profiles` | `gravelens_user_profiles` |
| `user_relationships` | `gravelens_user_relationships` |
| `local_history_cache` | `gravelens_local_history_cache` |
| `cemetery_cache` | `gravelens_cemetery_cache` |
| `military_context_cache` | `gravelens_military_context_cache` |
| `grave_identity_index` | `gravelens_grave_identity_index` |
| `upsert_grave_identity` (rpc) | `gravelens_upsert_grave_identity` (rpc) |
| `rate_limits` | `gravelens_rate_limits` (via their `rateLimit.ts`) |
| `burial_index` *(ours only)* | **`gravelens_burial_index`** — re-issue as new migration |
| `upsert_burial_index` (rpc) | **`gravelens_upsert_burial_index`** — re-issue |

**Our files referencing old names (rewire targets):** `src/lib/community.ts` (graves×7, user_profiles×7, relationships×3, caches, identity index, burial_index), `src/lib/cloudSync.ts` (graves), `src/app/api/analyze/route.ts` (rate_limits → adopt their limiter).

---

## Feature-overlap: duplications to decide (⚠ = needs Ben's choice)

| # | Area | Ours | Theirs | Recommendation |
|---|---|---|---|---|
| D1 | **Rate limiting** | inline `checkRateLimit` in analyze route, `rate_limits` table | `rateLimit.ts` `requireRateLimit()`, bucketed `RATE_LIMITS`, `gravelens_rate_limits` table | **Theirs** (required — our table won't exist; theirs is centralized/bucketed). ⚠ confirm |
| D2 | **Research-response cache** | `grave_identity_index` + `upsert_grave_identity` in community.ts | hardened `gravelens_grave_identity_index` + `gravelens_upsert_grave_identity` | **Theirs** (already decided). Rewire our `checkResearchCache`/`saveResearchCache`. |
| D3 | **AI content cache (story/cultural/narrative)** | cached into the grave record client-side | `researchCache.ts` → `gravelens_ai_content_cache`, server-side in story/cultural/narrative routes | **Theirs** (server-side, cleaner). Our record-level caching can stay harmlessly. ⚠ confirm |
| D4 | **global-error boundary** | our `global-error.tsx` (a5a…/e6945db) | their `global-error.tsx` in v1.0.0 | Diff during merge; keep the better one (likely theirs, matches v1.0.0 shell). ⚠ light |

**Not duplications (both coexist, pure adds from us — re-applied via merge, then backend-rewired):** WikiTree source, /research page, `burial_index` + family-plot, extraction validation, audit fixes F1–F10, archive edit sheet, family grouping, review-lifecycle fix. **Their pure adds (kept as-is):** billing/Stripe, ecosystem/SSO, rewards/goals, `ai_content_cache`, security-hardening migrations, new pages (billing/plan/rewards/topup/sitemap/robots).

---

## Conflict set (23 files both branches changed)
`next.config.ts`, `package.json`, `package-lock.json`, api routes (`analyze`, `cultural`, `familysearch`, `lookup`, `narrative`, `newspapers`, `ssdi`, `story`), `global-error.tsx`, `sw-register.tsx`, `AchievementsPage.tsx`, `ArchiveMap.tsx`, `ArchivePage.tsx`, `ProfileBadge.tsx`, `CapturePage.tsx`, `ResultPage.tsx`, `cloudSync.ts`, `community.ts`, `queue.ts`, `supabase-schema.sql` (they deleted → accept deletion).

**Resolution intent per cluster:**
- **Backend libs (`community.ts`, `cloudSync.ts`):** take BOTH sets of functions; rewire all table names to `gravelens_`; keep our burial_index/family-plot/research-cache functions pointed at renamed tables + new `gravelens_burial_index`.
- **`lookup/route.ts`:** take their skeleton (`after`, `requireRateLimit`, gravelens cache imports) + re-add our WikiTree source, burial harvest, extraction-validation escalation, family additions.
- **AI routes (`cultural`, `story`, `narrative`):** take theirs (they add `ai_content_cache`) + our JSON-salvage/`cache_control` hardening if not already present.
- **`analyze/route.ts`:** take their auth/rate-limit + our extraction validation + escalation.
- **`ResultPage.tsx`:** our slimmed research + ResearchSummaryCard structure, reconciled with their ecosystem/billing hooks.
- **`CapturePage.tsx`:** their ecosystem-shell rewrite + our "Research a name" link.
- **`ArchivePage.tsx`:** our edit sheet + family grouping + research chip, reconciled with their nav/settings changes.
- **`supabase-schema.sql`:** accept their deletion; our schema content is superseded by `db/migrations/` + a new `gravelens_burial_index` migration we author.
- **lockfile/package.json:** take theirs (v1.0.0 deps) + our devDeps (vitest) — regenerate lockfile.

---

## Execution (safe, resumable)
1. ✅ Backups: tag `backup/local-work-pre-merge-20260718`, branch `backup-local-work`.
2. Integration branch `integration/v1-reconcile` off our HEAD; `git merge origin/main --no-commit` to enumerate real conflicts (brings their new files in cleanly).
3. Confirm duplication choices D1/D3/D4 with Ben.
4. Resolve conflicts cluster-by-cluster; `tsc`/`build`/`vitest` green after each cluster; commit per cluster.
5. Author `db/migrations/gravelens_burial_index.sql` (table + `gravelens_upsert_burial_index` + `gravelens_search_*` as needed) in their style; apply via Supabase MCP.
6. Full verification (signed-in): research page, family-plot, billing untouched, no old table refs remain (`git grep` for un-prefixed names).
7. Review with Ben → then merge `integration/v1-reconcile` → `main` and push. **Nothing touches `main` until step 7.**

---

## ⚠ CORRECTED TOPOLOGY (2026-07-18) — Robert already migrated GraveLens to the shared LowHigh backend

Investigation of the two Supabase projects changed the picture fundamentally:

- **`byyrudwvdquebvfhxnnh` ("GraveLens")** = the OLD standalone DB. Old un-prefixed names, all data intact: `graves` (259), `grave_identity_index` (22), `burial_index` (23), `grave-photos` storage (265 objects / 162 MB). **The current app (.env.local) still points here.**
- **`eqizlmdknjppefzpdogg` ("LowHigh.ai")** = the SHARED multi-app production backend (also hosts SpinVinyl `antisocial_*`/`sv_*`, LowHigh marketing/email/blog/prompts, shared billing/tokens/rewards, teams). **Robert has ALREADY migrated GraveLens into it:** `gravelens_scans` (256), `gravelens_user_profiles` (6), `gravelens_scan_identity_index`, `gravelens_ai_content_cache`, `gravelens_rate_limits`, caches, + `grave-photos` storage (261 objects / 163 MB). His v1.0.0 code targets THIS project (via `NEXT_PUBLIC_SUPABASE_URL`).

**Implications:**
1. We are NOT migrating 259 graves — Robert did. Switching GraveLens to the shared backend is an **env-var change**, not a data migration.
2. **Canonical live names** (rewire our code to THESE, from the actual shared DB — NOT the reference schema which has stale `gravelens_graves`):
   - `graves` → **`gravelens_scans`**
   - `grave_identity_index` → **`gravelens_scan_identity_index`**  ·  `upsert_grave_identity` → **`gravelens_upsert_scan_identity`**
   - `user_profiles`→`gravelens_user_profiles` · `user_relationships`→`gravelens_user_relationships` · `local_history_cache`→`gravelens_local_history_cache` · `cemetery_cache`→`gravelens_cemetery_cache` · `military_context_cache`→`gravelens_military_context_cache` · `rate_limits`→ their `rateLimit.ts` (`gravelens_rate_limits`)
   - `burial_index` → **`gravelens_burial_index`** (does NOT exist in shared — must be created) · `upsert_burial_index` → `gravelens_upsert_scan_burial_index` (TBD name)
3. **Constraint (Ben):** the shared project is Robert's production DB for MULTIPLE live apps. Any DDL there must be **strictly GraveLens-namespaced, additive, and must not touch shared/other-app tables.** Get explicit approval before any DDL on `eqizlmdknjppefzpdogg`.

**Data-safety status:** Nothing is currently lost. Data + images exist in BOTH projects. Small deltas to reconcile later: scans 259(old) vs 256(shared); images 265 vs 261.

## Backup recommendation (satisfies Ben's "no action without recoverable backup")
1. **Leave the old project (`byyrudwvdquebvfhxnnh`) fully intact** — it is a complete, live, recoverable snapshot (all graves + images + burial_index). Do not decommission until the shared migration is verified complete.
2. **Confirm Supabase automatic backups / PITR** are enabled on both projects.
3. **Export `graves` (259 rows) → JSON file** committed to a private backup location — a re-runnable manifest (photo paths + already-extracted data), so archives can be rebuilt WITHOUT re-running vision.
4. **Optional cold backup:** download the `grave-photos` bucket (162 MB) to off-Supabase storage.
5. Only after (1)-(3): proceed to add `gravelens_burial_index` to the shared project (GraveLens-namespaced, additive) — with explicit approval.

## Revised execution (supersedes earlier DB steps)
1. ✅ Backups: git tag/branch of code. 2. ✅ Structural merge parked on `integration/v1-reconcile` (14 conflicts). 3. **Rewire our code to the CANONICAL shared names** (scans / scan_identity_index / …). 4. Resolve the 14 conflicts (their backend/billing/ecosystem + our features). 5. Data backup steps above. 6. Add `gravelens_burial_index` to shared (approval-gated). 7. Point `.env.local` at shared project (test), verify features against real shared data. 8. Review → merge to main.

## Status log
- 2026-07-18: Analysis + safe structural merge done (14 conflicts parked on integration branch). CORRECTED TOPOLOGY discovered: Robert already migrated GraveLens to shared LowHigh backend (eqizlmdknjppefzpdogg). No 259-graves migration needed by us; canonical names are gravelens_scans / gravelens_scan_identity_index. Next: backup steps, then rewire code to canonical names + resolve conflicts. NO DDL on shared project without approval.

---

## ✅ SHARED-DB MIGRATION APPLIED (2026-07-18)
`gravelens_burial_index` created + backfilled on the shared LowHigh project (`eqizlmdknjppefzpdogg`):
- Table + 3 indexes + `auth read` RLS policy + `gravelens_upsert_burial_index` (security-definer, auth-guarded, anon revoked) — matches Robert's conventions exactly.
- **23 rows backfilled** from the old project's `burial_index` (scan_count history preserved).
- Verified: gravelens_scans still 256, 176 total tables — no other app's table touched. Advisor: only the standard SECURITY-DEFINER notice shared by all 43 gravelens_ functions (mine hardened identically).
- Migration file: `db/migrations/gravelens_burial_index.sql`.

## CODE MERGE PLAYBOOK (task 24 — the remaining work)
Re-run `git merge origin/main --no-commit` on `integration/v1-reconcile`, then resolve 14 files. Strategy: **take THEIRS as base + re-apply OUR feature additions**, rewiring to CANONICAL LIVE names.

**Canonical names (from the LIVE shared DB — NOT the reference schema):**
- table `graves` → `gravelens_scans` · `grave_identity_index` → `gravelens_scan_identity_index` · rpc `upsert_grave_identity` → `gravelens_upsert_scan_identity`
- `user_profiles`/`user_relationships`/`local_history_cache`/`cemetery_cache`/`military_context_cache` → `gravelens_`-prefixed
- our `burial_index` → `gravelens_burial_index` · `upsert_burial_index` → `gravelens_upsert_burial_index` (now live)
- **COLUMN renames too:** profile `grave_count`→`scan_count`, `public_grave_count`→`public_scan_count` (their community.ts already does this — adopt it)
- rate limiting: drop our inline `checkRateLimit`; use their `requireRateLimit` (`gravelens_rate_limits`)

**Per-file resolution:**
- `community.ts`: take THEIRS (has gravelens_ names + column renames for profiles/relationships/caches/scans) + ADD our functions: `searchBurialIndexPeople`, `fetchBurialIndexRelatives`, `computePersonIdentityKey`, `checkResearchCache`/`saveResearchCache` (→ `gravelens_scan_identity_index` / `gravelens_upsert_scan_identity`), `upsertBurialIndex` (→ `gravelens_upsert_burial_index`), `BurialIndexRelative`/`BurialIndexPerson` types.
- `cloudSync.ts`: take THEIRS (photoProxyUrl, gravelens_scans) + our SVG-placeholder passthrough in uploadPhoto.
- `lookup/route.ts`: THEIRS skeleton (`after`, `requireRateLimit`, gravelens cache) + re-add our WikiTree source, burial harvest, extraction-validation escalation, family additions.
- `analyze/route.ts`: THEIRS auth/rate-limit + our extraction validation + escalation triggers.
- `cultural`/`narrative`/`story` routes: THEIRS (adds gravelens_ai_content_cache) + our JSON-salvage/cache_control if missing.
- `ResultPage.tsx`: OURS (slimmed + ResearchSummaryCard + research/cards import) reconciled with their ecosystem/billing hooks. Biggest file — care.
- `CapturePage.tsx`: THEIRS (ecosystem shell, auth-gate, wakeLock) + our "Research a name" link + quality-warning flow.
- `ArchiveMap.tsx`: reconcile our pins/family work with theirs.
- `global-error.tsx`: keep ONE (prefer theirs if it matches the v1.0.0 shell).
- `sw-register.tsx`: our dev-unregister + their version bits.
- `next.config.ts` / `package.json`: take theirs (v1.0.0) + our vitest devDeps; regenerate lockfile with npm 11.
- `supabase-schema.sql`: accept THEIR deletion (superseded by db/migrations/).

After merge: `git grep -nE '\.(from|rpc)\("(graves|grave_identity_index|user_profiles|burial_index|rate_limits|upsert_grave_identity|upsert_burial_index)"'` must return NOTHING (all rewired). Then tsc/lint/vitest/build green. Point `.env.local` at shared project to verify features against real data. Review → merge to main.
