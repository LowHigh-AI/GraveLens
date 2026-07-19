-- ============================================================
-- GraveLens — Research-reuse caching
--
-- Two changes that let the app serve internal data instead of re-running
-- external API + AI calls on every scan:
--
--   1. gravelens_ai_content_cache — shared store for AI-generated narrative /
--      story / cultural content. The output is a pure function of the request
--      inputs (which derive from public records, never from private notes), so
--      identical requests from any authenticated user reuse one cached result.
--
--   2. gravelens_upsert_grave_identity — hardened so a later scan can no longer
--      clobber an existing good research snapshot (anti-poisoning). The snapshot
--      is only refreshed when the existing entry has expired or the incoming
--      snapshot carries a strictly newer researchVersion.
--
-- Apply against the shared LowHigh Supabase project. This repo's migrations/
-- drifts from live — introspect the live schema before applying.
-- ============================================================

-- ── gravelens_ai_content_cache ───────────────────────────────────────────────
create table if not exists public.gravelens_ai_content_cache (
  kind         text        not null check (kind in ('narrative','story','cultural')),
  cache_key    text        not null,   -- sha256 of the normalized request inputs
  payload      jsonb       not null,   -- the route's JSON response
  generated_at timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '365 days'),
  primary key (kind, cache_key)
);

alter table public.gravelens_ai_content_cache enable row level security;

-- Non-sensitive, public-record-derived content: authenticated read/write,
-- mirroring gravelens_local_history_cache / gravelens_cemetery_cache.
create policy "auth read ai cache"   on public.gravelens_ai_content_cache for select to authenticated using (true);
create policy "auth insert ai cache" on public.gravelens_ai_content_cache for insert to authenticated with check (true);
create policy "auth update ai cache" on public.gravelens_ai_content_cache for update to authenticated using (true);

-- Optional: index to support TTL sweeps.
create index if not exists gravelens_ai_content_cache_expires_idx
  on public.gravelens_ai_content_cache (expires_at);


-- ── Harden the grave-identity upsert (anti-poisoning) ────────────────────────
create or replace function public.gravelens_upsert_grave_identity(hash text, snapshot jsonb)
returns void
language plpgsql
security definer
as $$
begin
  if auth.uid() is null then
    raise exception 'Unauthorized' using errcode = 'insufficient_privilege';
  end if;

  insert into public.gravelens_grave_identity_index
    (identity_hash, research_snapshot, contributor_count, confirmed_at, expires_at)
  values (hash, snapshot, 1, now(), now() + interval '365 days')
  on conflict (identity_hash) do update
    set
      -- Always record that another contributor confirmed this identity.
      contributor_count = public.gravelens_grave_identity_index.contributor_count + 1,
      confirmed_at = now(),
      -- Only replace the stored snapshot when the existing one is expired OR the
      -- incoming snapshot has a strictly newer researchVersion. Otherwise keep
      -- the first good snapshot so a later bad scan cannot overwrite it.
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
