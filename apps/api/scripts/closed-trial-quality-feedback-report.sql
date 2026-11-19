SELECT feedback.type, feedback.severity,
  COUNT(*) AS submissions,
  COUNT(DISTINCT feedback.account_id) AS reporting_accounts
FROM message_feedback AS feedback
JOIN trial_invites AS invite ON invite.account_id = feedback.account_id
WHERE invite.first_claimed_at <= feedback.created_at
  AND feedback.created_at >= $1::timestamptz
  AND feedback.created_at < $2::timestamptz
  AND feedback.type IN ('OOC', 'MEMORY_ERROR')
GROUP BY feedback.type, feedback.severity
ORDER BY feedback.type, feedback.severity;
