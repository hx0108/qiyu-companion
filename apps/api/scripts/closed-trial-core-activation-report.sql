WITH mature AS (
  SELECT account_id, first_claimed_at AS window_start, first_claimed_at + INTERVAL '24 hours' AS window_end
  FROM trial_invites
  WHERE account_id IS NOT NULL AND $4::timestamptz IS NOT NULL
    AND first_claimed_at >= GREATEST($1::timestamptz, $4::timestamptz)
    AND first_claimed_at < $2::timestamptz
    AND first_claimed_at + INTERVAL '24 hours' <= $3::timestamptz
), turns AS (
  SELECT DISTINCT ON (mature.account_id, source.message_id) mature.account_id, conversation.character_id,
    source.message_id AS source_id, timing.modality, timing.session_key, timing.started_at, timing.completed_at
  FROM mature
  JOIN conversations AS conversation ON conversation.account_id = mature.account_id
  JOIN messages AS reply ON reply.conversation_id = conversation.conversation_id
  JOIN messages AS source ON source.message_id = reply.effective_chat_source_id
    AND source.conversation_id = conversation.conversation_id
  LEFT JOIN call_turns AS voice ON voice.call_session_id = source.call_session_id
    AND voice.account_id = mature.account_id AND voice.user_message_id = source.message_id
    AND voice.assistant_message_id = reply.message_id AND voice.state = 'COMPLETED' AND NOT voice.interrupted
  CROSS JOIN LATERAL (
    SELECT
      CASE WHEN source.call_session_id IS NOT NULL THEN 'CALL'
        WHEN source.provider = 'volcengine-realtime' THEN 'REALTIME' ELSE 'TEXT' END AS modality,
      CASE WHEN source.call_session_id IS NOT NULL THEN source.call_session_id::text
        WHEN source.provider = 'volcengine-realtime' THEN reply.effective_chat_session_key::text
        ELSE conversation.conversation_id::text END AS session_key,
      CASE WHEN source.call_session_id IS NOT NULL THEN voice.created_at
        WHEN source.provider = 'volcengine-realtime' THEN reply.effective_chat_started_at
        ELSE source.created_at END AS started_at,
      CASE WHEN source.call_session_id IS NOT NULL THEN voice.ended_at ELSE reply.created_at END AS completed_at
  ) AS timing
  WHERE conversation.status <> 'DELETED' AND conversation.deleted_at IS NULL
    AND source.actor = 'USER' AND source.deleted_at IS NULL AND reply.deleted_at IS NULL
    AND COALESCE(timing.started_at, source.created_at) >= mature.window_start
    AND timing.completed_at >= COALESCE(timing.started_at, source.created_at)
    AND timing.completed_at < mature.window_end
  ORDER BY mature.account_id, source.message_id, timing.completed_at, reply.message_id
), six_turn_sessions AS (
  SELECT account_id
  FROM turns
  WHERE session_key IS NOT NULL
  GROUP BY account_id, character_id, modality, session_key
  HAVING COUNT(*) >= 6
), relationship_followthrough AS (
  SELECT event.account_id
  FROM mature
  JOIN trial_behavior_events AS event ON event.account_id = mature.account_id
    AND event.received_at >= mature.window_start AND event.received_at < mature.window_end
  JOIN turns ON turns.account_id = event.account_id AND turns.character_id = event.character_id
    AND turns.started_at >= event.received_at
    AND (turns.completed_at AT TIME ZONE 'Asia/Shanghai')::date = (event.received_at AT TIME ZONE 'Asia/Shanghai')::date
  WHERE event.event_type = 'relationship_action'
  GROUP BY event.account_id, event.event_id
  HAVING COUNT(*) >= 2
), core_accounts AS (
  SELECT account_id FROM six_turn_sessions
  UNION
  SELECT account_id FROM relationship_followthrough
)
SELECT
  (SELECT COUNT(*) FROM mature) AS mature_accounts,
  (SELECT COUNT(DISTINCT account_id) FROM turns) AS first_effective_any_accounts,
  (SELECT COUNT(DISTINCT account_id) FROM six_turn_sessions) AS six_turn_session_accounts,
  (SELECT COUNT(DISTINCT account_id) FROM relationship_followthrough) AS relationship_two_turn_accounts,
  (SELECT COUNT(*) FROM core_accounts) AS core_interaction_accounts;
