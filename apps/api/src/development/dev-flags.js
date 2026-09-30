'use strict';

// 六项能力开发开关（六项能力实施方案 §8）。与 src/production/feature-flags.js
// 完全分离：那是生产 provider capability 注册表（开了就必须有已批准绑定），
// 这里只服务内部开发功能的开/关与账户白名单，默认全关；开启与否不改变
// production/startup.js 的启动保护（合成组合仍不得服务生产流量）。
// API（server.js）与独立 Worker（scripts/run-workers.js）各自解析一次环境并下传，
// 保证同一进程内只有一个开关来源。
const DEV_FLAG_NAMES = Object.freeze([
  'LIFE_EVENTS',
  'FOLLOWUP_DISPATCH',
  'MEMORY_REFERENCES',
  'COMPANION_PLANS',
  'ARTIFACT_CARDS',
  'ACTION_EXECUTION',
]);

function safeDevFlags() {
  const enabled = {};
  for (const name of DEV_FLAG_NAMES) enabled[name] = false;
  return { enabled, accounts: null };
}

// QIYU_DEV_FLAGS="LIFE_EVENTS,MEMORY_REFERENCES"：逗号/中文逗号/空白分隔，未知名称忽略。
// QIYU_DEV_FLAG_ACCOUNTS="acct_dev_alice acct_dev_bob"：非空时仅白名单账户生效；空=开关全局。
function parseDevFlags(environment = process.env) {
  const enabled = {};
  for (const name of DEV_FLAG_NAMES) enabled[name] = false;
  const rawFlags = String((environment && environment.QIYU_DEV_FLAGS) || '').trim();
  for (const token of rawFlags.split(/[,，\s]+/u).filter(Boolean)) {
    if (Object.prototype.hasOwnProperty.call(enabled, token)) enabled[token] = true;
  }
  const rawAccounts = String((environment && environment.QIYU_DEV_FLAG_ACCOUNTS) || '').trim();
  const accounts = rawAccounts ? new Set(rawAccounts.split(/[,，\s]+/u).filter(Boolean)) : null;
  return { enabled, accounts };
}

function devFlagEnabled(parsed, name, accountId) {
  if (!parsed || !parsed.enabled || parsed.enabled[name] !== true) return false;
  if (parsed.accounts && parsed.accounts.size > 0 && !parsed.accounts.has(accountId)) return false;
  return true;
}

module.exports = { DEV_FLAG_NAMES, safeDevFlags, parseDevFlags, devFlagEnabled };
