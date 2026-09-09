'use strict';

// 成本核算与供应商账单对账（PRD 6.6，个人项目可完成项）。
// 费率表支持三种口径（可组合于同一 card 不同键）：
//   1) 固定：{ input_fen_per_1k, output_fen_per_1k, per_call_fen }
//   2) 生效时间：{ effective: [{ effective_from: 'YYYY-MM-DD', ...费率 }] }
//      —— 取 metric.created_at 当日仍有效的最近一档；无 created_at 的历史
//      埋点不适用时间档（计入 unpriced_calls，不猜价格）。
//   3) 阶梯：{ tiers: [{ up_to_output_tokens, ...费率 }] } —— 按单次调用
//      output_tokens 命中第一档，最后一档为兜底。
// 对账支持调整项（账单价与估算价的已知差异）：COUPON/FREE_CREDIT/REFUND/
// TAX/TIER_DELTA/OTHER，单位分；billed = estimated + Σadjustments ± tolerance
// 时 MATCHED。诚实边界：没有真实账单时只能验证程序，不能声称金额已核对。

const ADJUSTMENT_KINDS = Object.freeze(['COUPON', 'FREE_CREDIT', 'REFUND', 'TAX', 'TIER_DELTA', 'OTHER']);

function buildCostReport(metrics, rateCard = {}, thresholds = {}, { bucket = 'none' } = {}) {
  const groups = new Map();
  for (const metric of metrics ?? []) {
    const key = `${bucketPeriod(metric, bucket)}|${metric.capability}|${metric.provider}|${metric.model_version || 'unknown'}`;
    const group = groups.get(key) || { period: bucketPeriod(metric, bucket), capability: metric.capability, provider: metric.provider, model_version: metric.model_version || null, calls: 0, failures: 0, unpriced_calls: 0, input_tokens: 0, output_tokens: 0, latencies: [], estimated_cost_fen: 0 };
    const rate = rateFor(rateCard, metric);
    group.calls += 1;
    group.failures += metric.outcome === 'COMPLETED' ? 0 : 1;
    group.unpriced_calls += rate.priced ? 0 : 1;
    group.input_tokens += Number(metric.input_tokens) || 0;
    group.output_tokens += Number(metric.output_tokens) || 0;
    group.latencies.push(Math.max(0, Number(metric.latency_ms) || 0));
    group.estimated_cost_fen += rate.per_call_fen + (Number(metric.input_tokens) || 0) * rate.input_fen_per_1k / 1000 + (Number(metric.output_tokens) || 0) * rate.output_fen_per_1k / 1000;
    groups.set(key, group);
  }
  const rows = [...groups.values()].map((group) => {
    group.latencies.sort((a, b) => a - b);
    const success = group.calls - group.failures;
    return {
      period: group.period, capability: group.capability, provider: group.provider, model_version: group.model_version,
      calls: group.calls, failures: group.failures, failure_rate: group.calls ? round(group.failures / group.calls, 4) : 0, unpriced_calls: group.unpriced_calls,
      input_tokens: group.input_tokens, output_tokens: group.output_tokens,
      p50_latency_ms: quantile(group.latencies, 0.5), p90_latency_ms: quantile(group.latencies, 0.9), p99_latency_ms: quantile(group.latencies, 0.99),
      estimated_cost_fen: round(group.estimated_cost_fen, 4), estimated_cost_per_success_fen: success ? round(group.estimated_cost_fen / success, 4) : null
    };
  }).sort((a, b) => String(a.period).localeCompare(String(b.period)) || a.provider.localeCompare(b.provider) || a.capability.localeCompare(b.capability));
  const alerts = [];
  for (const row of rows) {
    if (row.p99_latency_ms > (thresholds.p99_latency_ms ?? 15_000)) alerts.push({ severity: 'WARN', code: 'P99_LATENCY_HIGH', provider: row.provider, capability: row.capability, value: row.p99_latency_ms });
    if (row.failure_rate > (thresholds.failure_rate ?? 0.05)) alerts.push({ severity: 'WARN', code: 'FAILURE_RATE_HIGH', provider: row.provider, capability: row.capability, value: row.failure_rate });
    if (thresholds.cost_per_success_fen != null && row.estimated_cost_per_success_fen > thresholds.cost_per_success_fen) alerts.push({ severity: 'WARN', code: 'UNIT_COST_HIGH', provider: row.provider, capability: row.capability, value: row.estimated_cost_per_success_fen });
  }
  return { rows, totals: { calls: rows.reduce((n, row) => n + row.calls, 0), estimated_cost_fen: round(rows.reduce((n, row) => n + row.estimated_cost_fen, 0), 4) }, alerts };
}

