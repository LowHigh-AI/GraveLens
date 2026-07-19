-- ============================================================
-- GraveLens — Reference Schema (gravelens_* tables, RLS, RPCs)
--
-- ⚠️ SOURCE OF TRUTH CAVEAT
-- The authoritative tables are the `gravelens_*` tables living in the shared
-- LowHigh Supabase project (created by LowHigh's gravelens_01_consolidation.sql
-- migration). This file is RECONSTRUCTED FROM APPLICATION CODE (src/lib/cloudSync.ts,
-- src/lib/community.ts, src/lib/tokenGate.ts, src/lib/rateLimit.ts and the API
-- routes) to give this repo an auditable, version-controlled record of the
-- schema + RLS the app depends on. It replaces the old, drifted
-- `supabase-schema.sql` (which used un-prefixed table names and omitted
-- gravelens_rate_limits).
--
-- Before trusting this file, regenerate it from the live database:
--   supabase db dump --schema public --data-only=false
-- or introspect pg_policies / information_schema and reconcile any differences.
-- ============================================================

-- ── gravelens_graves ─────────────────────────────────────────────
create table if not exists public.gravelens_graves (
  id             text        primary key,
  user_id        uuid        not null references auth.users(id) on delete cascade,
  timestamp      bigint      not null,
  photo_url      text        not null,   -- storage path (NOT a public URL); served via /api/photo
  location       jsonb       not null default '{}',
  extracted      jsonb       not null default '{}',
  research        jsonb      not null default '{}',
  tags           text[]      not null default '{}',
  user_notes     text,
  is_public      boolean     not null default false,
  community_note text,
  synced_at      timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

alter table public.gravelens_graves enable row level security;

create policy "Users read own graves"      on public.gravelens_graves for select using (auth.uid() = user_id);
create policy "Community reads public"      on public.gravelens_graves for select using (is_public = true);
create policy "Users insert own graves"     on public.gravelens_graves for insert with check (auth.uid() = user_id);
create policy "Users update own graves"     on public.gravelens_graves for update using (auth.uid() = user_id);
create policy "Users delete own graves"     on public.gravelens_graves for delete using (auth.uid() = user_id);


-- ── gravelens_user_profiles ──────────────────────────────────────
create table if not exists public.gravelens_user_profiles (
  user_id              uuid        primary key references auth.users(id) on delete cascade,
  username             text        unique,
  display_name         text,
  show_username        boolean     not null default false,  -- L3: opt-in discovery
  share_all_by_default boolean     not null default false,
  explorer_xp          integer     not null default 0,
  explorer_rank        integer     not null default 1,
  achievement_unlocks  jsonb       not null default '[]',
  app_stats            jsonb       not null default '{}',
  grave_count          integer     not null default 0,
  public_grave_count   integer     not null default 0,
  joined_at            timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.gravelens_user_profiles enable row level security;

create policy "Users manage own profile"
  on public.gravelens_user_profiles for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Community reads opted-in profiles"
  on public.gravelens_user_profiles for select
  to authenticated
  using (show_username = true or auth.uid() = user_id);


-- ── gravelens_user_relationships ─────────────────────────────────
create table if not exists public.gravelens_user_relationships (
  id           uuid        primary key default gen_random_uuid(),
  from_user_id uuid        not null references auth.users(id) on delete cascade,
  to_user_id   uuid        not null references auth.users(id) on delete cascade,
  type         text        not null check (type in ('friend_request','friend','blocked')),
  created_at   timestamptz not null default now(),
  unique (from_user_id, to_user_id)
);

alter table public.gravelens_user_relationships enable row level security;

create policy "Users see own relationships"   on public.gravelens_user_relationships for select using (auth.uid() = from_user_id or auth.uid() = to_user_id);
create policy "Users create own relationships" on public.gravelens_user_relationships for insert with check (auth.uid() = from_user_id);
create policy "Users update own relationships" on public.gravelens_user_relationships for update using (auth.uid() = from_user_id or auth.uid() = to_user_id);
create policy "Users delete own relationships" on public.gravelens_user_relationships for delete using (auth.uid() = from_user_id or auth.uid() = to_user_id);


-- ── Shared caches (authenticated read/write; non-sensitive supplemental data) ─
create table if not exists public.gravelens_local_history_cache (
  geo_cell        text        primary key,
  local_history   jsonb,
  wikidata_events jsonb,
  nrhp_sites      jsonb,
  sources         jsonb,
  generated_at    timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '90 days')
);
alter table public.gravelens_local_history_cache enable row level security;
create policy "auth read history cache"   on public.gravelens_local_history_cache for select to authenticated using (true);
create policy "auth insert history cache" on public.gravelens_local_history_cache for insert to authenticated with check (true);
create policy "auth update history cache" on public.gravelens_local_history_cache for update to authenticated using (true);

create table if not exists public.gravelens_cemetery_cache (
  osm_id            text        primary key,
  name              text,
  description       text,
  wikipedia_url     text,
  established       text,
  denomination      text,
  notable_features  text[],
  historical_events text[],
  generated_at      timestamptz not null default now(),
  expires_at        timestamptz not null default (now() + interval '180 days')
);
alter table public.gravelens_cemetery_cache enable row level security;
create policy "auth read cemetery cache"   on public.gravelens_cemetery_cache for select to authenticated using (true);
create policy "auth insert cemetery cache" on public.gravelens_cemetery_cache for insert to authenticated with check (true);
create policy "auth update cemetery cache" on public.gravelens_cemetery_cache for update to authenticated using (true);

create table if not exists public.gravelens_military_context_cache (
  conflict_key text        primary key,
  context      jsonb       not null,
  updated_at   timestamptz not null default now()
);
alter table public.gravelens_military_context_cache enable row level security;
create policy "auth read military cache" on public.gravelens_military_context_cache for select to authenticated using (true);

-- Per-person research snapshot, reused across users so /api/lookup can skip the
-- full external fan-out. Keyed by a stable app-side hash:
--   firstName | lastName | birthYear | deathYear | geo-cell (~11 km)
-- (see computeGraveIdentityHash in src/lib/community.ts). The snapshot stores
-- ONLY public-record research + a researchVersion stamp — never user notes/tags.
create table if not exists public.gravelens_grave_identity_index (
  identity_hash     text        primary key,
  research_snapshot jsonb       not null,
  contributor_count integer     not null default 1,
  confirmed_at      timestamptz not null default now(),
  expires_at        timestamptz not null default (now() + interval '365 days')
);
alter table public.gravelens_grave_identity_index enable row level security;
create policy "auth read grave index" on public.gravelens_grave_identity_index for select to authenticated using (true);

-- Shared cache for AI-generated derivative content (narrative/story/cultural).
-- Output is a pure function of the request inputs, so identical requests reuse
-- one Claude result. Created in db/migrations/gravelens_research_cache.sql.
create table if not exists public.gravelens_ai_content_cache (
  kind         text        not null check (kind in ('narrative','story','cultural')),
  cache_key    text        not null,   -- sha256 of the normalized request inputs
  payload      jsonb       not null,
  generated_at timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '365 days'),
  primary key (kind, cache_key)
);
alter table public.gravelens_ai_content_cache enable row level security;
create policy "auth read ai cache"   on public.gravelens_ai_content_cache for select to authenticated using (true);
create policy "auth insert ai cache" on public.gravelens_ai_content_cache for insert to authenticated with check (true);
create policy "auth update ai cache" on public.gravelens_ai_content_cache for update to authenticated using (true);


