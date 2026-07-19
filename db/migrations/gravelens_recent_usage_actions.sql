-- ============================================================================
-- recent_usage_actions(): a user's recent AI spend, one row per USER ACTION
-- ============================================================================
--
-- WHY
--   The "Recent usage" ledger on /rewards shows what recent AI actions cost.
--   Usage is not itemized in token_transactions (no 'debit' rows are written);
--   it lives in api_usage_log, one row per AI call, normalized to
--   `lowhigh_tokens` (1M LowHigh tokens = $1 of API cost). One user action can
--   fan out into several calls that share a `prompt_id`, so we group by
--   prompt_id and sum — the same grouping the estimator uses.
--
--   Filtered by user only (NOT by app_slug): the token balance is shared across
--   the whole ecosystem, so this honestly reflects everything that drained it.
--
--   Legacy rows may have a NULL prompt_id; COALESCE(prompt_id, id) makes each
--   render as its own single-call action instead of collapsing into one group.
--
-- The client (billingData.fetchRecentUsage) prefers this RPC and falls back to
-- grouping ~150 recent rows in JS if it is absent, so the UI works before this
-- migration is applied.
--
-- PRECONDITION — verify the live api_usage_log columns before running (repo
-- migrations are known to drift from live schema):
--   select column_name, data_type from information_schema.columns
--   where table_name = 'api_usage_log' order by ordinal_position;
-- Assumes: id (uuid pk), user_id (uuid), created_at (timestamptz),
--   prompt_id (uuid, nullable), component (text), tool (text),
--   lowhigh_tokens (numeric).
-- ============================================================================

CREATE OR REPLACE FUNCTION recent_usage_actions(
    p_user_id  UUID,
    p_limit    INT DEFAULT 10
)
RETURNS TABLE(
    prompt_id     UUID,
    started       TIMESTAMPTZ,
    action_tokens NUMERIC,
    call_count    BIGINT,
    tool          TEXT,
    components    TEXT[]
)
LANGUAGE sql
SECURITY DEFINER
AS $$
    SELECT COALESCE(l.prompt_id, l.id)                       AS prompt_id,
           MIN(l.created_at)                                 AS started,
           COALESCE(SUM(l.lowhigh_tokens), 0)                AS action_tokens,
           COUNT(*)                                          AS call_count,
           MAX(l.tool)                                       AS tool,
           ARRAY_AGG(DISTINCT l.component)
             FILTER (WHERE l.component IS NOT NULL)          AS components
    FROM api_usage_log l
    WHERE l.user_id = p_user_id
    GROUP BY COALESCE(l.prompt_id, l.id)
    ORDER BY started DESC
    LIMIT GREATEST(p_limit, 1);
$$;

REVOKE ALL ON FUNCTION recent_usage_actions(UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recent_usage_actions(UUID, INT) TO service_role;
