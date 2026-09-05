'use strict';

const { createSummary, supersedeActiveSummaries, validSummary } = require('./conversation-summary');

const SUMMARY_PROMPT_VERSION = 'conversation-summary.v1';
const COMPLETED_TURN_MESSAGE_THRESHOLD = 60;
const MAX_SUMMARY_JOB_ATTEMPTS = 8;

function enqueueConversationSummary({ store, account, conversation, now = new Date() }) {
  const messages = messagesForConversation(store, conversation.conversation_id);
  const previous = validSummary([...store.conversationSummaries.values()], messages, conversation.conversation_id, account.revocation_epoch, now.toISOString());
  const pending = previous ? messagesAfter(messages, previous.source_to_id) : messages;
  if (pending.length < COMPLETED_TURN_MESSAGE_THRESHOLD || pending.length % COMPLETED_TURN_MESSAGE_THRESHOLD !== 0) return null;
  const sourceToId = pending.at(-1).message_id;
  const existing = [...store.conversationSummaryJobs.values()].find((job) => job.conversation_id === conversation.conversation_id && job.source_to_id === sourceToId && ['PENDING', 'PROCESSING'].includes(job.state));
  if (existing) return existing;
  const job = Object.freeze({ job_id: store.next('sumjob'), account_id: account.account_id, conversation_id: conversation.conversation_id, source_to_id: sourceToId, captured_revocation_epoch: account.revocation_epoch, state: 'PENDING', attempt_count: 0, next_attempt_at: now.toISOString(), last_error: null, created_at: now.toISOString(), completed_at: null });
  store.conversationSummaryJobs.set(job.job_id, job);
  if (store.outboxEvents) {
    const event = Object.freeze({ event_id: store.next('evt'), account_id: account.account_id, character_id: conversation.character_id || null, aggregate_type: 'CONVERSATION_SUMMARY_JOB', aggregate_id: job.job_id, event_type: 'conversation.summary_requested.v1', payload: { conversation_id: conversation.conversation_id, source_to_id: sourceToId, captured_revocation_epoch: account.revocation_epoch }, occurred_at: now.toISOString() });
    store.outboxEvents.set(event.event_id, event);
  }
  return job;
}

async function runNextConversationSummaryJob({ store, summaryGenerator, now = new Date() }) {
  if (typeof summaryGenerator !== 'function') return { state: 'DISABLED' };
  const job = [...store.conversationSummaryJobs.values()].filter((item) => item.state === 'PENDING' && !item.exhausted_at && item.next_attempt_at <= now.toISOString()).sort((a, b) => a.created_at < b.created_at ? -1 : 1)[0];
  if (!job) return { state: 'IDLE' };
  store.conversationSummaryJobs.set(job.job_id, Object.freeze({ ...job, state: 'PROCESSING', attempt_count: job.attempt_count + 1, last_error: null }));
  try {
    const summary = await createSummaryForJob({ store, job, summaryGenerator, now });
    if (!summary) {
      const cancelled = Object.freeze({ ...store.conversationSummaryJobs.get(job.job_id), state: 'CANCELLED', completed_at: now.toISOString() });
      store.conversationSummaryJobs.set(job.job_id, cancelled);
      return { state: 'CANCELLED', job_id: job.job_id };
    }
    const completed = Object.freeze({ ...store.conversationSummaryJobs.get(job.job_id), state: 'COMPLETED', completed_at: now.toISOString() });
    store.conversationSummaryJobs.set(job.job_id, completed);
    return { state: 'COMPLETED', job_id: job.job_id, summary, provider: summary.provider, modelVersion: summary.modelVersion, usage: summary.usage || null };
  } catch (error) {
    const current = store.conversationSummaryJobs.get(job.job_id);
    if (current.attempt_count >= MAX_SUMMARY_JOB_ATTEMPTS) {
      const exhaustedAt = now.toISOString();
      const exhausted = Object.freeze({ ...current, state: 'PENDING', exhausted_at: exhaustedAt, next_attempt_at: exhaustedAt, last_error: safeError(error) });
      store.conversationSummaryJobs.set(job.job_id, exhausted);
      recordSummaryDeadLetter(store, exhausted, exhaustedAt);
      return { state: 'DLQ', job_id: job.job_id };
    }
    const retrySeconds = Math.min(3600, 2 ** Math.min(current.attempt_count, 12));
    store.conversationSummaryJobs.set(job.job_id, Object.freeze({ ...current, state: 'PENDING', next_attempt_at: new Date(now.getTime() + retrySeconds * 1000).toISOString(), last_error: safeError(error) }));
    return { state: 'RETRY_SCHEDULED', job_id: job.job_id };
  }
}

