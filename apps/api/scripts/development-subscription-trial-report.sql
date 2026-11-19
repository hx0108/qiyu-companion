WITH first_trials AS (
  SELECT DISTINCT ON (account_id) account_id, period_start, period_end
  FROM subscriptions
  WHERE channel = 'DEVELOPMENT_TRIAL'
    AND period_start IS NOT NULL AND period_end > period_start
  ORDER BY account_id, period_start, subscription_id
), first_simulated_purchases AS (
  SELECT orders.account_id, MIN(payment.created_at) AS paid_at
  FROM subscription_orders AS orders
  JOIN payment_events AS payment USING (account_id, subscription_id)
  WHERE orders.channel = 'DEVELOPMENT_SIMULATED'
    AND payment.event_type = 'PURCHASE_SUCCEEDED' AND payment.outcome = 'APPLIED'
    AND payment.created_at >= orders.created_at AND payment.created_at < $3::timestamptz
  GROUP BY orders.account_id
), cohort AS (
  SELECT trial.*, purchase.paid_at, period_end + INTERVAL '168 hours' AS window_end
  FROM first_trials AS trial
  LEFT JOIN first_simulated_purchases AS purchase USING (account_id)
  WHERE period_start >= $1::timestamptz AND period_start < LEAST($2::timestamptz, $3::timestamptz)
    AND (purchase.paid_at IS NULL OR purchase.paid_at >= period_start)
)
SELECT 'DEVELOPMENT_SIMULATED' AS channel,
  COUNT(*) AS eligible_trial_accounts,
  COUNT(*) FILTER (WHERE window_end <= $3::timestamptz) AS mature_trial_accounts,
  COUNT(*) FILTER (WHERE window_end <= $3::timestamptz AND paid_at < window_end) AS simulated_first_paid_accounts
FROM cohort;