-- ── gravelens_rate_limits ────────────────────────────────────────
-- Defined and locked down in db/migrations/gravelens_security_hardening.sql.
-- Service-role access only (RLS on, no authenticated policies).


-- ── RPC: upsert grave identity (security definer, auth-guarded) ──
-- Hardened in db/migrations/gravelens_research_cache.sql: on conflict the stored
-- snapshot is NOT overwritten unless the existing entry is expired or the incoming
-- snapshot carries a strictly newer researchVersion (anti-poisoning). contributor_count
-- always increments.
create or replace function public.gravelens_upsert_grave_identity(hash text, snapshot jsonb)
returns void
language plpgsql
security definer
as $$
begin
  if auth.uid() is null then
    raise exception 'Unauthorized' using errcode = 'insufficient_privilege';
  end if;
  insert into public.gravelens_grave_identity_index (identity_hash, research_snapshot, contributor_count, confirmed_at, expires_at)
  values (hash, snapshot, 1, now(), now() + interval '365 days')
  on conflict (identity_hash) do update
    set contributor_count = public.gravelens_grave_identity_index.contributor_count + 1,
        confirmed_at = now(),
        research_snapshot = case
          when public.gravelens_grave_identity_index.expires_at < now()
            or coalesce((excluded.research_snapshot->>'researchVersion')::int, 0)
               > coalesce((public.gravelens_grave_identity_index.research_snapshot->>'researchVersion')::int, 0)
          then excluded.research_snapshot
          else public.gravelens_grave_identity_index.research_snapshot
        end,
        expires_at = case
          when public.gravelens_grave_identity_index.expires_at < now()
            or coalesce((excluded.research_snapshot->>'researchVersion')::int, 0)
               > coalesce((public.gravelens_grave_identity_index.research_snapshot->>'researchVersion')::int, 0)
          then now() + interval '365 days'
          else public.gravelens_grave_identity_index.expires_at
        end;
end;
$$;


-- ── External dependencies (owned by LowHigh, listed for reference) ──
--   v_token_balances  — view read by the token gate (available_tokens by user_id)
--   lowhigh_admins    — admin/bypass table read by the token gate


-- ── grave-photos Storage bucket — owner-scoped write policies ────────────────
-- Private bucket; objects are `{userId}/{graveId}.jpg`. Both READS (/api/photo/[id])
-- and WRITES (/api/photo/upload) now go through the service role server-side, so
-- the client no longer depends on these policies for upload. They are kept as
-- defense-in-depth and for the client-side delete path (cloudSync.deleteFromCloud,
-- which still removes objects directly). INSERT/UPDATE are optional given the
-- server-side upload; DELETE is the one still exercised from the browser.
--
-- History: a client-side upload used to require the INSERT policy; when it was
-- missing after the project consolidation, "Back Up Data" failed with "new row
-- violates row-level security policy". Routing uploads through the service role
-- removed that dependency. Runnable copy:
-- db/migrations/gravelens_grave_photos_write_policies.sql

drop policy if exists "grave-photos insert own" on storage.objects;
create policy "grave-photos insert own"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'grave-photos' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "grave-photos update own" on storage.objects;
create policy "grave-photos update own"
  on storage.objects for update to authenticated
  using (bucket_id = 'grave-photos' and auth.uid()::text = (storage.foldername(name))[1])
  with check (bucket_id = 'grave-photos' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "grave-photos delete own" on storage.objects;
create policy "grave-photos delete own"
  on storage.objects for delete to authenticated
  using (bucket_id = 'grave-photos' and auth.uid()::text = (storage.foldername(name))[1]);
