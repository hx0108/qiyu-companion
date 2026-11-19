WITH cohort AS (
  SELECT account_id, first_claimed_at
  FROM trial_invites
  WHERE account_id IS NOT NULL
    AND first_claimed_at >= GREATEST($1::timestamptz, $4::timestamptz)
    AND first_claimed_at < $2::timestamptz
    AND first_claimed_at <= $3::timestamptz
    AND $4::timestamptz IS NOT NULL
), mature AS (
  SELECT * FROM cohort WHERE first_claimed_at + INTERVAL '24 hours' <= $3::timestamptz
), window_turn_counts AS (
  SELECT mature.account_id, conversation.conversation_id,
    COUNT(DISTINCT source.message_id) AS effective_turns,
    MIN(reply.created_at) AS first_reply_at
  FROM mature
  JOIN conversations AS conversation ON conversation.account_id = mature.account_id
  JOIN messages AS reply ON reply.conversation_id = conversation.conversation_id
  JOIN messages AS source ON source.message_id = reply.effective_chat_source_id
    AND source.conversation_id = reply.conversation_id
  WHERE conversation.status <> 'DELETED'
    AND conversation.deleted_at IS NULL
    AND source.actor = 'USER'
    AND source.call_session_id IS NULL
    AND source.provider IS DISTINCT FROM 'volcengine-realtime'
    AND source.deleted_at IS NULL
    AND reply.deleted_at IS NULL
    AND source.created_at >= mature.first_claimed_at
    AND reply.created_at >= source.created_at
    AND reply.created_at < mature.first_claimed_at + INTERVAL '24 hours'
  GROUP BY mature.account_id, conversation.conversation_id
), account_turn_counts AS (
  SELECT account_id, MAX(effective_turns) AS longest_conversation, MIN(first_reply_at) AS first_reply_at
  FROM window_turn_counts
  GROUP BY account_id
)
SELECT
  (SELECT COUNT(*) FROM cohort) AS access_activated_accounts,
  COUNT(*) AS mature_accounts,
  COUNT(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM characters AS character
    WHERE character.account_id = mature.account_id
      AND character.status IN ('ACTIVE', 'ARCHIVED')
      AND character.deleted_at IS NULL
      AND character.created_at >= mature.first_claimed_at
      AND character.created_at < mature.first_claimed_at + INTERVAL '24 hours'
  )) AS character_ready_accounts,
  COUNT(*) FILTER (WHERE longest_conversation >= 1) AS first_chat_activated_accounts,
  COUNT(*) FILTER (WHERE longest_conversation >= 6) AS six_turn_conversation_accounts,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (first_reply_at - mature.first_claimed_at))::double precision
  ))::bigint AS median_seconds_to_first_text_reply
FROM mature
LEFT JOIN account_turn_counts USING (account_id);
