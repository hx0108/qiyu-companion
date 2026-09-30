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
  const args = { limit: Number.MAX_SAFE_INTEGER, concurrency: 1, resume: true };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--no-resume') { args.resume = false; continue; }
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
  const releaseLock = acquireRunLock(runDir);
  try {
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'run-manifest.json'), 'utf8'));
  if (manifest.provider !== 'qwen' || manifest.model_version !== 'qwen3.8-flash') throw new Error('运行包不是冻结的 qwen3.8-flash 配置');
  if (manifest.prompt_version !== CONVERSATION_PROMPT_VERSION) throw new Error(`Prompt 版本不匹配：运行包=${manifest.prompt_version}，代码=${CONVERSATION_PROMPT_VERSION}`);
  const generator = createQwenReplyGenerator(process.env);
  if (!generator) throw new Error('必须设置 QIYU_LLM_PROVIDER=qwen 及 QWEN_API_KEY 或 DASHSCOPE_API_KEY');
  const requests = readJsonl(path.join(runDir, 'requests.jsonl'));
  const evidenceFile = path.join(runDir, 'evidence.jsonl');
  const completed = args.resume ? evidenceIds(evidenceFile) : new Set();
  const pending = requests.filter((request) => !completed.has(request.request_id)).slice(0, args.limit);
  let failures = 0;
  let cursor = 0;
  async function runOne(request) {
    try {
      const entry = await executeRequest(request, generator);
      fs.appendFileSync(evidenceFile, JSON.stringify(entry) + '\n', 'utf8');
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
  console.log(`已执行 ${pending.length} 条；规范证据 ${evidence.length}/${requests.length}；失败 ${failures}；盲评文本包已刷新。`);
  if (failures > 0) process.exitCode = 1;
  } finally {
    releaseLock();
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });

module.exports = { acquireRunLock, buildBlindRows, buildContext, canonicalEvidence, executeRequest, parseArgs, writeIndependentReviewPackets };
