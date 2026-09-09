'use strict';

// 供应商账单对账（个人项目可完成项）：
//   node scripts/reconcile-provider-bill.js --metrics=metrics.json --bill=bill.json \
//     --rate-card=rate-card.json [--tolerance-fen=1] [--bucket=day|month]
// metrics.json：/internal/cost-report 的原始埋点导出（含 created_at 时才支持分桶与生效时间费率）。
// bill.json：[{ provider, period, billed_fen, adjustments?: [{ kind, fen, note }] }]
//   kind ∈ COUPON/FREE_CREDIT/REFUND/TAX/TIER_DELTA/OTHER（正数抬账单、负数抵减，单位分）。
// rate-card.json：固定 / effective（生效时间）/ tiers（阶梯）三口径见 domain/cost-accounting.js。
// 诚实边界：没有真实供应商账单时，本脚本只能验证对账程序本身，不能声称真实金额已核对。

const { readFile } = require('node:fs/promises');
const { buildCostReport, parseRateCard, reconcileProviderBills } = require('../src/domain/cost-accounting');

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((part) => part.split(/=(.*)/s).slice(0, 2)));
  if (!args['--metrics'] || !args['--bill'] || !args['--rate-card']) throw new Error('用法：node reconcile-provider-bill.js --metrics=metrics.json --bill=bill.json --rate-card=rate-card.json [--tolerance-fen=1] [--bucket=day|month]');
  const bucket = args['--bucket'] === 'day' || args['--bucket'] === 'month' ? args['--bucket'] : 'none';
  const [metrics, bills, card] = await Promise.all([readJson(args['--metrics']), readJson(args['--bill']), readJson(args['--rate-card'])]);
  const report = buildCostReport(metrics, parseRateCard(card), {}, { bucket });
  const reconciliation = reconcileProviderBills(report, bills, Number(args['--tolerance-fen'] || 1));
  process.stdout.write(`${JSON.stringify({ bucket, report, reconciliation }, null, 2)}\n`);
  if (reconciliation.some((item) => item.status !== 'MATCHED')) process.exitCode = 2;
}
async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
main().catch((error) => { console.error(error.message); process.exit(1); });
