-- Run as the database operator after disabling V2 ingestion and stopping its
-- Worker. Keep migration 071 and the existing account choices for image rollback.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

WITH paused AS (
  UPDATE relationship_assets
  SET state = 'PENDING'
  WHERE activation_actor = 'SYSTEM' AND automatic_policy_version = 'v2' AND state = 'ACTIVE'
  RETURNING account_id
), affected AS (
  SELECT DISTINCT account_id FROM paused
)
UPDATE accounts
SET revocation_epoch = revocation_epoch + 1
FROM affected
WHERE accounts.account_id = affected.account_id;

UPDATE automatic_memory_jobs
SET state = 'CANCELLED', lease_id = NULL, result_code = 'V2_ROLLBACK'
WHERE state IN ('PENDING', 'PROCESSING');
COMMIT;
