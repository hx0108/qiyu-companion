'use strict';

// 冻结运行包的文本/长程执行器：消费 requests.jsonl，逐条调用已指定的 Qwen
// 适配器，并以 append-only JSONL 回填实际证据。它不生成 TTS 音频，也不把
// 未执行、模型回退或输出门禁替换误记为通过。

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createQwenReplyGenerator, CONVERSATION_PROMPT_VERSION } = require('../src/providers/qwen-adapter');
const { assessModelOutputAuthority } = require('../src/domain/model-output-policy');

function parseArgs(argv) {
  const args = { limit: Number.MAX_SAFE_INTEGER, concurrency: 1, resume: true, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--no-resume') { args.resume = false; continue; }
    if (value === '--dry-run') { args.dryRun = true; continue; }
    if (!value.startsWith('--')) throw new Error(`无法解析参数：${value}`);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`参数 ${value} 缺少值`);
    index += 1;
    if (value === '--run-dir') args.runDir = next;
    else if (value === '--limit') args.limit = Number(next);
    else if (value === '--concurrency') args.concurrency = Number(next);
    else throw new Error(`不支持的参数：${value}`);
  }
  if (!args.runDir) throw new Error('必须提供 --run-dir');
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit 必须是正整数');
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 8) throw new Error('--concurrency 必须是 1 到 8 的整数');
  return args;
}

// —— A4 预算装备（干跑先行；方案 §9.2：预算将到时停止付费运行并明确未执行项）——
const BUDGET_FEN = Number.isFinite(Number(process.env.QIYU_EVAL_BUDGET_FEN)) ? Number(process.env.QIYU_EVAL_BUDGET_FEN) : 5000;
// 经验口径参考常量：取自 216 条运行包 evidence 实测（单轮均值约 598 输入/
// 143 输出）；同目录存在更新运行包时动态采样覆盖。
const EMPIRICAL_DEFAULT = { inputPerTurn: 598, outputPerTurn: 143, source: 'qwen3.8-flash-conversation-persona-v1-r1 实测均值（固定参考）' };

function evalPrices() {
  const priceIn = Number(process.env.QIYU_EVAL_PRICE_IN_PER_1M);
  const priceOut = Number(process.env.QIYU_EVAL_PRICE_OUT_PER_1M);
  return Number.isFinite(priceIn) && Number.isFinite(priceOut) && priceIn >= 0 && priceOut >= 0 ? { priceIn, priceOut } : null;
}

function empiricalSample(runDir) {
  const runsRoot = path.dirname(runDir);
  const candidates = fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot)
    .filter((name) => name.startsWith('qwen') && name.includes('persona'))
    .map((name) => path.join(runsRoot, name, 'evidence-canonical.jsonl'))
    .filter((file) => fs.existsSync(file)) : [];
  if (candidates.length === 0) return EMPIRICAL_DEFAULT;
  const file = candidates.sort().at(-1);
  let inputSum = 0, outputSum = 0, turns = 0;
  for (const entry of readJsonl(file)) {
    for (const turn of entry.turns ?? []) {
      inputSum += Number(turn.usage?.prompt_tokens ?? 0);
      outputSum += Number(turn.usage?.completion_tokens ?? 0);
      turns += 1;
    }
  }
  if (turns === 0) return EMPIRICAL_DEFAULT;
  return { inputPerTurn: Math.round(inputSum / turns), outputPerTurn: Math.round(outputSum / turns), source: `动态采样 ${path.basename(path.dirname(file))}（${turns} 回合）` };
}

function estimateBudget(requests, prices, empirical) {
  // 上限口径（门禁用）：输入=每回合全部文本字符×1.0（中文保守 1 字=1 token，
  // 另加固定提示模板开销并入经验口径对比）；输出=max_tokens 满额 1024，重试
  // 最坏 ×2（QwenAdapter attempt<2 + companion schema 兜底）。
  let upperInputTokens = 0;
  let upperOutputTokens = 0;
  let empiricalInputTokens = 0;
  let empiricalOutputTokens = 0;
  let totalTurns = 0;
  for (const request of requests) {
    const turns = (request.turns ?? []).length;
    totalTurns += turns;
    const inputChars = (request.turns ?? []).join('').length;
    upperInputTokens += inputChars;
    upperOutputTokens += turns * 1024 * 2;
    empiricalInputTokens += turns * empirical.inputPerTurn;
    empiricalOutputTokens += turns * empirical.outputPerTurn;
  }
  const fen = (tokensIn, tokensOut) => prices ? Math.ceil((tokensIn * prices.priceIn + tokensOut * prices.priceOut) / 10_000) : null; // 元→分（/1M×100）
  return {
    requestCount: requests.length, totalTurns,
    upper: { inputTokens: upperInputTokens, outputTokens: upperOutputTokens, costFen: fen(upperInputTokens, upperOutputTokens) },
    empirical: { inputTokens: empiricalInputTokens, outputTokens: empiricalOutputTokens, costFen: fen(empiricalInputTokens, empiricalOutputTokens), source: empirical.source }
  };
}

