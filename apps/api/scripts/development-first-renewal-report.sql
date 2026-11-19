WITH first_purchases AS (
  SELECT DISTINCT ON (orders.account_id) orders.account_id, orders.subscription_id, orders.sku,
    orders.auto_renew, payment.provider_event_id, payment.created_at AS first_paid_at
  FROM subscription_orders AS orders
  JOIN payment_events AS payment USING (account_id, subscription_id)
  WHERE orders.channel = 'DEVELOPMENT_SIMULATED'
    AND payment.event_type = 'PURCHASE_SUCCEEDED' AND payment.outcome = 'APPLIED'
    AND payment.created_at >= orders.created_at AND payment.created_at < $3::timestamptz
  ORDER BY orders.account_id, payment.created_at, payment.provider_event_id
), cohort AS (
  SELECT first_purchases.*,
    CASE WHEN grants.period_end_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      AND pg_input_is_valid(grants.period_end_text, 'timestamp with time zone')
      THEN grants.period_end_text::timestamptz END AS first_due_at
  FROM first_purchases
  LEFT JOIN LATERAL (
    SELECT CASE WHEN COUNT(DISTINCT ledger.entitlement_id) = 1
      THEN MIN(SUBSTRING(ledger.entitlement_id FROM LENGTH(first_purchases.subscription_id::text) + 2))
      END AS period_end_text
    FROM entitlement_ledgers AS ledger
    WHERE ledger.account_id = first_purchases.account_id
      AND ledger.source_event_id = first_purchases.provider_event_id
      AND ledger.action = 'GRANT' AND ledger.source = 'PAYMENT_VERIFIED'
      AND ledger.created_at < $3::timestamptz
      AND starts_with(ledger.entitlement_id, first_purchases.subscription_id::text || ':')
  ) AS grants ON true
  WHERE first_paid_at >= $1::timestamptz AND first_paid_at < $2::timestamptz
), outcomes AS (
  SELECT cohort.*,
    subscription.development_renewal_cancelled_at >= first_paid_at
      AND subscription.development_renewal_cancelled_at < $3::timestamptz AS cancellation_recorded,
    first_due_at > first_paid_at AND first_due_at + INTERVAL '168 hours' <= $3::timestamptz AS mature,
    EXISTS (
      SELECT 1 FROM payment_events AS renewal
      WHERE renewal.account_id = cohort.account_id AND renewal.subscription_id = cohort.subscription_id
        AND renewal.event_type = 'RENEWAL_SUCCEEDED' AND renewal.outcome = 'APPLIED'
        AND renewal.created_at >= first_due_at
        AND renewal.created_at < LEAST(first_due_at + INTERVAL '168 hours', $3::timestamptz)
    ) AS renewed
  FROM cohort
  LEFT JOIN subscriptions AS subscription USING (account_id, subscription_id)
)
SELECT 'DEVELOPMENT_SIMULATED' AS channel, sku, auto_renew AS auto_renew_at_checkout,
  COUNT(*) AS first_paid_accounts,
  COUNT(*) FILTER (WHERE first_due_at IS NULL OR first_due_at <= first_paid_at) AS unknown_first_due_accounts,
  COUNT(*) FILTER (WHERE mature) AS mature_first_renewal_accounts,
  COUNT(*) FILTER (WHERE cancellation_recorded) AS recorded_renewal_cancellation_accounts,
  COUNT(*) FILTER (WHERE mature AND renewed) AS simulated_first_renewed_accounts
FROM outcomes
GROUP BY sku, auto_renew
ORDER BY sku, auto_renew;
