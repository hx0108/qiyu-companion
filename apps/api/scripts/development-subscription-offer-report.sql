WITH first_exposure AS (
  SELECT DISTINCT ON (exposure.account_id, exposure.sku, exposure.amount_fen, exposure.currency, exposure.billing_cycle)
    exposure.account_id, exposure.exposure_id, exposure.sku, exposure.amount_fen, exposure.currency,
    exposure.billing_cycle, exposure.viewed_at, exposure.clicked_at
  FROM development_offer_exposures AS exposure
  WHERE exposure.viewed_at >= $1::timestamptz AND exposure.viewed_at < $2::timestamptz
    AND exposure.viewed_at < $3::timestamptz
    AND NOT EXISTS (
      SELECT 1 FROM development_offer_exposures AS earlier
      WHERE earlier.account_id = exposure.account_id AND earlier.sku = exposure.sku
        AND earlier.amount_fen = exposure.amount_fen AND earlier.currency = exposure.currency
        AND earlier.billing_cycle = exposure.billing_cycle AND earlier.viewed_at < $1::timestamptz
    )
  ORDER BY exposure.account_id, exposure.sku, exposure.amount_fen, exposure.currency, exposure.billing_cycle,
    exposure.viewed_at, exposure.exposure_id
), eligible AS (
  SELECT first_exposure.*, first_exposure.viewed_at + INTERVAL '168 hours' AS window_end
  FROM first_exposure
  WHERE NOT EXISTS (
    SELECT 1 FROM subscription_orders AS prior
    JOIN payment_events AS payment ON payment.account_id = prior.account_id AND payment.subscription_id = prior.subscription_id
    WHERE prior.account_id = first_exposure.account_id AND prior.sku = first_exposure.sku
      AND prior.channel = 'DEVELOPMENT_SIMULATED'
      AND payment.event_type = 'PURCHASE_SUCCEEDED' AND payment.outcome = 'APPLIED'
      AND payment.created_at < first_exposure.viewed_at
  )
), outcomes AS (
  SELECT eligible.*,
    COUNT(linked.clicked_at) FILTER (WHERE linked.clicked_at < LEAST(window_end, $3::timestamptz)) > 0 AS clicked,
    COUNT(orders.order_id) > 0 AS checkout,
    COUNT(payment.provider_event_id) > 0 AS simulated_first_paid
  FROM eligible
  JOIN development_offer_exposures AS linked USING (account_id, sku, amount_fen, currency, billing_cycle)
  LEFT JOIN subscription_orders AS orders
    ON orders.account_id = linked.account_id AND orders.development_exposure_id = linked.exposure_id
    AND orders.channel = 'DEVELOPMENT_SIMULATED' AND orders.sku = linked.sku
    AND orders.amount_fen = linked.amount_fen AND orders.currency = linked.currency
    AND orders.created_at >= linked.viewed_at AND orders.created_at < LEAST(window_end, $3::timestamptz)
  LEFT JOIN payment_events AS payment
    ON payment.account_id = orders.account_id AND payment.subscription_id = orders.subscription_id
    AND payment.event_type = 'PURCHASE_SUCCEEDED' AND payment.outcome = 'APPLIED'
    AND payment.created_at >= orders.created_at AND payment.created_at < LEAST(window_end, $3::timestamptz)
  WHERE linked.viewed_at >= eligible.viewed_at AND linked.viewed_at < LEAST(window_end, $3::timestamptz)
  GROUP BY eligible.account_id, eligible.exposure_id, eligible.sku, eligible.amount_fen, eligible.currency,
    eligible.billing_cycle, eligible.viewed_at, eligible.clicked_at, eligible.window_end
)
SELECT 'DEVELOPMENT_SIMULATED' AS channel, sku, amount_fen AS quoted_amount_fen, currency, billing_cycle,
  COUNT(*) AS eligible_exposed_accounts,
  COUNT(*) FILTER (WHERE window_end <= $3::timestamptz) AS mature_exposed_accounts,
  COUNT(*) FILTER (WHERE window_end <= $3::timestamptz AND clicked) AS clicked_accounts,
  COUNT(*) FILTER (WHERE window_end <= $3::timestamptz AND checkout) AS checkout_accounts,
  COUNT(*) FILTER (WHERE window_end <= $3::timestamptz AND simulated_first_paid) AS simulated_first_paid_accounts
FROM outcomes
GROUP BY sku, amount_fen, currency, billing_cycle
ORDER BY sku, quoted_amount_fen, currency, billing_cycle;
