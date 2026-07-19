-- ============================================================================
-- One-off backfill: regroup historical GraveLens usage rows by USER ACTION
-- ============================================================================
--
-- WHY
--   The token-usage estimator groups api_usage_log rows by (app, tool, component)
--   and sums lowhigh_tokens per prompt_id within each group. One GraveLens user
--   action historically fanned out into several backend routes, each logged under
--   its own tool/component and its own random prompt_id, so a single action showed
--   up as several separate estimator rows:
--
--     "Scan a marker"     = /api/analyze (Analyze Marker)
--                         + /api/cultural summary auto-loaded on the result page
--     "Hear their story"  = /api/story (Generate Story)
--                         + /api/tts   (Read Aloud)
--
--   Going forward the frontend tags every call in an action with one shared
--   promptId + a single tool/component, so the RPC sums them into one row. This
--   script does the same for OLD rows by (a) time-clustering each user's rows into
--   action instances, (b) giving each cluster a shared synthetic prompt_id, and
--   (c) relabeling tool/component.
--
-- WHAT IT DOES NOT TOUCH
--   * lowhigh_tokens is never changed  -> balances / monthly usage totals are safe.
--   * No rows are deleted.
--   * /api/cultural "Expand Category" rows (manual "explore a topic") are left as is.
--
-- HOW TO RUN
--   Paste into the Supabase SQL editor and run ONE STEP AT A TIME, reading the
--   output between steps. The backup table (Step 1) is your undo. This file is
--   documentation of a manual, one-off operation — it is NOT an idempotent
--   migration and should not be re-run blindly.
--
-- ACCURACY CAVEAT
--   Historical rows have no shared key linking an action's steps, so we infer them
--   from time proximity. The STORY pass is reliable (story -> tts fire seconds
--   apart). The SCAN pass is fuzzier (analyze at capture vs the cultural summary on
--   the result view are ~30-60s apart); rapid multi-scanning can merge two scans or
--   split one. Inspect the Step 3 dry-runs. If the scan clusters look noisy, skip
--   Step 4a and let scan history age out of the RPC's recent-sample window while
--   still applying the reliable story pass (Step 4b).
--
--   Tunable windows: SCAN_GAP = 45 seconds, STORY_GAP = 2 minutes. Larger gaps
--   merge more (over-count cost -> fewer uses shown = conservative); smaller gaps
--   split more (under-count cost -> too many uses). Keep the same value in the
--   matching dry-run and UPDATE.
--
-- PRECONDITION
--   Assumes the primary key column is `id`. Verify first:
--     select column_name, data_type from information_schema.columns
--     where table_name = 'api_usage_log' order by ordinal_position;
--   If the PK is not `id`, swap it everywhere below. (prompt_id is a uuid column,
--   which is why the synthetic ids use md5(...)::uuid.)
-- ============================================================================


-- ── Step 0 — BEFORE snapshot (what the estimator currently shows) ───────────
select tool, component, total_prompts, avg_lowhigh_tokens_per_prompt
from usage_by_app_component_filtered('{}'::jsonb)
where app_slug = 'gravelens'
order by tool, component;
-- Expect the split rows: Scan/Analyze Marker, Cultural/Cultural Summary,
-- Story/Generate Story, Audio/Read Aloud (+ Cultural/Expand Category, untouched).


-- ── Step 1 — BACKUP every row this script may modify (your undo) ────────────
create table api_usage_log_grouping_backup as
select * from api_usage_log
where app_slug = 'gravelens'
  and user_id is not null
  and (
        endpoint in ('/api/analyze', '/api/story', '/api/tts')
     or (endpoint = '/api/cultural' and component = 'Cultural Summary')
  );
-- Sanity: how many rows are we about to touch?
select count(*) as rows_backed_up from api_usage_log_grouping_backup;


-- ── Step 2 — helper predicate reference (no-op; documents the row sets) ─────
--   SCAN rows :  endpoint = '/api/analyze'
--             OR (endpoint = '/api/cultural' and component = 'Cultural Summary')
--   STORY rows:  endpoint in ('/api/story', '/api/tts')


-- ── Step 3a — DRY RUN: preview SCAN clusters (change nothing) ───────────────
with scan_rows as (
  select id, user_id, created_at, endpoint, component, lowhigh_tokens
  from api_usage_log
  where app_slug = 'gravelens' and user_id is not null
    and (endpoint = '/api/analyze'
         or (endpoint = '/api/cultural' and component = 'Cultural Summary'))
),
steps as (
  select *,
    lag(created_at) over (partition by user_id order by created_at, id) as prev_at
  from scan_rows
),
marked as (
  select *,
    case when prev_at is null or created_at - prev_at > interval '45 seconds'
         then 1 else 0 end as new_cluster
  from steps
),
clustered as (
  select *, sum(new_cluster) over (partition by user_id order by created_at, id) as cluster_no
  from marked
)
select md5(user_id::text || ':scan:' || cluster_no)::uuid as new_prompt_id,
       count(*)            as calls_in_action,
       sum(lowhigh_tokens) as action_tokens,
       min(created_at)     as started
