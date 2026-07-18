-- ============================================================
-- GraveLens — Pooled burial index (family-plot connections)
--
-- The burial index is GraveLens' own cross-user person database: every scan
-- harvests the stone's PUBLIC facts (name, dates, cemetery, GPS — no photos,
-- notes, or user id) so the app can surface "who else is in this family plot"
-- and answer manual /research lookups from internal data instead of external
-- APIs. Anonymous, non-sensitive, public-record-derived — same trust class as
-- gravelens_local_history_cache / gravelens_cemetery_cache.
--
-- This table is GraveLens-only and was not part of the initial LowHigh
-- migration; this adds it to the shared project. Additive only — touches no
-- other app's tables.
--
-- Apply against the shared LowHigh Supabase project. This repo's migrations/
-- drifts from live — introspect the live schema before applying.
-- ============================================================

-- ── gravelens_burial_index ───────────────────────────────────────────────────
create table if not exists public.gravelens_burial_index (
  identity_key    text        primary key,   -- given|surname|birthYear|deathYear|state (normalized)
  given_name      text,
  surname         text        not null,
  full_name       text,
  surname_soundex text,
  birth_year      integer,
  death_year      integer,
  birth_date      text,
  death_date      text,
  cemetery        text,
  city            text,
  county          text,
  state           text,
  lat             double precision,
  lng             double precision,
  scan_count      integer     not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists gravelens_burial_index_surname_death_idx on public.gravelens_burial_index (surname, death_year);
create index if not exists gravelens_burial_index_state_death_idx   on public.gravelens_burial_index (state, death_year);
create index if not exists gravelens_burial_index_soundex_idx       on public.gravelens_burial_index (surname_soundex);

alter table public.gravelens_burial_index enable row level security;

-- Anonymous pooled facts: authenticated read. Writes go only through the
-- security-definer upsert below (mirrors the gravelens_grave_identity pattern).
create policy "auth read burial index" on public.gravelens_burial_index for select to authenticated using (true);


-- ── gravelens_upsert_burial_index ────────────────────────────────────────────
-- Harvest a scan into the pool. Repeat scans of the same person increment
-- scan_count and back-fill facts a later scan captured that earlier ones missed
-- (coalesce keeps the first non-null value). Security-definer + auth guard, so
-- anonymous callers cannot write (the RLS table has no insert/update policy).
create or replace function public.gravelens_upsert_burial_index(
  p_identity_key    text,
  p_given_name      text,
  p_surname         text,
  p_full_name       text,
  p_surname_soundex text,
  p_birth_year      integer,
  p_death_year      integer,
  p_birth_date      text,
  p_death_date      text,
  p_cemetery        text,
  p_city            text,
  p_county          text,
  p_state           text,
  p_lat             double precision,
  p_lng             double precision
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Unauthorized' using errcode = 'insufficient_privilege';
  end if;

  if p_identity_key is null or p_surname is null then
    raise exception 'identity_key and surname are required';
  end if;

  insert into public.gravelens_burial_index (
    identity_key, given_name, surname, full_name, surname_soundex,
    birth_year, death_year, birth_date, death_date,
    cemetery, city, county, state, lat, lng
  ) values (
    p_identity_key, p_given_name, p_surname, p_full_name, p_surname_soundex,
    p_birth_year, p_death_year, p_birth_date, p_death_date,
    p_cemetery, p_city, p_county, p_state, p_lat, p_lng
  )
  on conflict (identity_key) do update
    set scan_count  = public.gravelens_burial_index.scan_count + 1,
        given_name  = coalesce(public.gravelens_burial_index.given_name,  excluded.given_name),
        full_name   = coalesce(public.gravelens_burial_index.full_name,   excluded.full_name),
        birth_year  = coalesce(public.gravelens_burial_index.birth_year,  excluded.birth_year),
        death_year  = coalesce(public.gravelens_burial_index.death_year,  excluded.death_year),
        birth_date  = coalesce(public.gravelens_burial_index.birth_date,  excluded.birth_date),
        death_date  = coalesce(public.gravelens_burial_index.death_date,  excluded.death_date),
        cemetery    = coalesce(public.gravelens_burial_index.cemetery,    excluded.cemetery),
        city        = coalesce(public.gravelens_burial_index.city,        excluded.city),
        county      = coalesce(public.gravelens_burial_index.county,      excluded.county),
        state       = coalesce(public.gravelens_burial_index.state,       excluded.state),
        lat         = coalesce(public.gravelens_burial_index.lat,         excluded.lat),
        lng         = coalesce(public.gravelens_burial_index.lng,         excluded.lng),
        updated_at  = now();
end;
$$;

revoke execute on function public.gravelens_upsert_burial_index(text, text, text, text, text, integer, integer, text, text, text, text, text, text, double precision, double precision) from anon, public;
grant  execute on function public.gravelens_upsert_burial_index(text, text, text, text, text, integer, integer, text, text, text, text, text, text, double precision, double precision) to authenticated;
