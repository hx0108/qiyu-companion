WITH cohort AS (
  SELECT account_id, first_claimed_at
  FROM trial_invites
  WHERE account_id IS NOT NULL AND $4::timestamptz IS NOT NULL
    AND first_claimed_at >= GREATEST($1::timestamptz, $4::timestamptz)
    AND first_claimed_at < $2::timestamptz
    AND first_claimed_at + INTERVAL '24 hours' <= $3::timestamptz
), paired AS (
  SELECT cohort.account_id, cohort.first_claimed_at, reply.message_id AS reply_id,
    source.message_id AS source_id, source.call_session_id,
    CASE WHEN source.provider = 'volcengine-realtime' AND source.call_session_id IS NULL
      THEN reply.created_at END AS realtime_completed_at
  FROM cohort
  JOIN conversations AS conversation ON conversation.account_id = cohort.account_id
  JOIN messages AS reply ON reply.conversation_id = conversation.conversation_id
  JOIN messages AS source ON source.message_id = reply.effective_chat_source_id
    AND source.conversation_id = conversation.conversation_id
  WHERE conversation.status <> 'DELETED' AND conversation.deleted_at IS NULL
    AND source.actor = 'USER' AND source.deleted_at IS NULL AND reply.deleted_at IS NULL
    AND (source.call_session_id IS NOT NULL OR source.provider = 'volcengine-realtime')
    AND source.created_at >= cohort.first_claimed_at
    AND reply.created_at >= source.created_at
    AND reply.created_at < cohort.first_claimed_at + INTERVAL '24 hours'
), completed AS (
  SELECT paired.account_id, paired.source_id,
    paired.call_session_id IS NULL AS native_realtime
  FROM paired
  LEFT JOIN call_turns AS turn ON turn.call_session_id = paired.call_session_id
    AND turn.account_id = paired.account_id AND turn.user_message_id = paired.source_id
    AND turn.assistant_message_id = paired.reply_id AND turn.state = 'COMPLETED' AND NOT turn.interrupted
  WHERE COALESCE(turn.ended_at, paired.realtime_completed_at) < paired.first_claimed_at + INTERVAL '24 hours'
)
SELECT (SELECT COUNT(*) FROM cohort) AS mature_accounts,
  COUNT(DISTINCT account_id) AS first_voice_chat_accounts,
  COUNT(DISTINCT account_id) FILTER (WHERE native_realtime) AS native_realtime_accounts,
  COUNT(DISTINCT account_id) FILTER (WHERE NOT native_realtime) AS ordinary_call_accounts,
  COUNT(DISTINCT source_id) AS effective_voice_turns
FROM completed;
