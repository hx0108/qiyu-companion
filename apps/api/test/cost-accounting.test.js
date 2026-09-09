'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCostReport, reconcileProviderBills } = require('../src/domain/cost-accounting');

test('cost report calculates money and nearest-rank P50/P90/P99 without content data', () => {
  const metrics = Array.from({ length: 100 }, (_, index) => ({ capability: 'CHAT_GENERATION', provider: 'qwen', model_version: 'plus', input_tokens: 1000, output_tokens: 500, latency_ms: index + 1, outcome: index < 96 ? 'COMPLETED' : 'FAILED' }));
  const report = buildCostReport(metrics, { 'qwen:plus': { input_fen_per_1k: 1, output_fen_per_1k: 2 } });
  assert.equal(report.rows[0].estimated_cost_fen, 200);
  assert.equal(report.rows[0].p50_latency_ms, 50);
  assert.equal(report.rows[0].p90_latency_ms, 90);
  assert.equal(report.rows[0].p99_latency_ms, 99);
  assert.equal(report.rows[0].failure_rate, 0.04);
  assert.deepEqual(Object.keys(report.rows[0]).includes('text'), false);
});

test('bill reconciliation flags amounts outside the explicit tolerance', () => {
  const report = { rows: [{ provider: 'qwen', estimated_cost_fen: 100 }] };
  assert.equal(reconcileProviderBills(report, [{ provider: 'qwen', period: '2026-09', billed_fen: 100.5 }], 1)[0].status, 'MATCHED');
  assert.equal(reconcileProviderBills(report, [{ provider: 'qwen', period: '2026-09', billed_fen: 110 }], 1)[0].status, 'REVIEW_REQUIRED');
});

test('费率按生效时间取档：调价日前后各按当期价格估算；无时间戳的历史埋点不猜价', () => {
  const metrics = [
    { capability: 'CHAT_GENERATION', provider: 'qwen', model_version: 'plus', input_tokens: 1000, output_tokens: 0, latency_ms: 1, outcome: 'COMPLETED', created_at: '2026-08-15T00:00:00Z' },
    { capability: 'CHAT_GENERATION', provider: 'qwen', model_version: 'plus', input_tokens: 1000, output_tokens: 0, latency_ms: 2, outcome: 'COMPLETED', created_at: '2026-09-15T00:00:00Z' },
    { capability: 'CHAT_GENERATION', provider: 'qwen', model_version: 'plus', input_tokens: 1000, output_tokens: 0, latency_ms: 3, outcome: 'COMPLETED' }
  ];
  const card = { 'qwen:plus': { effective: [
    { effective_from: '2026-08-01', input_fen_per_1k: 1, output_fen_per_1k: 1 },
    { effective_from: '2026-09-01', input_fen_per_1k: 2, output_fen_per_1k: 2 }
  ] } };
  const report = buildCostReport(metrics, card, {}, { bucket: 'month' });
  const byPeriod = Object.fromEntries(report.rows.map((row) => [row.period, row]));
  assert.equal(byPeriod['2026-08'].estimated_cost_fen, 1);
  assert.equal(byPeriod['2026-09'].estimated_cost_fen, 2);
  // 无 created_at 的埋点无时间档可依：不定价并显式计数，不回退旧价。
  const undated = report.rows.find((row) => row.period === 'unknown');
  assert.equal(undated.unpriced_calls, 1);
  assert.equal(undated.estimated_cost_fen, 0);
});

test('阶梯费率按单次输出 token 命中档位，最后一档兜底', () => {
  const metrics = [
    { capability: 'CHAT_GENERATION', provider: 'qwen', model_version: 'flash', input_tokens: 0, output_tokens: 500, latency_ms: 1, outcome: 'COMPLETED' },
    { capability: 'CHAT_GENERATION', provider: 'qwen', model_version: 'flash', input_tokens: 0, output_tokens: 5000, latency_ms: 2, outcome: 'COMPLETED' }
  ];
  const report = buildCostReport(metrics, { 'qwen:flash': { tiers: [
    { up_to_output_tokens: 1000, output_fen_per_1k: 2 },
    { up_to_output_tokens: 10000, output_fen_per_1k: 1 }
  ] } });
  assert.equal(report.rows[0].estimated_cost_fen, 1 + 5);
});

test('对账调整项：优惠券/代金券/退款/税差按白名单计入，超出容差仍需复核', () => {
  const report = { rows: [{ provider: 'qwen', period: '2026-09', estimated_cost_fen: 100 }] };
  const bill = { provider: 'qwen', period: '2026-09', billed_fen: 106.5, adjustments: [
    { kind: 'COUPON', fen: -10, note: '9 月券' },
    { kind: 'TAX', fen: 16.5, note: '增值税' }
  ] };
  const [matched] = reconcileProviderBills(report, [bill], 1);
  assert.equal(matched.status, 'MATCHED');
  assert.equal(matched.adjustments_fen, 6.5);
  // 无调整项时保持旧口径（直接对比估算与账单）。
  const [plain] = reconcileProviderBills(report, [{ provider: 'qwen', period: '2026-09', billed_fen: 100.5 }], 1);
  assert.equal(plain.status, 'MATCHED');
  assert.equal(plain.adjustments_fen, 0);
  // 非法调整项直接拒绝，不静默忽略。
  assert.throws(() => reconcileProviderBills(report, [{ provider: 'qwen', billed_fen: 1, adjustments: [{ kind: 'SECRET_DISCOUNT', fen: 1 }] }]), TypeError);
});

test('日月分桶：同一供应商跨日调用按 period 分行，月桶归并', () => {
  const metrics = [
    { capability: 'CHAT_GENERATION', provider: 'qwen', model_version: 'plus', input_tokens: 1000, output_tokens: 0, latency_ms: 1, outcome: 'COMPLETED', created_at: '2026-09-01T00:00:00Z' },
    { capability: 'CHAT_GENERATION', provider: 'qwen', model_version: 'plus', input_tokens: 1000, output_tokens: 0, latency_ms: 2, outcome: 'COMPLETED', created_at: '2026-09-02T00:00:00Z' }
  ];
  const day = buildCostReport(metrics, { qwen: { input_fen_per_1k: 1 } }, {}, { bucket: 'day' });
  assert.deepEqual(day.rows.map((row) => row.period).sort(), ['2026-09-01', '2026-09-02']);
  const month = buildCostReport(metrics, { qwen: { input_fen_per_1k: 1 } }, {}, { bucket: 'month' });
  assert.equal(month.rows.length, 1);
  assert.equal(month.rows[0].period, '2026-09');
  assert.equal(month.rows[0].calls, 2);
});
