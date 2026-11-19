'use strict';

async function checkAnalyticsClock(client, { maxSkewMs, maxRttMs }, now = Date.now) {
  if (![maxSkewMs, maxRttMs].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('须明确指定正整数毫秒预算');
  }
  const samples = [];
  for (let index = 0; index < 5; index++) {
    const start = now();
    const { rows: [row] } = await client.query('SELECT EXTRACT(EPOCH FROM clock_timestamp())::double precision * 1000 AS epoch_ms');
    const end = now();
    if (!Number.isFinite(row?.epoch_ms) || end < start || end - start > maxRttMs) continue;
    samples.push({ rtt_ms: end - start, lower_ms: Math.floor(row.epoch_ms - end - 1), upper_ms: Math.ceil(row.epoch_ms - start + 1) });
  }
  const within = sample => sample.lower_ms >= -maxSkewMs && sample.upper_ms <= maxSkewMs;
  const outside = sample => sample.upper_ms < -maxSkewMs || sample.lower_ms > maxSkewMs;
  const status = samples.length === 5 && samples.every(within) ? 'WITHIN_BUDGET'
    : samples.length === 5 && (samples.every(sample => outside(sample) && sample.lower_ms > 0) ||
      samples.every(sample => outside(sample) && sample.upper_ms < 0)) ? 'OUTSIDE_BUDGET' : 'INCONCLUSIVE';
  return { status, max_skew_ms: maxSkewMs, max_rtt_ms: maxRttMs, accepted_samples: samples.length, samples };
}

async function main() {
  const [maxSkew, maxRtt, ...extra] = process.argv.slice(2);
  if (extra.length || !/^\d+$/.test(maxSkew ?? '') || !/^\d+$/.test(maxRtt ?? '')) {
    throw new TypeError('用法：node check-product-analytics-clock.js <偏差预算ms> <采样往返预算ms>');
  }
  const connectionString = process.env.QIYU_ANALYTICS_READONLY_DATABASE_URL;
  if (!connectionString) throw new TypeError('需要 QIYU_ANALYTICS_READONLY_DATABASE_URL');
  const { Client } = require('pg');
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    await client.connect();
    const result = await checkAnalyticsClock(client, { maxSkewMs: Number(maxSkew), maxRttMs: Number(maxRtt) });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.status !== 'WITHIN_BUDGET') process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) main().catch(error => {
  console.error(error instanceof TypeError ? error.message : '时钟检查失败，请核对连接和超时设置');
  process.exitCode = 1;
});

module.exports = { checkAnalyticsClock };
