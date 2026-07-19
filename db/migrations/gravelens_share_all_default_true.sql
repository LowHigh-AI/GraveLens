-- gravelens_share_all_default_true
--
-- GraveLens uses an opt-OUT community-sharing model: new users share their
-- discoveries with the community by default, and can opt out via the first-run
-- consent prompt or Settings → Community. The column was originally created
-- with a `false` default, which contradicted that model for any profile row
-- created without an explicit value.
--
-- Non-destructive: SET DEFAULT only affects future inserts that omit the
-- column; existing rows keep their explicit value. Scoped to GraveLens's own
-- gravelens_user_profiles table — no other LowHigh app is affected.
--
-- Applied to shared project eqizlmdknjppefzpdogg on 2026-07-19.
-- Revert: ALTER TABLE public.gravelens_user_profiles
--           ALTER COLUMN share_all_by_default SET DEFAULT false;

ALTER TABLE public.gravelens_user_profiles
  ALTER COLUMN share_all_by_default SET DEFAULT true;
