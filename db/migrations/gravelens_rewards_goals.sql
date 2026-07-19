-- ============================================================================
-- GraveLens × LowHigh — REWARDS VISIBILITY + RANK GOALS
--
-- The rewards/goals system (goals, user_goal_completions, claim_goal(), the
-- referral RPCs) ALREADY EXISTS in production and powers LowHigh's Balance &
-- Rewards page. This migration does NOT recreate any of it. It only ADDS to the
-- existing `goals` table:
--   1. a `visible_in_apps` column so each goal can declare which apps surface it,
--   2. marks the account-level goals as also relevant to GraveLens,
--   3. adds GraveLens-specific reward goals (welcome + Explorer ranks) as ROWS.
--
-- All of these goals are is_active = true and visible_in_apps = {lowhigh,
-- gravelens}, so they appear on BOTH sites — LowHigh's rewards page now lists
-- the GraveLens rewards too. On LowHigh the GraveLens-specific goals render as
-- "Coming soon" (requirement_type='coming_soon'), since they're earned/claimed
-- inside GraveLens; GraveLens evaluates the real eligibility by slug
-- (gravelens_rank_* → Explorer rank, gravelens_welcome → app opened) and claims
-- via the shared claim_goal() RPC. GraveLens reads its list with the service role
-- filtered by visible_in_apps @> '{gravelens}'.
--
-- Safe to re-run (idempotent). Run in the shared/production Supabase project.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Per-app visibility column on the existing goals table.
-- ----------------------------------------------------------------------------
ALTER TABLE goals
    ADD COLUMN IF NOT EXISTS visible_in_apps text[] NOT NULL DEFAULT '{lowhigh}';

-- ----------------------------------------------------------------------------
-- 2. Account-level goals apply to a GraveLens user too (they share the LowHigh
--    account): signup, the subscribe tiers, and the three referral goals.
-- ----------------------------------------------------------------------------
UPDATE goals
SET visible_in_apps = ARRAY['lowhigh', 'gravelens']
WHERE slug IN (
    'join_the_club',      -- create a LowHigh login (account creation)
    'getting_started',    -- subscribe Starter+
    'settling_in',        -- subscribe Plus+
    'living_large',       -- subscribe Premium
    'spread_the_word',    -- refer → Starter
    'share_the_joy',      -- refer → Plus
    'lead_the_pack'       -- refer → Premium
);

-- ----------------------------------------------------------------------------
-- 3. GraveLens welcome bonus (first open). Shown on both apps. Keyed on
--    requirement_params.app_slug, matching GraveLens/src/lib/welcomeBonus.ts;
--    claimed automatically by GraveLens on first open via claim_goal().
-- ----------------------------------------------------------------------------
INSERT INTO goals (
    slug, title, description, category, token_reward, frequency,
    redemption, requirement_type, requirement_params, is_phase_1, sort_order,
    is_active, visible_in_apps
) VALUES (
    'gravelens_welcome',
    'Blast from the past',
    'Open GraveLens for the first time to claim your one-time welcome bonus.',
    'first_steps', 100000, 'one_time',
    'automatic', 'coming_soon', '{"app_slug": "gravelens"}'::jsonb, false, 1,
    true, ARRAY['lowhigh', 'gravelens']
)
ON CONFLICT (slug) DO UPDATE SET
    token_reward       = EXCLUDED.token_reward,
    requirement_params = EXCLUDED.requirement_params,
    is_active          = EXCLUDED.is_active,
    visible_in_apps    = EXCLUDED.visible_in_apps;