function recordSummaryDeadLetter(store, job, occurredAt) {
  const existing = [...store.conversationSummaryDeadLetters.values()].find((item) => item.job_id === job.job_id);
  const deadLetter = Object.freeze({
    dead_letter_id: existing?.dead_letter_id || store.next('sumdlq'),
    job_id: job.job_id, account_id: job.account_id, conversation_id: job.conversation_id, source_to_id: job.source_to_id,
    attempt_count: job.attempt_count, error_code: 'SUMMARY_GENERATION_FAILED', occurred_at: existing?.occurred_at || occurredAt,
    state: 'OPEN', replay_count: existing?.replay_count || 0, last_replayed_at: existing?.last_replayed_at || null,
    last_replayed_by: existing?.last_replayed_by || null, last_replay_reason_sha256: existing?.last_replay_reason_sha256 || null
  });
  store.conversationSummaryDeadLetters.set(deadLetter.dead_letter_id, deadLetter);
  return deadLetter;
}

function replayConversationSummaryDeadLetter({ store, jobId, reviewerId, reasonHash, now = new Date() }) {
  const deadLetter = [...store.conversationSummaryDeadLetters.values()].find((item) => item.job_id === jobId);
  if (!deadLetter) return { state: 'NOT_FOUND' };
  if (deadLetter.replay_count >= 1) return { state: 'REPLAY_LIMIT_REACHED', dead_letter: deadLetter };
  const job = store.conversationSummaryJobs.get(jobId);
  if (!job || !job.exhausted_at) return { state: 'NOT_EXHAUSTED', dead_letter: deadLetter };
  if (!validReplaySource(store, job)) return { state: 'SOURCE_REVOKED', dead_letter: deadLetter };
  const replayedAt = now.toISOString();
  const replayed = Object.freeze({ ...job, state: 'PENDING', exhausted_at: null, completed_at: null, next_attempt_at: replayedAt, last_error: 'manual summary DLQ replay requested' });
  const updatedDeadLetter = Object.freeze({
    ...deadLetter, state: 'REPLAYED', replay_count: deadLetter.replay_count + 1, last_replayed_at: replayedAt,
    last_replayed_by: reviewerId, last_replay_reason_sha256: reasonHash
  });
  store.conversationSummaryJobs.set(jobId, replayed);
  store.conversationSummaryDeadLetters.set(updatedDeadLetter.dead_letter_id, updatedDeadLetter);
  if (store.outboxEvents) {
    const event = Object.freeze({
      event_id: store.next('evt'), account_id: replayed.account_id, character_id: store.conversations.get(replayed.conversation_id)?.character_id || null,
      aggregate_type: 'CONVERSATION_SUMMARY_JOB', aggregate_id: replayed.job_id, event_type: 'conversation.summary_dlq_replayed.v1',
      payload: { conversation_id: replayed.conversation_id, source_to_id: replayed.source_to_id, replay_count: updatedDeadLetter.replay_count },
      occurred_at: replayedAt
    });
    store.outboxEvents.set(event.event_id, event);
  }
  return { state: 'REPLAY_SCHEDULED', summary_job: replayed, dead_letter: updatedDeadLetter };
}

function validReplaySource(store, job) {
  const account = store.accounts.get(job.account_id);
  const conversation = store.conversations.get(job.conversation_id);
  if (!account || account.account_status !== 'OPEN' || !conversation || conversation.status === 'DELETED' || account.revocation_epoch !== job.captured_revocation_epoch) return false;
  return [...store.messages.values()].some((message) => message.conversation_id === job.conversation_id && message.message_id === job.source_to_id && !message.deleted_at);
}