from clustered
group by 1, user_id, cluster_no
order by started desc
limit 50;
-- Sanity: calls_in_action mostly 1-2; action_tokens ~ one scan's cost.
-- Big clusters (5+) => shrink '45 seconds', or skip Step 4a.


-- ── Step 3b — DRY RUN: preview STORY clusters (change nothing) ──────────────
with story_rows as (
  select id, user_id, created_at, lowhigh_tokens
  from api_usage_log
  where app_slug = 'gravelens' and user_id is not null
    and endpoint in ('/api/story', '/api/tts')
),
steps as (
  select *,
    lag(created_at) over (partition by user_id order by created_at, id) as prev_at
  from story_rows
),
marked as (
  select *,
    case when prev_at is null or created_at - prev_at > interval '2 minutes'
         then 1 else 0 end as new_cluster
  from steps
),
clustered as (
  select *, sum(new_cluster) over (partition by user_id order by created_at, id) as cluster_no
  from marked
)
select md5(user_id::text || ':story:' || cluster_no)::uuid as new_prompt_id,
       count(*)            as calls_in_action,
       sum(lowhigh_tokens) as action_tokens,
       min(created_at)     as started
from clustered
group by 1, user_id, cluster_no
order by started desc
limit 50;
-- Sanity: calls_in_action mostly 1-2 (story + its tts, or a lone tts).


-- ── Step 4a — APPLY the SCAN pass (analyze + cultural summary) ──────────────
--   Keep the SAME window as Step 3a. Skip this step if the scan dry-run was noisy.
with scan_rows as (
  select id, user_id, created_at
  from api_usage_log
  where app_slug = 'gravelens' and user_id is not null
    and (endpoint = '/api/analyze'
         or (endpoint = '/api/cultural' and component = 'Cultural Summary'))
),
steps as (
  select id, user_id, created_at,
    lag(created_at) over (partition by user_id order by created_at, id) as prev_at
  from scan_rows
),
marked as (
  select id, user_id, created_at,
    case when prev_at is null or created_at - prev_at > interval '45 seconds'
         then 1 else 0 end as new_cluster
  from steps
),
clustered as (
  select id, user_id,
    sum(new_cluster) over (partition by user_id order by created_at, id) as cluster_no
  from marked
)
update api_usage_log u
set prompt_id = md5(c.user_id::text || ':scan:' || c.cluster_no)::uuid,
    tool      = 'Scan',
    component = 'Scan a marker'
from clustered c
where u.id = c.id;


-- ── Step 4b — APPLY the STORY pass (story + tts) ────────────────────────────
--   Keep the SAME window as Step 3b.
with story_rows as (
  select id, user_id, created_at
  from api_usage_log
  where app_slug = 'gravelens' and user_id is not null
    and endpoint in ('/api/story', '/api/tts')
),
steps as (
  select id, user_id, created_at,
    lag(created_at) over (partition by user_id order by created_at, id) as prev_at
  from story_rows
),
marked as (
  select id, user_id, created_at,
    case when prev_at is null or created_at - prev_at > interval '2 minutes'
         then 1 else 0 end as new_cluster
  from steps
),
clustered as (
  select id, user_id,
    sum(new_cluster) over (partition by user_id order by created_at, id) as cluster_no
  from marked
)
update api_usage_log u
set prompt_id = md5(c.user_id::text || ':story:' || c.cluster_no)::uuid,
    tool      = 'Story',
    component = 'Hear their story'
from clustered c
where u.id = c.id;


-- ── Step 5 — AFTER snapshot (compare against Step 0) ────────────────────────
select tool, component, total_prompts, avg_lowhigh_tokens_per_prompt
from usage_by_app_component_filtered('{}'::jsonb)
where app_slug = 'gravelens'
order by tool, component;
-- Expect: Scan/"Scan a marker" and Story/"Hear their story" as single rows;
-- Analyze Marker / Cultural Summary / Generate Story / Read Aloud gone.
-- Cultural/Expand Category still present (intentionally untouched).


-- ── Step 6 — RESTORE (only if something looks wrong) ────────────────────────
-- update api_usage_log u
-- set prompt_id = b.prompt_id, tool = b.tool, component = b.component
-- from api_usage_log_grouping_backup b
-- where u.id = b.id;


-- ── Step 7 — CLEANUP (once you're happy) ────────────────────────────────────
-- drop table api_usage_log_grouping_backup;