function renderBudgetReport(estimate, prices, budgetFen) {
  const lines = [
    '# 运行包预算估算（干跑产物，未调用模型）',
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- 请求 ${estimate.requestCount} 条 · 总回合 ${estimate.totalTurns}`,
    `- 单价：${prices ? `输入 ${prices.priceIn} 元/百万 token · 输出 ${prices.priceOut} 元/百万 token（环境变量提供）` : '未配置 QIYU_EVAL_PRICE_IN_PER_1M / QIYU_EVAL_PRICE_OUT_PER_1M——只报 token 不折价（不猜价格）'}`,
    `- 预算上限：${budgetFen} 分（${(budgetFen / 100).toFixed(2)} 元，QIYU_EVAL_BUDGET_FEN 默认 5000）`,
    '',
    '| 口径 | 输入 token | 输出 token | 成本 |',
    '|---|---:|---:|---|',
    `| 上限口径（门禁） | ${estimate.upper.inputTokens} | ${estimate.upper.outputTokens} | ${estimate.upper.costFen === null ? '未配置单价' : estimate.upper.costFen + ' 分（' + (estimate.upper.costFen / 100).toFixed(2) + ' 元）'} |`,
    `| 经验口径（参考） | ${estimate.empirical.inputTokens} | ${estimate.empirical.outputTokens} | ${estimate.empirical.costFen === null ? '未配置单价' : estimate.empirical.costFen + ' 分（' + (estimate.empirical.costFen / 100).toFixed(2) + ' 元）'} |`,
    '',
    `经验口径来源：${estimate.empirical.source}`,
    '',
    '上限口径：输入按每回合全部文本字符 ×1.0（中文保守 1 字=1 token）；输出按 max_tokens 满额 1024 × 回合 ×2（重试最坏）。',
    '真实执行按实际 usage 熔断：累计成本触及预算即停，剩余条目标 EXECUTION_SKIPPED_BUDGET 如实登记。'
  ];
  return lines.join('\n') + '\n';
}

function readJsonl(filename) {
  if (!fs.existsSync(filename)) return [];
  const source = fs.readFileSync(filename, 'utf8').trim();
  return source ? source.split(/\r?\n/u).map((line) => JSON.parse(line)) : [];
}

function evidenceIds(filename) {
  return new Set(canonicalEvidence(readJsonl(filename)).filter((entry) => entry.status !== 'EXECUTION_FAILED').map((entry) => entry.request_id));
}

function canonicalEvidence(entries) {
  const byRequestId = new Map();
  for (const entry of entries) byRequestId.set(entry.request_id, entry);
  return [...byRequestId.values()];
}

function acquireRunLock(runDir) {
  const lockFile = path.join(runDir, '.execute.lock');
  let descriptor;
  try {
    descriptor = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + '\n');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`运行包已有执行器占用：${lockFile}`);
    throw error;
  }
  return () => { fs.closeSync(descriptor); fs.unlinkSync(lockFile); };
}

function evalPersona(setup = {}) {
  return {
    gender: 'unspecified', worldview: '海边小城', age_setting: '27',
    relationship_to_user: setup.relationship_stage || '初识',
    personality: setup.persona || '安静、观察力强的陪伴者',
    expression_style: '短句、自然口语',
    hard_boundaries: ['不复刻任何真人', '不提供专业诊断或具体交易指令'],
    example_behaviors: ['先承认感受，再给用户选择']
  };
}

function buildContext(request, history) {
  return {
    character: { name: '阿澈', persona: evalPersona(request.setup) },
    recent_context: history,
    confirmed_assets: [],
    world_state: { mood_code: 'calm', location_code: 'seaside_town', active_event_refs: [] }
  };
}

async function executeRequest(request, generator, now = () => new Date().toISOString()) {
  const startedAt = Date.now();
  const history = [];
  const turns = Array.isArray(request.turns) ? request.turns : [];
  const turnEvidence = [];
  let finalReply = null;
  for (const text of turns) {
    const reply = await generator(String(text), buildContext(request, history));
    const outputGuard = assessModelOutputAuthority(reply.reply_text);
    const visibleText = outputGuard ? '这条回复未通过安全审核，已替换。你可以换个话题继续。' : reply.reply_text;
    turnEvidence.push({ input: String(text), reply_text: visibleText, raw_reply_text: outputGuard ? reply.reply_text : undefined, provider: reply.provider, model_version: reply.model_version, usage: reply.usage, output_guard: outputGuard?.code || null });
    history.push({ actor: 'USER', text: String(text) }, { actor: 'ASSISTANT', text: visibleText });
    finalReply = { ...reply, reply_text: visibleText, output_guard: outputGuard?.code || null };
  }
  if (!finalReply) throw new Error(`${request.request_id} 缺少 turns`);
  return {
    request_id: request.request_id, run_id: request.run_id, case_id: request.case_id, kind: request.kind, attempt: request.attempt,
    status: finalReply.ai_generated === false ? 'SCHEMA_FALLBACK' : finalReply.output_guard ? 'OUTPUT_GUARD_BLOCKED' : 'COMPLETED',
    executed_at: now(), latency_ms: Date.now() - startedAt, final_reply: finalReply.reply_text,
    turns: turnEvidence, provider_request_model: finalReply.model_version, usage: finalReply.usage,
    evidence_sha256: createHash('sha256').update(JSON.stringify(turnEvidence)).digest('hex')
  };
}

function buildBlindRows(requests, evidence) {
  const byId = new Map(evidence.map((entry) => [entry.request_id, entry]));
  return requests.flatMap((request) => {
    const entry = byId.get(request.request_id);
    if (!entry) return [];
    return [{
      blind_label: `T-${createHash('sha256').update(request.request_id).digest('hex').slice(0, 10).toUpperCase()}`,
      request_id: request.request_id, case_id: request.case_id, kind: request.kind, attempt: request.attempt,
      turns: request.turns, expected: request.expected, severity: request.severity, judge_mode: request.judge_mode,
      final_reply: entry.final_reply, status: entry.status, evidence_ref: 'evidence.jsonl'
    }];
  });
}

function writeIndependentReviewPackets(runDir, blindRows) {
  for (const reviewerSlot of ['A', 'B']) {
    const packet = blindRows.map((row) => ({ ...row, reviewer_slot: reviewerSlot }));
    fs.writeFileSync(path.join(runDir, `blind-reviewer-${reviewerSlot}.jsonl`), packet.map((row) => JSON.stringify(row)).join('\n') + (packet.length ? '\n' : ''), 'utf8');
    const scoreSource = fs.readFileSync(path.join(runDir, 'review-sheet.csv'), 'utf8').split(/\r?\n/u);
    const scoreSheet = scoreSource.map((line, index) => index === 0 || !line ? line : line.replace(/^((?:[^,]*,){5})[^,]*/u, `$1reviewer-${reviewerSlot}`));
    fs.writeFileSync(path.join(runDir, `review-sheet-reviewer-${reviewerSlot}.csv`), scoreSheet.join('\n'), 'utf8');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = path.resolve(args.runDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'run-manifest.json'), 'utf8'));
  const requests = readJsonl(path.join(runDir, 'requests.jsonl'));
  const prices = evalPrices();
  const budgetFile = path.join(runDir, 'budget-estimate.md');

  // —— 干跑（零付费）：只产预算表，不调模型、不读密钥、不加锁 ——
  if (args.dryRun) {
    const estimate = estimateBudget(requests, prices, empiricalSample(runDir));
    fs.writeFileSync(budgetFile, renderBudgetReport(estimate, prices, BUDGET_FEN), 'utf8');
    console.log(renderBudgetReport(estimate, prices, BUDGET_FEN));
    console.log(`预算表已写入 ${budgetFile}`);
    if (estimate.upper.costFen !== null && estimate.upper.costFen > BUDGET_FEN) {
      console.error(`上限口径 ${estimate.upper.costFen} 分超过预算 ${BUDGET_FEN} 分：真实执行将被拒绝。降低 --repetitions 重新 prepare，或以 --limit 分批执行。`);
      process.exitCode = 2;
    }
    return;
  }

  // —— 真实执行前置门禁：预算表必须存在且单价已配置（不猜价格）——
  if (!fs.existsSync(budgetFile)) throw new Error('缺少 budget-estimate.md——先跑 --dry-run 产出预算表再执行（干跑先行，方案 §9.2）');
  if (!prices) throw new Error('未配置 QIYU_EVAL_PRICE_IN_PER_1M / QIYU_EVAL_PRICE_OUT_PER_1M——预算熔断需要单价，不猜价格');
  const preflight = estimateBudget(requests, prices, empiricalSample(runDir));
  if (preflight.upper.costFen > BUDGET_FEN) {
    console.error(`上限口径估算 ${preflight.upper.costFen} 分超过预算 ${BUDGET_FEN} 分，拒绝执行（降低 --repetitions 重新 prepare 或 --limit 分批）。`);
    process.exit(2);
  }

  const releaseLock = acquireRunLock(runDir);
  try {
  if (manifest.provider !== 'qwen' || manifest.model_version !== 'qwen3.8-flash') throw new Error('运行包不是冻结的 qwen3.8-flash 配置');
  if (manifest.prompt_version !== CONVERSATION_PROMPT_VERSION) throw new Error(`Prompt 版本不匹配：运行包=${manifest.prompt_version}，代码=${CONVERSATION_PROMPT_VERSION}`);
  const generator = createQwenReplyGenerator(process.env);
  if (!generator) throw new Error('必须设置 QIYU_LLM_PROVIDER=qwen 及 QWEN_API_KEY 或 DASHSCOPE_API_KEY');
  // 启动探活：1-token ping，避免跑几十条后才发现 key 欠费。
  {
    const baseUrl = process.env.QWEN_BASE_URL || process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const key = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY;
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-flash', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, enable_thinking: false, stream: false })
    }).catch(() => null);
    if (!response || !response.ok) throw new Error(`启动 ping 失败（HTTP ${response ? response.status : '网络错误'}）——key 可能欠费/失效，未执行任何条目`);
  }
  const evidenceFile = path.join(runDir, 'evidence.jsonl');
  const completed = args.resume ? evidenceIds(evidenceFile) : new Set();
  const pending = requests.filter((request) => !completed.has(request.request_id)).slice(0, args.limit);
  let failures = 0;
  let skippedForBudget = 0;
  let spentFen = 0;
  let budgetExceeded = false;
  const usageCostFen = (usage) => (Number(usage?.prompt_tokens ?? 0) * prices.priceIn + Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) * prices.priceOut) / 10_000;
  let cursor = 0;
  async function runOne(request) {
    if (budgetExceeded) {
      skippedForBudget += 1;
      fs.appendFileSync(evidenceFile, JSON.stringify({ request_id: request.request_id, run_id: request.run_id, case_id: request.case_id, status: 'EXECUTION_SKIPPED_BUDGET', executed_at: new Date().toISOString(), error_code: 'BUDGET_EXHAUSTED', error_message: `累计成本已达预算 ${BUDGET_FEN} 分，本条未执行` }) + '\n', 'utf8');
      return;
    }
    try {
      const entry = await executeRequest(request, generator);
      fs.appendFileSync(evidenceFile, JSON.stringify(entry) + '\n', 'utf8');
      for (const turn of entry.turns ?? []) spentFen += usageCostFen(turn.usage);
      if (spentFen >= BUDGET_FEN) {
        budgetExceeded = true;
        console.error(`预算熔断：累计约 ${Math.ceil(spentFen)} 分 ≥ ${BUDGET_FEN} 分，剩余条目将标记 EXECUTION_SKIPPED_BUDGET。`);
      }
      console.log(`${entry.status} ${request.request_id}`);
    } catch (error) {
      failures += 1;
      fs.appendFileSync(evidenceFile, JSON.stringify({ request_id: request.request_id, run_id: request.run_id, case_id: request.case_id, status: 'EXECUTION_FAILED', executed_at: new Date().toISOString(), error_code: error.code || 'EXECUTION_ERROR', error_message: error.message }) + '\n', 'utf8');
      console.error(`EXECUTION_FAILED ${request.request_id}: ${error.message}`);
    }
  }
  async function worker() {
    while (cursor < pending.length) {
      const request = pending[cursor];
      cursor += 1;
      await runOne(request);
    }
  }
  await Promise.all(Array.from({ length: Math.min(args.concurrency, pending.length) }, worker));
  const evidence = canonicalEvidence(readJsonl(evidenceFile));
  fs.writeFileSync(path.join(runDir, 'evidence-canonical.jsonl'), evidence.map((entry) => JSON.stringify(entry)).join('\n') + (evidence.length ? '\n' : ''), 'utf8');
  const blindRows = buildBlindRows(requests, evidence);
  fs.writeFileSync(path.join(runDir, 'blind-text-packet.jsonl'), blindRows.map((row) => JSON.stringify(row)).join('\n') + (blindRows.length ? '\n' : ''), 'utf8');
  writeIndependentReviewPackets(runDir, blindRows);
  console.log(`已执行 ${pending.length - skippedForBudget} 条；跳过（预算）${skippedForBudget} 条；规范证据 ${evidence.length}/${requests.length}；失败 ${failures}；实际成本约 ${Math.ceil(spentFen)} 分；盲评文本包已刷新。`);
  if (failures > 0 || skippedForBudget > 0) process.exitCode = 1;
  } finally {
    releaseLock();
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });

module.exports = { acquireRunLock, buildBlindRows, buildContext, canonicalEvidence, executeRequest, parseArgs, writeIndependentReviewPackets };