async function createSummaryForJob({ store, job, summaryGenerator, now }) {
  const account = store.accounts.get(job.account_id);
  const conversation = store.conversations.get(job.conversation_id);
  if (!account || !conversation || account.account_status !== 'OPEN' || conversation.status === 'DELETED' || account.revocation_epoch !== job.captured_revocation_epoch) return null;
  const allMessages = messagesForConversation(store, job.conversation_id);
  const endIndex = allMessages.findIndex((message) => message.message_id === job.source_to_id);
  if (endIndex < 0) return null;
  const source = allMessages.slice(0, endIndex + 1);
  const previous = validSummary([...store.conversationSummaries.values()], allMessages, job.conversation_id, account.revocation_epoch, now.toISOString());
  const pending = previous ? messagesAfter(source, previous.source_to_id) : source;
  if (pending.length !== COMPLETED_TURN_MESSAGE_THRESHOLD) return null;
  const result = await summaryGenerator({
    conversationId: job.conversation_id,
    previousSummary: previous ? previous.text : null,
    messages: pending.map(({ message_id, actor, text }) => ({ message_id, actor, text }))
  });
  if (!result || typeof result.text !== 'string' || !result.text.trim() || !result.provider || !result.modelVersion) throw new TypeError('conversation summary generator returned invalid result');
  // Commit-time checks are deliberate: a summary is derived data and must lose
  // to a deletion/revocation which happened while its model call was in flight.
  const current = messagesForConversation(store, job.conversation_id);
  if (account.account_status !== 'OPEN' || account.revocation_epoch !== job.captured_revocation_epoch || conversation.status === 'DELETED' || current.findIndex((message) => message.message_id === job.source_to_id) < 0) return null;
  const createdAt = now.toISOString();
  const currentSource = current.slice(0, current.findIndex((message) => message.message_id === job.source_to_id) + 1);
  const retentionExpiresAt = earliestRetentionExpiry(currentSource, account.raw_interaction_retention_days, now);
  const summary = createSummary({
    summaryId: store.next('sum'), accountId: account.account_id, conversationId: job.conversation_id,
    messages: currentSource, revocationEpoch: job.captured_revocation_epoch, text: result.text,
    modelRouteId: result.modelVersion, promptVersion: result.promptVersion || SUMMARY_PROMPT_VERSION,
    retentionExpiresAt, createdAt
  });
  for (const superseded of supersedeActiveSummaries([...store.conversationSummaries.values()], job.conversation_id, createdAt)) {
    store.conversationSummaries.set(superseded.summary_id, superseded);
  }
  store.conversationSummaries.set(summary.summary_id, summary);
  return { summary, provider: result.provider, modelVersion: result.modelVersion, usage: result.usage || null };
}

function messagesForConversation(store, conversationId) {
  return [...store.messages.values()].filter((message) => message.conversation_id === conversationId && !message.deleted_at)
    .sort((a, b) => a.created_at === b.created_at ? String(a.message_id).localeCompare(String(b.message_id)) : a.created_at < b.created_at ? -1 : 1);
}
function messagesAfter(messages, messageId) {
  const index = messages.findIndex((message) => message.message_id === messageId);
  return index < 0 ? [] : messages.slice(index + 1);
}
function earliestRetentionExpiry(messages, days, now) {
  const expiries = messages.map((message) => message.retention_expires_at).filter(Boolean).sort();
  return expiries[0] || new Date(now.getTime() + (Number.isInteger(days) ? days : 90) * 86400000).toISOString();
}
function safeError(error) { return String(error?.message || 'conversation summary worker failed').replace(/[\r\n\t]+/g, ' ').slice(0, 1000); }
function cancelConversationSummaryJobs(store, conversationId, now = new Date().toISOString()) {
  for (const job of store.conversationSummaryJobs.values()) {
    if (job.conversation_id !== conversationId || !['PENDING', 'PROCESSING'].includes(job.state)) continue;
    store.conversationSummaryJobs.set(job.job_id, Object.freeze({ ...job, state: 'CANCELLED', completed_at: now, last_error: 'source messages were revoked before summary generation' }));
  }
}
function startConversationSummaryWorker(store, summaryGenerator, { intervalMs = 5_000, clock = () => new Date() } = {}) {
  if (typeof summaryGenerator !== 'function') return { stop() {} };
  const run = () => runNextConversationSummaryJob({ store, summaryGenerator, now: clock() }).catch(() => {});
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), runOnce: run };
}

module.exports = { COMPLETED_TURN_MESSAGE_THRESHOLD, MAX_SUMMARY_JOB_ATTEMPTS, SUMMARY_PROMPT_VERSION, cancelConversationSummaryJobs, createSummaryForJob, enqueueConversationSummary, replayConversationSummaryDeadLetter, runNextConversationSummaryJob, startConversationSummaryWorker };
