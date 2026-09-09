'use strict';

// 时延与成本评测入口（PRD 6.6 成本埋点的可复核出口）：
//   node eval/run-latency-cost-regression.js            # mock：验证埋点链路与统计口径
//   QIYU_LLM_PROVIDER=qwen QWEN_API_KEY=... node eval/run-latency-cost-regression.js
// 单账户发送固定 8 条普通对话提示 × 3 轮，读取 store.operationMetrics
// （CHAT_GENERATION / TEXT_MODERATION），输出各能力 P50/P95 时延、token 用量与估算成本。
// 诚实边界：单机单次样本，不做发布门禁中的时延硬门槛（仅 FAILED 视为失败）；
// 成本估算依赖外部单价环境变量，未配置则明确输出“不估算”，不猜价格。
//   QIYU_EVAL_PRICE_IN_PER_1M  输入 token 单价（元/百万 token）
//   QIYU_EVAL_PRICE_OUT_PER_1M 输出 token 单价（元/百万 token）

const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { PERSONA_WITH_BOUNDARIES } = require('./persona-regression-cases');

const PROMPTS = Object.freeze([
  '今天下班好累呀',
  '早上好，今天天气很好',
  '我最近在学做菜，今天煎蛋终于不糊了',
  '有点想念以前的老朋友',
  '周末有什么适合一个人的活动吗',
  '谢谢你听我说这些',
  '今天走了很多路，腿有点酸',
  '我在纠结要不要换工作'
]);
const ROUNDS = 3;

async function main() {
  const store = new DevelopmentStore();
  const useQwen = process.env.QIYU_LLM_PROVIDER === 'qwen' && (process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY);
  let replyGenerator;
  if (useQwen) {
    const { createQwenReplyGenerator } = require('../src/providers/qwen-adapter');
    replyGenerator = createQwenReplyGenerator(process.env) || undefined;
    if (!replyGenerator) throw new Error('QIYU_LLM_PROVIDER=qwen 但未提供有效 QWEN_API_KEY');
  }
  const server = createApp({ store, replyGenerator });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = 'dev-latency-cost-token';
  const accountId = 'acct_eval_latency_cost';
  TOKEN_OVERRIDE.set(token, accountId);
  store.accounts.set(accountId, { ...new DevelopmentStore({ accountIds: [accountId] }).account(accountId) });
  await bootstrap(base, token);
  const conversations = await fetch(`${base}/api/v1/conversations`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
  const conversation = conversations.conversations.at(-1);
  let sendFailures = 0;
  try {
    for (let round = 1; round <= ROUNDS; round += 1) {
      for (const [index, prompt] of PROMPTS.entries()) {
        const response = await fetch(`${base}/api/v1/conversations/${conversation.conversation_id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': `lc-${round}-${index}` },
          body: JSON.stringify({ content: { text: prompt } })
        });
        if (!response.ok || !(await response.json()).assistant_message) sendFailures += 1;
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const metrics = [...store.operationMetrics.values()].filter((metric) => metric.account_id === accountId);
  const report = renderReport(metrics, sendFailures, useQwen ? 'qwen' : 'mock');
  console.log(report);
  const outputDir = path.resolve(__dirname, '../../../development/eval');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, `latency-cost-regression-${useQwen ? 'qwen' : 'mock'}-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(outputFile, report, 'utf8');
  const failedOutcomes = metrics.filter((metric) => metric.outcome === 'FAILED');
  const noChatMetrics = metrics.filter((metric) => metric.capability === 'CHAT_GENERATION').length === 0;
  console.log(`\n报告已写入 ${outputFile}`);
  process.exit(sendFailures > 0 || failedOutcomes.length > 0 || noChatMetrics ? 1 : 0);
}

const TOKEN_OVERRIDE = new Map();
const { TOKENS } = require('../src/app');
const originalTokensGet = TOKENS.get.bind(TOKENS);
TOKENS.get = (key) => TOKEN_OVERRIDE.get(key) || originalTokensGet(key);

async function bootstrap(base, token) {
  const post = (pathName, body, key) => fetch(`${base}${pathName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': `${key}-${token}` },
    body: JSON.stringify(body)
  }).then((response) => response.json());
  const notices = await fetch(`${base}/api/v1/required-notices`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
  await post(`/api/v1/required-notices/${notices.notices[0].notice_id}/displayed`, { notice_version: notices.notices[0].notice_version }, 'n');
  await post('/api/v1/age/declarations', { date_of_birth: '1990-01-01', confirmed_18_plus: true }, 'a');
  const { name, ...personaOnly } = PERSONA_WITH_BOUNDARIES;
  const character = await post('/api/v1/characters', { name, persona: personaOnly }, 'c');
  await post('/api/v1/conversations', { character_id: character.character.character_id }, 'v');
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, index)];
}

function renderReport(metrics, sendFailures, providerLabel) {
  const priceIn = Number(process.env.QIYU_EVAL_PRICE_IN_PER_1M);
  const priceOut = Number(process.env.QIYU_EVAL_PRICE_OUT_PER_1M);
  const priceConfigured = Number.isFinite(priceIn) && Number.isFinite(priceOut);
  const capabilities = ['CHAT_GENERATION', 'TEXT_MODERATION'];
  const lines = [
    '# 时延与成本评测报告',
    '',
    `- 运行时间：${new Date().toISOString()}`,
    `- 适配器：${providerLabel}（${providerLabel === 'mock' ? '确定性开发 Mock——时延数字不可比，仅验证埋点链路' : '真实 Qwen 调用——单机单次样本'}）`,
    `- 发送失败请求数：${sendFailures}（>0 即判 FAIL）`,
    '',
    '| 能力 | 样本数 | P50 (ms) | P95 (ms) | 失败数 | 输入 token | 输出 token | 估算成本 (元) |',
    '|---|---|---|---|---|---|---|---|'
  ];
  let totalCost = 0;
  for (const capability of capabilities) {
    const rows = metrics.filter((metric) => metric.capability === capability);
    const latencies = rows.map((row) => row.latency_ms).sort((a, b) => a - b);
    const inputTokens = rows.reduce((sum, row) => sum + row.input_tokens, 0);
    const outputTokens = rows.reduce((sum, row) => sum + row.output_tokens, 0);
    const failed = rows.filter((row) => row.outcome === 'FAILED').length;
    const cost = providerLabel === 'qwen' && priceConfigured ? (inputTokens * priceIn + outputTokens * priceOut) / 1_000_000 : null;
    if (cost !== null) totalCost += cost;
    lines.push(`| ${capability} | ${rows.length} | ${percentile(latencies, 50)} | ${percentile(latencies, 95)} | ${failed} | ${inputTokens} | ${outputTokens} | ${cost === null ? '—' : cost.toFixed(4)} |`);
  }
  lines.push('', `成本口径：${providerLabel === 'mock' ? 'mock 适配器无真实 token 计费，不估算' : priceConfigured ? `单价 ${priceIn}/${priceOut} 元每百万 token（环境变量提供），总估算 ${totalCost.toFixed(4)} 元` : '未配置 QIYU_EVAL_PRICE_IN_PER_1M / QIYU_EVAL_PRICE_OUT_PER_1M，不估算（不猜价格）'}`);
  return lines.join('\n');
}

main().catch((error) => { console.error(error); process.exit(1); });
