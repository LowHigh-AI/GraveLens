-- apply_upgrade_proration — mid-cycle upgrade token top-up.
--
-- When a subscriber upgrades in the middle of a billing period (via the Billing
-- Portal's subscription_update_confirm flow), Stripe prorates the *money*: it
-- credits unused time on the old plan and charges the difference for the rest of
-- the period. This function mirrors that in *tokens*: it grants the difference
-- between the new and old base allowance, scaled by the fraction of the current
-- period still remaining, so the user's token balance matches what they now pay.
--
-- Why a separate function (not apply_monthly_token_reset): that function is
-- idempotent per period — once the period's 'allocation' row exists it no-ops, so
-- it can't top up an upgrade mid-period. This grants only the incremental delta.
--
-- Trigger: called from the webhook's customer.subscription.updated handler after
-- the subscription row is synced to the new plan. Safe to call on EVERY
-- subscription.updated event: it no-ops for downgrades, non-plan updates, and
-- repeat deliveries (idempotency keyed on period + target plan).
--
-- Shared Supabase project — run ONCE in live SQL (CREATE OR REPLACE, re-runnable).

CREATE OR REPLACE FUNCTION apply_upgrade_proration(
    p_user_id       UUID,
    p_period_start  TIMESTAMPTZ DEFAULT NULL,
    p_period_end    TIMESTAMPTZ DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_new_plan_id     UUID;
    v_new_allowance   BIGINT;
    v_old_allowance   BIGINT;
    v_remaining_frac  NUMERIC;
    v_delta           BIGINT;
    v_available       BIGINT;
BEGIN
    -- The current (already-synced) active plan is the plan being upgraded TO.
    SELECT sp.id, sp.token_allowance
    INTO v_new_plan_id, v_new_allowance
    FROM user_subscriptions us
    JOIN subscription_plans sp ON sp.id = us.plan_id
    WHERE us.user_id = p_user_id
      AND us.status IN ('active', 'trialing', 'lifetime');

    IF v_new_plan_id IS NULL THEN
        RETURN;
    END IF;

    -- Base allowance already granted for THIS period = the plan upgraded FROM.
    -- (token_transactions.amount on the 'allocation' row is the base allowance,
    --  excluding loyalty bonuses.)
    SELECT amount
    INTO v_old_allowance
    FROM token_transactions
    WHERE user_id = p_user_id
      AND type = 'allocation'
      AND (p_period_start IS NULL OR (metadata->>'period_start')::timestamptz = p_period_start)
    ORDER BY created_at DESC
    LIMIT 1;

    -- No prior allocation to compare against, or this is a downgrade / same plan.
    -- Downgrades keep their existing tokens for the period; nothing to grant.
    IF v_old_allowance IS NULL OR v_new_allowance <= v_old_allowance THEN
        RETURN;
    END IF;

    -- Idempotency: at most one proration grant per (period, target plan).
    IF EXISTS (
        SELECT 1 FROM token_transactions
        WHERE user_id = p_user_id
          AND type = 'adjustment'
          AND metadata->>'reason' = 'upgrade_proration'
          AND metadata->>'plan_id' = v_new_plan_id::text
          AND (p_period_start IS NULL OR (metadata->>'period_start')::timestamptz = p_period_start)
    ) THEN
        RETURN;
    END IF;

    -- Fraction of the current period still remaining (default to full if the
    -- window is unknown).
    IF p_period_start IS NOT NULL AND p_period_end IS NOT NULL AND p_period_end > p_period_start THEN
        v_remaining_frac := GREATEST(0, LEAST(1,
            EXTRACT(EPOCH FROM (p_period_end - NOW()))
            / EXTRACT(EPOCH FROM (p_period_end - p_period_start))
        ));
    ELSE
        v_remaining_frac := 1;
    END IF;

    v_delta := FLOOR((v_new_allowance - v_old_allowance) * v_remaining_frac);
    IF v_delta <= 0 THEN
        RETURN;
    END IF;

    UPDATE token_balances
    SET allocated_tokens = COALESCE(allocated_tokens, 0) + v_delta,
        updated_at = NOW()
    WHERE user_id = p_user_id;

    -- No balance row (shouldn't happen for an active subscriber) → don't log a
    -- ledger row with a bogus balance.
    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT GREATEST(
        COALESCE(allocated_tokens, 0) + COALESCE(purchased_tokens, 0)
        + COALESCE(rollover_tokens, 0) - COALESCE(used_tokens, 0), 0)
    INTO v_available
    FROM token_balances
    WHERE user_id = p_user_id;

    INSERT INTO token_transactions (
        user_id, type, amount, balance_after, description, metadata
    ) VALUES (
        p_user_id,
        'adjustment',
        v_delta,
        v_available,
        'Upgrade proration',
        jsonb_build_object(
            'reason', 'upgrade_proration',
            'plan_id', v_new_plan_id,
            'period_start', p_period_start,
            'period_end', p_period_end,
            'prev_allowance', v_old_allowance,
            'new_allowance', v_new_allowance,
            'remaining_fraction', v_remaining_frac
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION apply_upgrade_proration(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_upgrade_proration(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
