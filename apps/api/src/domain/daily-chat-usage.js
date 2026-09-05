'use strict';

const DAILY_CHAT_ROUND_LIMIT = 100;
const DAILY_BILLED_INPUT_TOKEN_LIMIT = 320000;
const DEFAULT_INPUT_TOKEN_RESERVATION = 3200;

class DailyChatUsageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function reserveDailyChatUsage(store, { accountId, now = new Date(), estimatedInputTokens = DEFAULT_INPUT_TOKEN_RESERVATION } = {}) {
  requireStore(store);
  const usage = mutableUsage(store, accountId, now);
  const reservationTokens = normalizedReservation(estimatedInputTokens);
  if (usage.chat_rounds >= DAILY_CHAT_ROUND_LIMIT) {
    throw new DailyChatUsageError('DAILY_CHAT_LIMIT_REACHED', '今日普通对话次数已达上限，请在明日恢复后继续', detailsFor(usage));
  }
  if (usage.billed_input_tokens + usage.reserved_input_tokens + reservationTokens > DAILY_BILLED_INPUT_TOKEN_LIMIT) {
    throw new DailyChatUsageError('TOKEN_LIMIT_REACHED', '今日输入 Token 额度已达上限，请在明日恢复后继续', detailsFor(usage));
  }
  usage.chat_rounds += 1;
  usage.reserved_input_tokens += reservationTokens;
  usage.updated_at = now.toISOString();
  return Object.freeze({ usage_key: usageKey(accountId, now), account_id: accountId, reservation_tokens: reservationTokens, usage_date: usage.usage_date });
}

function commitDailyChatUsage(store, reservation, { billedInputTokens } = {}) {
  const usage = usageForReservation(store, reservation);
  const committedTokens = normalizedCommittedTokens(billedInputTokens, reservation.reservation_tokens);
  if (committedTokens > reservation.reservation_tokens) {
    throw new DailyChatUsageError('TOKEN_USAGE_EXCEEDS_RESERVATION', '供应商输入 Token 超出本次预留，未提交对话计量', detailsFor(usage));
  }
  if (usage.reserved_input_tokens < reservation.reservation_tokens) {
    throw new DailyChatUsageError('DAILY_USAGE_RESERVATION_INVALID', '普通对话额度预留状态无效', detailsFor(usage));
  }
  usage.reserved_input_tokens -= reservation.reservation_tokens;
  usage.billed_input_tokens += committedTokens;
  usage.updated_at = new Date().toISOString();
  return publicUsage(usage);
}

function releaseDailyChatUsage(store, reservation) {
  const usage = usageForReservation(store, reservation);
  if (usage.reserved_input_tokens < reservation.reservation_tokens || usage.chat_rounds < 1) {
    throw new DailyChatUsageError('DAILY_USAGE_RESERVATION_INVALID', '普通对话额度预留状态无效', detailsFor(usage));
  }
  usage.reserved_input_tokens -= reservation.reservation_tokens;
  usage.chat_rounds -= 1;
  usage.updated_at = new Date().toISOString();
  return publicUsage(usage);
}

function currentDailyChatUsage(store, accountId, now = new Date()) {
  requireStore(store);
  const existing = store.dailyChatUsage.get(usageKey(accountId, now));
  return publicUsage(existing || emptyUsage(accountId, now));
}

function inputTokensFromProviderUsage(usage, fallback) {
  const candidate = usage?.input_tokens ?? usage?.prompt_tokens;
  return Number.isInteger(candidate) && candidate >= 0 ? candidate : fallback;
}

function estimateInputTokens(text) {
  if (typeof text !== 'string' || !text.trim()) return DEFAULT_INPUT_TOKEN_RESERVATION;
  return Math.max(DEFAULT_INPUT_TOKEN_RESERVATION, Math.ceil(Buffer.byteLength(text, 'utf8') / 2) + 1024);
}

function usageKey(accountId, now) {
  if (typeof accountId !== 'string' || !accountId.trim()) throw new DailyChatUsageError('VALIDATION_ERROR', 'accountId 不能为空');
  return `${accountId}:${usageDate(now)}`;
}

function usageDate(now) {
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.getTime())) throw new DailyChatUsageError('VALIDATION_ERROR', 'now 无效');
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

function resetAtForUsageDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 16, 0, 0) + 86400000).toISOString();
}

function mutableUsage(store, accountId, now) {
  const key = usageKey(accountId, now);
  const existing = store.dailyChatUsage.get(key);
  if (existing) return existing;
  const usage = emptyUsage(accountId, now);
  store.dailyChatUsage.set(key, usage);
  return usage;
}

function usageForReservation(store, reservation) {
  requireStore(store);
  if (!reservation || typeof reservation.usage_key !== 'string' || !Number.isInteger(reservation.reservation_tokens) || reservation.reservation_tokens <= 0) {
    throw new DailyChatUsageError('DAILY_USAGE_RESERVATION_INVALID', '普通对话额度预留无效');
  }
  const usage = store.dailyChatUsage.get(reservation.usage_key);
  if (!usage || usage.account_id !== reservation.account_id) throw new DailyChatUsageError('DAILY_USAGE_RESERVATION_INVALID', '普通对话额度预留不存在');
  return usage;
}

function emptyUsage(accountId, now) {
  return { account_id: accountId, usage_date: usageDate(now), chat_rounds: 0, billed_input_tokens: 0, reserved_input_tokens: 0, updated_at: now.toISOString() };
}

function publicUsage(usage) {
  return Object.freeze({
    usage_date: usage.usage_date,
    chat_rounds: usage.chat_rounds,
    billed_input_tokens: usage.billed_input_tokens,
    reserved_input_tokens: usage.reserved_input_tokens,
    remaining_chat_rounds: DAILY_CHAT_ROUND_LIMIT - usage.chat_rounds,
    remaining_billed_input_tokens: DAILY_BILLED_INPUT_TOKEN_LIMIT - usage.billed_input_tokens - usage.reserved_input_tokens,
    resets_at: resetAtForUsageDate(usage.usage_date)
  });
}

function detailsFor(usage) { return publicUsage(usage); }
function normalizedReservation(value) {
  if (!Number.isInteger(value) || value <= 0 || value > DAILY_BILLED_INPUT_TOKEN_LIMIT) throw new DailyChatUsageError('VALIDATION_ERROR', '预留输入 Token 无效');
  return value;
}
function normalizedCommittedTokens(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new DailyChatUsageError('TOKEN_USAGE_INVALID', '供应商输入 Token 无效');
  return value;
}
function requireStore(store) {
  if (!store || !(store.dailyChatUsage instanceof Map)) throw new TypeError('dailyChatUsage Map is required');
}

module.exports = {
  DAILY_BILLED_INPUT_TOKEN_LIMIT,
  DAILY_CHAT_ROUND_LIMIT,
  DEFAULT_INPUT_TOKEN_RESERVATION,
  DailyChatUsageError,
  commitDailyChatUsage,
  currentDailyChatUsage,
  estimateInputTokens,
  inputTokensFromProviderUsage,
  releaseDailyChatUsage,
  reserveDailyChatUsage,
  usageDate,
  usageKey
};
