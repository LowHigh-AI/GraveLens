-- ============================================================
-- GraveLens — Identity consolidation backfill
-- Apply in: LowHigh Supabase project → SQL Editor (or add to the gravelens_*
-- migration sequence).
--
-- Context: GraveLens now uses a single identity (the account Display Name).
-- Community contribution is a visibility choice: while a user opts to show their
-- name (`show_username = true`) their account Display Name is mirrored into
-- `gravelens_user_profiles.display_name`; when hidden, that column is null and the
-- contributor reads as "Community Member". The legacy public @handle
-- (`username`) is retired from the UI.
--
-- This migration carries each EXISTING public handle into `display_name` so that
-- current contributors keep a visible name instead of flipping to "Community
-- Member" after the app update. New writes (toggle/blur) keep it in sync.
--
-- SAFETY:
--   * Idempotent — safe to re-run (only fills rows whose display_name is empty).
--   * Public-only — touches ONLY rows with show_username = true, so a hidden
--     user's name is never populated and never reaches other clients.
--   * Non-destructive — the `username` column is left in place (unused). Drop it
--     later in a dedicated migration once you have confirmed nothing reads it.
--   * Per repo convention, the deployed gravelens_* tables have historically
--     drifted from db/schema/gravelens_reference_schema.sql — confirm the
--     `display_name`, `username`, and `show_username` columns exist as expected
--     before applying.
-- ============================================================

begin;

update public.gravelens_user_profiles
   set display_name = username
 where show_username = true
   and username is not null
   and (display_name is null or display_name = '');

commit;

-- Optional later cleanup (run separately after verifying nothing reads it):
--   alter table public.gravelens_user_profiles drop column username;
