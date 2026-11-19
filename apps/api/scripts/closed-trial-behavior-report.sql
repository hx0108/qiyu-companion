WITH activity AS (
  SELECT event.account_id, event.event_id, event.character_id, event.event_type, event.action_kind, event.received_at
  FROM trial_behavior_events AS event
  JOIN trial_invites AS invite ON invite.account_id = event.account_id
  WHERE event.received_at >= GREATEST($1::timestamptz, $2::timestamptz - INTERVAL '30 days')
    AND event.received_at < $2::timestamptz
    AND event.received_at >= invite.first_claimed_at
), relationship_followthrough AS (
  SELECT activity.account_id, activity.action_kind, followthrough.text_turns, followthrough.all_turns
  FROM activity
  CROSS JOIN LATERAL (
    SELECT COUNT(DISTINCT source.message_id) FILTER (WHERE timing.modality = 'TEXT') AS text_turns,
      COUNT(DISTINCT source.message_id) AS all_turns
    FROM conversations AS conversation
    JOIN messages AS reply ON reply.conversation_id = conversation.conversation_id
    JOIN messages AS source ON source.message_id = reply.effective_chat_source_id
      AND source.conversation_id = conversation.conversation_id
    LEFT JOIN call_turns AS voice ON voice.call_session_id = source.call_session_id
      AND voice.account_id = activity.account_id AND voice.user_message_id = source.message_id
      AND voice.assistant_message_id = reply.message_id AND voice.state = 'COMPLETED' AND NOT voice.interrupted
    CROSS JOIN LATERAL (
      SELECT CASE WHEN source.call_session_id IS NOT NULL THEN voice.created_at
          WHEN source.provider = 'volcengine-realtime' THEN reply.effective_chat_started_at
          ELSE source.created_at END AS started_at,
        CASE WHEN source.call_session_id IS NOT NULL THEN voice.ended_at ELSE reply.created_at END AS completed_at,
        CASE WHEN source.call_session_id IS NULL AND source.provider IS DISTINCT FROM 'volcengine-realtime'
          THEN 'TEXT' ELSE 'VOICE' END AS modality
    ) AS timing
    WHERE conversation.account_id = activity.account_id
      AND conversation.character_id = activity.character_id
      AND conversation.status <> 'DELETED'
      AND conversation.deleted_at IS NULL
      AND source.actor = 'USER'
      AND source.deleted_at IS NULL
      AND reply.deleted_at IS NULL
      AND timing.started_at >= activity.received_at
      AND timing.completed_at >= timing.started_at
      AND timing.completed_at < $2::timestamptz
      AND (timing.completed_at AT TIME ZONE 'Asia/Shanghai')::date =
          (activity.received_at AT TIME ZONE 'Asia/Shanghai')::date
  ) AS followthrough
  WHERE activity.event_type = 'relationship_action' AND followthrough.all_turns >= 2
)
SELECT
  COUNT(DISTINCT account_id) FILTER (WHERE event_type = 'relationship_action' AND action_kind = 'VIEW') AS timeline_view_accounts,
  COUNT(DISTINCT account_id) FILTER (WHERE action_kind = 'PROCESS') AS timeline_process_accounts,
  COUNT(DISTINCT account_id) FILTER (WHERE event_type = 'access_info_viewed') AS access_info_view_accounts,
  (SELECT COUNT(DISTINCT account_id) FROM relationship_followthrough WHERE action_kind = 'VIEW' AND text_turns >= 2) AS relationship_followthrough_accounts,
  (SELECT COUNT(DISTINCT account_id) FROM relationship_followthrough WHERE action_kind = 'PROCESS' AND text_turns >= 2) AS processing_followthrough_accounts,
  (SELECT COUNT(DISTINCT account_id) FROM relationship_followthrough WHERE action_kind = 'VIEW') AS relationship_any_followthrough_accounts,
  (SELECT COUNT(DISTINCT account_id) FROM relationship_followthrough WHERE action_kind = 'PROCESS') AS processing_any_followthrough_accounts
FROM activity;