function reconcileProviderBills(report, bills, toleranceFen = 1) {
  const estimated = new Map();
  for (const row of report.rows ?? []) {
    const key = billKey(row.period ? `${row.provider}|${row.period}` : row.provider);
    estimated.set(key, (estimated.get(key) || 0) + row.estimated_cost_fen);
  }
  // 账单带周期时优先对同周期行；报告未分桶（无 period）则回退供应商汇总，
  // 与旧口径一致——分桶对账须以 bucket=day/month 重建报告。
  const expectedFor = (bill) => estimated.get(billKey(bill.period ? `${bill.provider}|${bill.period}` : bill.provider))
    ?? estimated.get(billKey(bill.provider)) ?? 0;
  return (bills ?? []).map((bill) => {
    const adjustments = normalizeAdjustments(bill.adjustments);
    const adjustmentsFen = round(adjustments.reduce((sum, adjustment) => sum + adjustment.fen, 0), 4);
    const expected = round(expectedFor(bill), 4);
    const billed = Number(bill.billed_fen) || 0;
    const delta = round(billed - expected - adjustmentsFen, 4);
    return {
      provider: bill.provider, period: bill.period || null,
      estimated_fen: expected, adjustments, adjustments_fen: adjustmentsFen, billed_fen: billed,
      delta_fen: delta, status: Math.abs(delta) <= toleranceFen ? 'MATCHED' : 'REVIEW_REQUIRED'
    };
  });
}

// 调整项校验：kind 白名单 + 有限数值（分）。非法项直接抛错，不静默忽略。
function normalizeAdjustments(value) {
  if (!value) return [];
  if (!Array.isArray(value)) throw new TypeError('bill.adjustments must be an array');
  return value.map((adjustment) => {
    if (!adjustment || !ADJUSTMENT_KINDS.includes(adjustment.kind)) throw new TypeError(`adjustment.kind must be one of ${ADJUSTMENT_KINDS.join('/')}`);
    const fen = Number(adjustment.fen);
    if (!Number.isFinite(fen)) throw new TypeError('adjustment.fen must be a finite number (fen)');
    return { kind: adjustment.kind, fen: round(fen, 4), note: adjustment.note || null };
  });
}

function billKey(value) { return String(value).toLowerCase(); }

function bucketPeriod(metric, bucket) {
  if (bucket === 'day') return String(metric.created_at || '').slice(0, 10) || 'unknown';
  if (bucket === 'month') return String(metric.created_at || '').slice(0, 7) || 'unknown';
  return null;
}

function parseRateCard(value) {
  if (!value) return {};
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('rate card must be an object');
  return parsed;
}

function rateFor(card, metric) {
  const value = card[`${metric.provider}:${metric.model_version || 'unknown'}`] || card[metric.provider] || card[metric.capability] || {};
  return resolveRateEntry(value, metric);
}

// 解析一档费率：支持固定 / effective（按时间）/ tiers（按单次输出 token）。
// 只有时间档且无适用条目（含 metric 无 created_at）时返回 unpriced——容器
// 对象 {effective:[...]} 本身不是费率，不能当零价兜底。
function resolveRateEntry(value, metric) {
  if (!value || typeof value !== 'object') return unpriced();
  if (Array.isArray(value.effective)) {
    const entry = pickDatedEntry(value.effective, metric.created_at);
    if (entry === undefined) return unpriced();
    return withTiers(entry, metric);
  }
  return withTiers(value, metric);
}

function withTiers(entry, metric) {
  if (Array.isArray(entry.tiers) && entry.tiers.length > 0) {
    const outputTokens = Number(metric.output_tokens) || 0;
    const tier = entry.tiers.find((candidate) => Number(candidate.up_to_output_tokens) >= outputTokens) ?? entry.tiers[entry.tiers.length - 1];
    return priced(tier);
  }
  return priced(entry);
}

// 生效时间：返回 metric 当日仍有效的最近一档；无时间字段 = 恒适用；
// metric 无 created_at 且只有时间档时返回 undefined（不猜价 → unpriced）。
function pickDatedEntry(effective, createdAt) {
  if (!Array.isArray(effective) || effective.length === 0) return undefined;
  const undated = effective.find((entry) => !entry.effective_from);
  if (!createdAt) return undated; // 有恒适用档则用之，否则不定价
  const applicable = effective
    .filter((entry) => entry.effective_from && String(entry.effective_from) <= String(createdAt).slice(0, 10))
    .sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)));
  return applicable[applicable.length - 1] ?? undated;
}

function priced(entry) {
  return { priced: true, per_call_fen: nonNegative(entry.per_call_fen), input_fen_per_1k: nonNegative(entry.input_fen_per_1k), output_fen_per_1k: nonNegative(entry.output_fen_per_1k) };
}
function unpriced() { return { priced: false, per_call_fen: 0, input_fen_per_1k: 0, output_fen_per_1k: 0 }; }
function nonNegative(value) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : 0; }
function quantile(values, q) { return values.length ? values[Math.max(0, Math.ceil(values.length * q) - 1)] : 0; }
function round(value, digits) { const scale = 10 ** digits; return Math.round((value + Number.EPSILON) * scale) / scale; }

module.exports = { buildCostReport, parseRateCard, reconcileProviderBills, ADJUSTMENT_KINDS };
