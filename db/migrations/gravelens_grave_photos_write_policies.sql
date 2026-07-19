-- ============================================================
-- GraveLens — grave-photos bucket owner-scoped WRITE policies
-- Apply in: LowHigh Supabase project → SQL Editor.
--
-- Fixes: manual "Back Up Data" (and any client-side photo write) failing with
--   "new row violates row-level security policy"
-- Cause: the grave-photos bucket has no INSERT/UPDATE/DELETE policy allowing an
--   authenticated user to write objects under their own {userId}/ folder. Photos
--   are uploaded client-side to path `{userId}/{graveId}.jpg`
--   (src/lib/cloudSync.ts → uploadPhoto, upsert: true), so both INSERT and UPDATE
--   are required. Reads stay service-role-only via the /api/photo proxy — this
--   migration deliberately adds NO SELECT policy.
--
-- SAFETY: idempotent. Uses uniquely-named policies so it will not clobber any
--   differently-named policies that may already exist; if working policies are
--   already present, these are simply additional permissive (OR'd) policies.
--   Run the inspection query below FIRST if you want to avoid duplicates.
-- ============================================================

-- ── Inspect current storage.objects policies (optional, read-only) ───────────
-- select policyname, cmd, roles, qual, with_check
--   from pg_policies
--  where schemaname = 'storage' and tablename = 'objects'
--  order by policyname;

begin;

-- INSERT: a signed-in user may create objects only under their own uid folder.
drop policy if exists "grave-photos insert own" on storage.objects;
create policy "grave-photos insert own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'grave-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- UPDATE: needed because uploadPhoto uses upsert:true (overwrite existing photo).
drop policy if exists "grave-photos update own" on storage.objects;
create policy "grave-photos update own"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'grave-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'grave-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- DELETE: keeps deleteFromCloud() working (remove a grave's photo).
drop policy if exists "grave-photos delete own" on storage.objects;
create policy "grave-photos delete own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'grave-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

commit;
