WITH checkout_orders AS (
  SELECT order_id, account_id, subscription_id, sku, amount_fen, currency, development_exposure_id
  FROM subscription_orders
  WHERE channel = 'DEVELOPMENT_SIMULATED'
    AND created_at >= $1::timestamptz
    AND created_at < $2::timestamptz
    AND created_at < $3::timestamptz
), applied_events AS (
  SELECT event.account_id, event.subscription_id, event.provider_event_id, event.event_type,
    event.refund_amount_fen, event.refund_currency
  FROM payment_events AS event
  JOIN checkout_orders AS checkout
    ON checkout.account_id = event.account_id AND checkout.subscription_id = event.subscription_id
  WHERE event.outcome = 'APPLIED' AND event.created_at < $3::timestamptz
), checkout_outcomes AS (
  SELECT checkout.*,
    EXISTS (SELECT 1 FROM applied_events AS event
      WHERE event.subscription_id = checkout.subscription_id
        AND event.event_type = 'PURCHASE_SUCCEEDED') AS first_payment,
    EXISTS (SELECT 1 FROM applied_events AS event
      JOIN entitlement_ledgers AS grant_entry ON grant_entry.source_event_id = event.provider_event_id
        AND grant_entry.account_id = event.account_id
      WHERE event.subscription_id = checkout.subscription_id
        AND event.event_type = 'PURCHASE_SUCCEEDED'
        AND grant_entry.action = 'GRANT' AND grant_entry.source = 'PAYMENT_VERIFIED'
        AND grant_entry.created_at < $3::timestamptz) AS entitlement_granted,
    EXISTS (SELECT 1 FROM applied_events AS event
      WHERE event.subscription_id = checkout.subscription_id
        AND event.event_type = 'PAYMENT_FAILED') AS saw_payment_failure,
    EXISTS (SELECT 1 FROM applied_events AS event
      WHERE event.subscription_id = checkout.subscription_id
        AND event.event_type IN ('REFUND_FULL', 'REFUND_PARTIAL')) AS saw_refund,
    EXISTS (SELECT 1 FROM applied_events AS event
      WHERE event.subscription_id = checkout.subscription_id
        AND event.event_type IN ('REFUND_FULL', 'REFUND_PARTIAL')
        AND (event.refund_amount_fen IS NULL OR event.refund_currency IS DISTINCT FROM checkout.currency)) AS refund_amount_missing,
    (SELECT COALESCE(SUM(event.refund_amount_fen), 0) FROM applied_events AS event
      WHERE event.subscription_id = checkout.subscription_id
        AND event.event_type IN ('REFUND_FULL', 'REFUND_PARTIAL')
        AND event.refund_currency = checkout.currency) AS known_refund_amount_fen,
    EXISTS (SELECT 1 FROM applied_events AS event
      WHERE event.subscription_id = checkout.subscription_id
        AND event.event_type = 'RENEWAL_SUCCEEDED') AS saw_renewal
  FROM checkout_orders AS checkout
)
SELECT 'DEVELOPMENT_SIMULATED' AS channel, sku, amount_fen AS quoted_amount_fen, currency,
  COUNT(*) AS checkout_orders,
  COUNT(DISTINCT account_id) AS checkout_accounts,
  COUNT(*) FILTER (WHERE first_payment) AS simulated_first_paid_orders,
  COUNT(*) FILTER (WHERE first_payment AND development_exposure_id IS NULL) AS simulated_first_paid_without_exposure_orders,
  COUNT(*) FILTER (WHERE entitlement_granted) AS first_payment_grant_orders,
  COUNT(*) FILTER (WHERE first_payment AND NOT entitlement_granted) AS first_paid_without_grant_orders,
  COUNT(*) FILTER (WHERE saw_payment_failure AND NOT first_payment) AS failed_without_first_payment_orders,
  COUNT(*) FILTER (WHERE first_payment AND saw_refund) AS refunded_first_paid_orders,
  COUNT(*) FILTER (WHERE first_payment AND refund_amount_missing) AS refunded_orders_missing_amount,
  COALESCE(SUM(amount_fen) FILTER (WHERE first_payment), 0) AS simulated_gross_fen,
  COALESCE(SUM(known_refund_amount_fen) FILTER (WHERE first_payment), 0) AS known_simulated_refund_fen,
  COUNT(*) FILTER (WHERE first_payment AND saw_renewal) AS renewed_first_paid_orders
FROM checkout_outcomes
GROUP BY sku, amount_fen, currency
ORDER BY sku, quoted_amount_fen, currency;
