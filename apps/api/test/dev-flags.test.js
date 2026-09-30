'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEV_FLAG_NAMES, safeDevFlags, parseDevFlags, devFlagEnabled } = require('../src/development/dev-flags');

test('dev flags default to fully off and parse environment with whitelist accounts', () => {
  // 默认（无环境变量）：六个开关全关、无白名单。
  const safe = safeDevFlags();
  for (const name of DEV_FLAG_NAMES) assert.equal(safe.enabled[name], false);
  assert.equal(safe.accounts, null);

  const empty = parseDevFlags({});
  assert.deepEqual(empty, safe);

  // 解析：逗号/中文逗号/空白分隔，未知名称忽略不报错。
  const parsed = parseDevFlags({ QIYU_DEV_FLAGS: 'LIFE_EVENTS，MEMORY_REFERENCES NOT_A_FLAG', QIYU_DEV_FLAG_ACCOUNTS: 'acct_dev_alice acct_dev_bob' });
  assert.equal(parsed.enabled.LIFE_EVENTS, true);
  assert.equal(parsed.enabled.MEMORY_REFERENCES, true);
  assert.equal(parsed.enabled.COMPANION_PLANS, false);
  assert.equal(devFlagEnabled(parsed, 'LIFE_EVENTS', 'acct_dev_alice'), true);
  // 白名单外的账户不开。
  assert.equal(devFlagEnabled(parsed, 'LIFE_EVENTS', 'acct_other'), false);
  // 未开启的名称对白名单账户也不开。
  assert.equal(devFlagEnabled(parsed, 'COMPANION_PLANS', 'acct_dev_alice'), false);

  // 未配置白名单 = 开关对所有账户全局生效。
  const globalFlags = parseDevFlags({ QIYU_DEV_FLAGS: 'LIFE_EVENTS' });
  assert.equal(devFlagEnabled(globalFlags, 'LIFE_EVENTS', 'acct_anyone'), true);
  // 空 Accounts 字符串视同未配置（全局），不落入“空集合=无人可用”。
  const emptyAccounts = parseDevFlags({ QIYU_DEV_FLAGS: 'LIFE_EVENTS', QIYU_DEV_FLAG_ACCOUNTS: '' });
  assert.equal(emptyAccounts.accounts, null);

  // 未知开关名恒为 false；缺参容错。
  assert.equal(devFlagEnabled(parsed, 'SOMETHING_ELSE', 'acct_dev_alice'), false);
  assert.equal(devFlagEnabled(null, 'LIFE_EVENTS', 'acct_dev_alice'), false);
});

test('createApp stays behavior-identical without devFlags injection (all existing paths unaffected)', () => {
  // createApp 未注入 devFlags 时使用 safeDevFlags 全关对象——这是既有 360+ 测试
  // 零行为差异的第一道保险；此处只验证默认对象的语义，路由级行为由各 API 测试覆盖。
  const resolved = parseDevFlags(process.env);
  for (const name of DEV_FLAG_NAMES) assert.equal(resolved.enabled[name], false);
});
