'use strict';

const { invalidateSummaries } = require('./conversation-summary');
const { cancelConversationSummaryJobs } = require('./conversation-summary-worker');
const DEFAULT_RAW_INTERACTION_RETENTION_DAYS = 90;

function applyRawInteractionRetention(store, account, now = new Date()) {
  const days = Number.isInteger(account.raw_interaction_retention_days) ? account.raw_interaction_retention_days : DEFAULT_RAW_INTERACTION_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - days * 86400000).toISOString();
  const expiredMessageIds = new Set();
  const expiredByConversation = new Map();
  for (const [messageId, message] of store.messages.entries()) {
    const conversation = store.conversations.get(message.conversation_id);
    if (conversation?.account_id === account.account_id && message.created_at && message.created_at <= cutoff) {
      expiredMessageIds.add(messageId);
      if (!expiredByConversation.has(message.conversation_id)) expiredByConversation.set(message.conversation_id, []);
      expiredByConversation.get(message.conversation_id).push(messageId);
    }
  }
  // Invalidate before deleting source rows.  After deletion, the source range
  // cannot prove that an interior message was part of a summary.
  const beforeDeletion = [...store.messages.values()];
  for (const [conversationId, messageIds] of expiredByConversation) {
    for (const summary of invalidateSummaries([...store.conversationSummaries.values()], beforeDeletion, conversationId, messageIds, now.toISOString())) store.conversationSummaries.set(summary.summary_id, summary);
    cancelConversationSummaryJobs(store, conversationId, now.toISOString());
  }
  for (const messageId of expiredMessageIds) store.messages.delete(messageId);
  for (const candidate of store.candidates.values()) {
    if (candidate.account_id === account.account_id && candidate.state === 'CANDIDATE' && expiredMessageIds.has(candidate.source_message_id)) {
      candidate.state = 'EXPIRED';
      candidate.expired_at = now.toISOString();
    }
  }
  return { expired_message_count: expiredMessageIds.size, cutoff };
}

module.exports = { DEFAULT_RAW_INTERACTION_RETENTION_DAYS, applyRawInteractionRetention };
