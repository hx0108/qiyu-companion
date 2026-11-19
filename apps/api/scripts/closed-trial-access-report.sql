SELECT COUNT(DISTINCT account_id) AS access_activated_accounts
FROM trial_invites
WHERE account_id IS NOT NULL
  AND first_claimed_at >= $1
  AND first_claimed_at < $2;
