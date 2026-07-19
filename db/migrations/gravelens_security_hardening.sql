-- ============================================================
-- GraveLens — Security Hardening Migration
-- Apply in: LowHigh Supabase project → SQL Editor (or add to the gravelens_*
-- migration sequence as gravelens_NN_security.sql).
--
-- Covers audit findings:
--   H1  — make gravelens_rate_limits unforgeable (service-role writes only)
--   M3  — make the grave-photos bucket private (served via /api/photo proxy)
--   L3  — default profile discovery to opt-in (show_username = false)
--
-- SAFETY: written to be idempotent and defensive. It does NOT assume the exact
-- names of existing policies — it drops all policies on the affected tables and
-- recreates only the intended ones. Review against the live schema before
-- applying (the repo has historically drifted from the deployed gravelens_*
-- tables; see db/schema/gravelens_reference_schema.sql).
-- ============================================================

begin;

-- ── H1: gravelens_rate_limits — lock down to the service role ────────────────
-- The rate limiter (src/lib/rateLimit.ts) now reads/writes this table ONLY via
-- the service-role key, which bypasses RLS. With RLS enabled and NO policies for
-- the authenticated/anon roles, end users cannot read or reset their own counter
-- to bypass the limit. We also revoke direct table privileges as belt-and-braces.
--
-- NOTE: the `requests` column is jsonb and is now an OBJECT keyed by bucket
-- (e.g. {"analyze":[<epoch_ms>,...],"tts":[...]}) rather than a bare array.
-- jsonb already stores both shapes, so no data backfill is required — legacy
-- array rows are simply ignored by the new code and self-heal on next write.

create table if not exists public.gravelens_rate_limits (
  user_id     uuid        primary key references auth.users(id) on delete cascade,
  requests    jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.gravelens_rate_limits enable row level security;
alter table public.gravelens_rate_limits force row level security;

-- Drop every existing policy on the table (names unknown / may predate this).
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'gravelens_rate_limits'
  loop
    execute format('drop policy if exists %I on public.gravelens_rate_limits', pol.policyname);
  end loop;
end $$;

-- Intentionally NO policies are created → default-deny for anon/authenticated.
revoke all on public.gravelens_rate_limits from anon, authenticated;


-- ── M3: grave-photos bucket → private ────────────────────────────────────────
-- Photos are now served through the authenticated /api/photo/[id] proxy, which
-- enforces owner / is_public / friend access server-side and reads bytes via the
-- service role. Remove public read so private graves' photos are no longer
-- world-readable by URL. Owner-scoped write policies are left intact.

update storage.buckets set public = false where id = 'grave-photos';

-- Remove any public/anon read policy on the bucket's objects.
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname ilike '%photo%'
      and cmd = 'SELECT'
  loop
    execute format('drop policy if exists %I on storage.objects', pol.policyname);
  end loop;
end $$;

-- (No SELECT policy is recreated: the proxy uses the service role, which bypasses
--  RLS. If you ever need authenticated direct-reads, add a scoped policy here.)


-- ── L3: profiles default to opt-in discovery ────────────────────────────────
-- New profiles are not publicly discoverable unless the user opts in. Existing
-- rows are intentionally left unchanged to avoid silently changing current
-- users' visibility; flip them in a separate, communicated step if desired.

alter table public.gravelens_user_profiles
  alter column show_username set default false;

commit;
