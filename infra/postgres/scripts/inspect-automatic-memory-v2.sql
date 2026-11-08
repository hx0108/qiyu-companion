-- Read-only rollout check. Run from the database operator role.
-- Output contains aggregate counts only.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';

SELECT mode, state, COALESCE(result_code, '') AS result, count(*) AS jobs
FROM automatic_memory_jobs j
JOIN messages m USING (message_id)
WHERE m.created_at >= CURRENT_TIMESTAMP - interval '15 minutes'
GROUP BY mode, state, result_code
ORDER BY mode, state, result;

SELECT count(*) AS in_flight,
  count(*) FILTER (WHERE j.state = 'PROCESSING' AND j.available_at <= CURRENT_TIMESTAMP) AS expired_leases,
  COALESCE(round(max(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP - m.created_at))), 0) AS oldest_seconds
FROM automatic_memory_jobs j
JOIN messages m USING (message_id)
WHERE j.state IN ('PENDING','PROCESSING');

SELECT count(*) AS active_v2_assets,
  count(*) FILTER (WHERE valid_until IS NOT NULL AND valid_until <= CURRENT_TIMESTAMP) AS expired_v2_assets
FROM relationship_assets
WHERE state = 'ACTIVE' AND activation_actor = 'SYSTEM' AND automatic_policy_version = 'v2';

COMMIT;
