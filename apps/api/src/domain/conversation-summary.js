'use strict';

const { createHash } = require('node:crypto');

const MAX_SUMMARY_CHARACTERS = 4_000;

function createSummary({ summaryId, accountId, conversationId, messages, revocationEpoch, text, modelRouteId, promptVersion, retentionExpiresAt, createdAt = new Date().toISOString() }) {
  if (!summaryId || !accountId || !conversationId || !Array.isArray(messages) || messages.length === 0 || !Number.isInteger(revocationEpoch) || typeof text !== 'string' || !text.trim() || text.trim().length > MAX_SUMMARY_CHARACTERS || !modelRouteId || !promptVersion || !retentionExpiresAt) throw new TypeError('invalid conversation summary input');
  const source = messages.filter((item) => item && item.message_id && item.conversation_id === conversationId && !item.deleted_at);
  if (source.length !== messages.length) throw new TypeError('summary sources must be active messages in one conversation');
  const ordered = [...source].sort(chronological);
  return Object.freeze({ summary_id: summaryId, account_id: accountId, conversation_id: conversationId, source_from_id: ordered[0].message_id, source_to_id: ordered.at(-1).message_id, source_checksum: checksum(ordered), revocation_epoch: revocationEpoch, text: text.trim(), model_route_id: modelRouteId, prompt_version: promptVersion, retention_expires_at: retentionExpiresAt, state: 'ACTIVE', created_at: createdAt, invalidated_at: null });
}

function validSummary(summaries, messages, conversationId, revocationEpoch, now = new Date().toISOString()) {
  return [...summaries].filter((summary) => summary.conversation_id === conversationId && summary.state === 'ACTIVE' && summary.revocation_epoch === revocationEpoch && summary.retention_expires_at > now)
    .filter((summary) => checksum(sourceRange(messages, conversationId, summary.source_from_id, summary.source_to_id)) === summary.source_checksum)
    .sort((a, b) => a.created_at < b.created_at ? 1 : -1)[0] || null;
}

function invalidateSummaries(summaries, messages, conversationId, deletedMessageIds, now = new Date().toISOString()) {
  const deleted = new Set(deletedMessageIds);
  return summaries.map((summary) => summary.conversation_id === conversationId && summary.state === 'ACTIVE' && sourceRange(messages, conversationId, summary.source_from_id, summary.source_to_id).some((message) => deleted.has(message.message_id)) ? Object.freeze({ ...summary, state: 'INVALIDATED', invalidated_at: now }) : summary);
}
function supersedeActiveSummaries(summaries, conversationId, now = new Date().toISOString()) {
  return summaries.map((summary) => summary.conversation_id === conversationId && summary.state === 'ACTIVE'
    ? Object.freeze({ ...summary, state: 'SUPERSEDED', superseded_at: now }) : summary);
}
function sourceRange(messages, conversationId, from, to) { const list = [...messages].filter((m) => m.conversation_id === conversationId && !m.deleted_at).sort(chronological); const start = list.findIndex((m) => m.message_id === from); const end = list.findIndex((m) => m.message_id === to); return start < 0 || end < start ? [] : list.slice(start, end + 1); }
function checksum(messages) { return createHash('sha256').update(messages.map((m) => `${m.message_id}:${m.actor}:${m.text}`).join('\n')).digest('hex'); }
function chronological(a, b) { return a.created_at === b.created_at ? String(a.message_id).localeCompare(String(b.message_id)) : a.created_at < b.created_at ? -1 : 1; }
module.exports = { MAX_SUMMARY_CHARACTERS, createSummary, invalidateSummaries, supersedeActiveSummaries, validSummary };
