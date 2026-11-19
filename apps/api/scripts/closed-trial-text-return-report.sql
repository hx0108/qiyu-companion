WITH accounts AS (
  SELECT account_id, first_claimed_at
  FROM trial_invites
  WHERE first_claimed_at >= GREATEST($1::timestamptz, $4::timestamptz)
    AND first_claimed_at < LEAST($2::timestamptz, $3::timestamptz)
    AND $4::timestamptz IS NOT NULL
), turns AS (
  SELECT account.account_id, MIN(reply.created_at) AS completed_at
  FROM accounts AS account
  JOIN conversations AS conversation ON conversation.account_id = account.account_id
  JOIN messages AS reply ON reply.conversation_id = conversation.conversation_id
  JOIN messages AS source ON source.message_id = reply.effective_chat_source_id
    AND source.conversation_id = conversation.conversation_id
  WHERE conversation.status <> 'DELETED' AND conversation.deleted_at IS NULL
    AND source.actor = 'USER' AND source.deleted_at IS NULL AND reply.deleted_at IS NULL
    AND source.call_session_id IS NULL AND source.provider IS DISTINCT FROM 'volcengine-realtime'
    AND source.created_at >= account.first_claimed_at
    AND reply.created_at >= source.created_at AND reply.created_at < $3::timestamptz
  GROUP BY account.account_id, source.message_id
), first_chat AS (
  SELECT account_id, (MIN(completed_at) AT TIME ZONE 'Asia/Shanghai')::date AS first_chat_day
  FROM turns GROUP BY account_id
), account_return AS (
  SELECT first_chat.account_id, first_chat.first_chat_day,
    BOOL_OR((turns.completed_at AT TIME ZONE 'Asia/Shanghai')::date = first_chat_day + 7) AS day7_return,
    BOOL_OR((turns.completed_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN first_chat_day + 29 AND first_chat_day + 35) AS days29_to35_return
  FROM first_chat JOIN turns USING (account_id)
  GROUP BY first_chat.account_id, first_chat.first_chat_day
)
SELECT
  COUNT(*) AS first_text_chat_accounts,
  COUNT(*) FILTER (WHERE first_chat_day + 8 <= ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date) AS mature_day7_accounts,
  COUNT(*) FILTER (WHERE first_chat_day + 8 <= ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date AND day7_return) AS day7_text_return_accounts,
  COUNT(*) FILTER (WHERE first_chat_day + 36 <= ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date) AS mature_days29_to35_accounts,
  COUNT(*) FILTER (WHERE first_chat_day + 36 <= ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date AND days29_to35_return) AS days29_to35_text_return_accounts
FROM account_return;
