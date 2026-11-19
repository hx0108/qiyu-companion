WITH events AS (
  SELECT event.account_id, event.event_type, event.entry_surface, event.client_build, event.received_at,
    event.client_observed_at,
    event.received_at - event.client_observed_at AS arrival_delta
  FROM trial_behavior_events AS event
  JOIN trial_invites AS invite ON invite.account_id = event.account_id
  WHERE event.received_at >= GREATEST($1::timestamptz, $2::timestamptz - INTERVAL '30 days')
    AND event.action_kind = 'VIEW'
    AND event.received_at < $2::timestamptz
    AND event.received_at >= invite.first_claimed_at
)
SELECT event_type, entry_surface, client_build, COUNT(*) AS received_events, COUNT(DISTINCT account_id) AS accounts,
  COUNT(*) FILTER (WHERE client_observed_at IS NULL) AS missing_metadata_events,
  COUNT(*) FILTER (WHERE arrival_delta < INTERVAL '0 seconds' OR arrival_delta > INTERVAL '24 hours') AS unusable_client_clock_events,
  COUNT(*) FILTER (WHERE arrival_delta > INTERVAL '5 seconds' AND arrival_delta <= INTERVAL '24 hours') AS delayed_events
FROM events
GROUP BY event_type, entry_surface, client_build
ORDER BY event_type, entry_surface NULLS LAST, client_build NULLS LAST;