-- ----------------------------------------------------------------------------
-- 4. Explorer rank rewards (ranks 2–10). Shown on both apps. requirement_type
--    ='coming_soon' is a value the existing CHECK already allows; GraveLens keys
--    off the slug (gravelens_rank_*) + requirement_params.min_rank for its own
--    rank eligibility, then claims via claim_goal(). token_reward MUST match
--    RANK_TOKEN_BONUS in GraveLens/src/lib/achievements.ts.
-- ----------------------------------------------------------------------------
INSERT INTO goals (
    slug, title, description, category, token_reward, frequency,
    redemption, requirement_type, requirement_params, is_phase_1, sort_order,
    is_active, visible_in_apps
) VALUES
    ('gravelens_rank_2',  'Explorer Rank 2 · The Curious',      'Reach Explorer rank 2 in GraveLens.',  'first_steps',   5000, 'one_time', 'manual', 'coming_soon', '{"min_rank": 2}'::jsonb,  false, 2,  true, ARRAY['lowhigh', 'gravelens']),
    ('gravelens_rank_3',  'Explorer Rank 3 · The Seeker',       'Reach Explorer rank 3 in GraveLens.',  'first_steps',  10000, 'one_time', 'manual', 'coming_soon', '{"min_rank": 3}'::jsonb,  false, 3,  true, ARRAY['lowhigh', 'gravelens']),
    ('gravelens_rank_4',  'Explorer Rank 4 · The Chronicler',   'Reach Explorer rank 4 in GraveLens.',  'first_steps',  15000, 'one_time', 'manual', 'coming_soon', '{"min_rank": 4}'::jsonb,  false, 4,  true, ARRAY['lowhigh', 'gravelens']),
    ('gravelens_rank_5',  'Explorer Rank 5 · The Sleuth',       'Reach Explorer rank 5 in GraveLens.',  'first_steps',  20000, 'one_time', 'manual', 'coming_soon', '{"min_rank": 5}'::jsonb,  false, 5,  true, ARRAY['lowhigh', 'gravelens']),
    ('gravelens_rank_6',  'Explorer Rank 6 · The Historian',    'Reach Explorer rank 6 in GraveLens.',  'first_steps',  30000, 'one_time', 'manual', 'coming_soon', '{"min_rank": 6}'::jsonb,  false, 6,  true, ARRAY['lowhigh', 'gravelens']),
    ('gravelens_rank_7',  'Explorer Rank 7 · The Archivist',    'Reach Explorer rank 7 in GraveLens.',  'first_steps',  40000, 'one_time', 'manual', 'coming_soon', '{"min_rank": 7}'::jsonb,  false, 7,  true, ARRAY['lowhigh', 'gravelens']),
    ('gravelens_rank_8',  'Explorer Rank 8 · The Curator',      'Reach Explorer rank 8 in GraveLens.',  'first_steps',  50000, 'one_time', 'manual', 'coming_soon', '{"min_rank": 8}'::jsonb,  false, 8,  true, ARRAY['lowhigh', 'gravelens']),
    ('gravelens_rank_9',  'Explorer Rank 9 · The Scholar',      'Reach Explorer rank 9 in GraveLens.',  'first_steps',  75000, 'one_time', 'manual', 'coming_soon', '{"min_rank": 9}'::jsonb,  false, 9,  true, ARRAY['lowhigh', 'gravelens']),
    ('gravelens_rank_10', 'Explorer Rank 10 · Master Historian','Reach Explorer rank 10 in GraveLens.', 'first_steps', 100000, 'one_time', 'manual', 'coming_soon', '{"min_rank": 10}'::jsonb, false, 10, true, ARRAY['lowhigh', 'gravelens'])
ON CONFLICT (slug) DO UPDATE SET
    title              = EXCLUDED.title,
    description        = EXCLUDED.description,
    token_reward       = EXCLUDED.token_reward,
    requirement_params = EXCLUDED.requirement_params,
    sort_order         = EXCLUDED.sort_order,
    is_active          = EXCLUDED.is_active,
    visible_in_apps    = EXCLUDED.visible_in_apps;

-- ----------------------------------------------------------------------------
-- 5. Verification
-- ----------------------------------------------------------------------------
-- SELECT slug, token_reward, requirement_params, is_active, visible_in_apps
--   FROM goals WHERE visible_in_apps @> '{gravelens}' ORDER BY sort_order;
