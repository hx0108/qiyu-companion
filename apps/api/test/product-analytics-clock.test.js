'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkAnalyticsClock } = require('../scripts/check-product-analytics-clock');

function check(dbOffset, rtt, options = { maxSkewMs: 30, maxRttMs: 40 }) {
  const start = 1740000000000;
  let clockRead = 0;
  const now = () => start + (clockRead++ % 2 ? rtt : 0);
  const client = { async query(sql) {
    assert.match(sql, /^SELECT .*clock_timestamp\(\)/);
    return { rows: [{ epoch_ms: start + rtt / 2 + dbOffset }] };
  } };
  return checkAnalyticsClock(client, options, now);
}

test('低时延样本返回应用和数据库偏差的保守范围', async () => {
  const result = await check(15, 10);
  assert.equal(result.status, 'WITHIN_BUDGET');
  assert.equal(result.accepted_samples, 5);
  assert.deepEqual(result.samples[0], { rtt_ms: 10, lower_ms: 9, upper_ms: 21 });
});

test('数据库时钟超前或落后时均能判为超预算', async () => {
  for (const offset of [-50, 50]) assert.equal((await check(offset, 10)).status, 'OUTSIDE_BUDGET');
});

test('样本精度不足、连接太慢或应用时钟倒退时不报通过', async () => {
  assert.equal((await check(28, 10)).status, 'INCONCLUSIVE');
  assert.equal((await check(0, 41)).accepted_samples, 0);
  assert.equal((await check(0, -1)).status, 'INCONCLUSIVE');
  await assert.rejects(check(0, 0, { maxSkewMs: 0, maxRttMs: 10 }), /预算/);
});
