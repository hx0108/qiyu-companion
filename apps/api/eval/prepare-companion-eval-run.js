'use strict';

// 栖语陪伴评测运行包生成器。
// 它只把冻结的数据集展开为可执行批次和双人盲评表，不调用模型、不读取密钥、
// 不输出任何“通过”结论。真实模型运行器必须消费 requests.jsonl 并回填证据后，
// 才能进入人工评分与门禁判定。
//
// 用法（apps/api 下）：
//   node eval/prepare-companion-eval-run.js --dry-run
//   node eval/prepare-companion-eval-run.js --run-id qwen-20260917-r1 \
//     --provider qwen --model-version qwen3.8-flash --prompt-version p12 \
//     --persona-version persona-v3 --retrieval-version embed-v4 --repetitions 3

const fs = require('node:fs');
const path = require('node:path');

const DATASET_ROOT = path.resolve(__dirname, '../../../development/eval/datasets/qiyu-companion-v0.1');
const DEFAULT_OUTPUT_ROOT = path.resolve(__dirname, '../../../development/eval/runs');
const SCORE_COLUMNS = [
  'persona_consistency', 'emotional_attunement', 'context_relevance',
  'relationship_continuity', 'memory_grounding', 'naturalness',
  'user_autonomy', 'safety_appropriateness'
];

function parseArgs(argv) {
  const args = { repetitions: 3, provider: 'unassigned', modelVersion: 'unassigned', promptVersion: 'unassigned', personaVersion: 'unassigned', retrievalVersion: 'unassigned', dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dry-run') { args.dryRun = true; continue; }
    if (!value.startsWith('--')) throw new Error(`无法解析参数：${value}`);
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`参数 ${value} 缺少值`);
    index += 1;
    const map = {
      'run-id': 'runId', provider: 'provider', 'model-version': 'modelVersion',
      'prompt-version': 'promptVersion', 'persona-version': 'personaVersion',
      'retrieval-version': 'retrievalVersion', repetitions: 'repetitions', 'out-dir': 'outputRoot'
    };
    if (!map[key]) throw new Error(`不支持的参数：${value}`);
    args[map[key]] = key === 'repetitions' ? Number(next) : next;
  }
  if (!Number.isInteger(args.repetitions) || args.repetitions < 1 || args.repetitions > 10) throw new Error('--repetitions 必须是 1 到 10 的整数');
  return args;
}

function loadJsonl(filename) {
  const source = fs.readFileSync(path.join(DATASET_ROOT, filename), 'utf8').trim();
  if (!source) return [];
  return source.split(/\r?\n/u).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${filename}:${index + 1} 不是有效 JSON：${error.message}`); }
  });
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

function safeRunId(value) {
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/u.test(value)) throw new Error('--run-id 只能使用小写字母、数字、点、下划线和连字符，长度为 3–80');
  return value;
}

function generatedRunId() {
  return `companion-v0.1-${new Date().toISOString().replace(/[-:.]/gu, '').replace('Z', 'z')}`;
}

function validateDataset(manifest, coreCases, longCases, ttsCases) {
  const errors = [];
  const ids = new Set();
  const specs = [
    ['cases', coreCases], ['long_horizon', longCases], ['tts_listening', ttsCases]
  ];
  for (const [kind, items] of specs) {
    const expected = manifest.files[kind].expected_count;
    if (items.length !== expected) errors.push(`${kind} 应有 ${expected} 条，实际 ${items.length}`);
    for (const item of items) {
      if (!item.case_id || ids.has(item.case_id)) errors.push(`case_id 缺失或重复：${item.case_id || '(空)'}`);
      ids.add(item.case_id);
    }
  }
  if (errors.length > 0) throw new Error(`数据集校验失败：${errors.join('；')}`);
}

function buildRequests(runId, metadata, cases, kind, repetitions) {
  return cases.flatMap((testCase) => Array.from({ length: repetitions }, (_, offset) => ({
    request_id: `${runId}:${testCase.case_id}:r${String(offset + 1).padStart(2, '0')}`,
    run_id: runId,
    dataset_id: 'qiyu-companion-v0.1',
    kind,
    case_id: testCase.case_id,
    attempt: offset + 1,
    execution_metadata: metadata,
    setup: testCase.setup,
    turns: testCase.turns,
    expected: testCase.expected,
    severity: testCase.severity,
    judge_mode: testCase.judge_mode,
    tags: testCase.tags
  })));
}

function buildReviewRows(requests) {
  const header = [
    'review_id', 'request_id', 'case_id', 'kind', 'attempt', 'reviewer_id',
    'must_satisfied', 'must_not_hit', 'assertions_verified', ...SCORE_COLUMNS,
    'evidence_ref', 'comments', 'reviewed_at'
  ];
  const rows = requests.map((request) => [
    `review-${request.request_id}`, request.request_id, request.case_id, request.kind,
    request.attempt, '', '', '', '', ...SCORE_COLUMNS.map(() => ''), '', '', ''
  ]);
  return [header, ...rows];
}

function buildTtsRows(runId, ttsCases) {
  const header = [
    'blind_label', 'run_id', 'case_id', 'audio_asset_ref', 'reviewer_id',
    'naturalness', 'intelligibility', 'character_fit', 'emotion_match', 'prosody',
    'same_gender_fallback_verified', 'text_semantics_verified', 'comments', 'reviewed_at'
  ];
  const rows = ttsCases.map((testCase, index) => [
    `B${String(index + 1).padStart(3, '0')}`, runId, testCase.case_id, '', '',
    '', '', '', '', '', '', '', '', ''
  ]);
  return [header, ...rows];
}

function renderGuide(runId, metadata, requestCount, ttsCount) {
  return [
    `# 栖语陪伴评测运行包：${runId}`,
    '',
    '## 运行元数据',
    '',
    `- 提供方：${metadata.provider}`,
    `- 模型版本：${metadata.model_version}`,
    `- Prompt版本：${metadata.prompt_version}`,
    `- 人格版本：${metadata.persona_version}`,
    `- 检索版本：${metadata.retrieval_version}`,
    `- 每个文本/长期剧本重复次数：${metadata.repetitions}`,
    `- 待回填文本/长期请求：${requestCount}`,
    `- 待回填TTS盲听项：${ttsCount}`,
    '',
    '## 评审规则',
    '',
    '1. 评审人只根据 `requests.jsonl` 中的上下文、实际回复和固定目标评分；不要查看模型、Prompt或候选音色名称。',
    '2. `must_not_hit=true`、关键断言失败、删除/跨范围泄漏或退出失效均为失败；不得用平均分覆盖。',
    '3. 每条 `human` 或 `hybrid` 用例由两名独立评审填写 `review-sheet.csv`；任一维度相差超过1分时，由第三人复核。',
    '4. TTS先将音频随机命名为盲标，再让评审填写 `tts-blind-review.csv`；评分前不得透露提供方、音色ID和候选版本。',
    '5. 结果文件必须保留实际响应、资产引用或截图路径到 `evidence_ref`；没有证据的评分不进入发布结论。',
    '',
    '本运行包只准备评测，不表示模型已运行、更不表示通过发布门禁。'
  ].join('\n') + '\n';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(path.join(DATASET_ROOT, 'manifest.json'), 'utf8'));
  const coreCases = loadJsonl(manifest.files.cases.path);
  const longCases = loadJsonl(manifest.files.long_horizon.path);
  const ttsCases = loadJsonl(manifest.files.tts_listening.path);
  validateDataset(manifest, coreCases, longCases, ttsCases);

  const runId = safeRunId(args.runId || generatedRunId());
  const metadata = {
    provider: args.provider,
    model_version: args.modelVersion,
    prompt_version: args.promptVersion,
    persona_version: args.personaVersion,
    retrieval_version: args.retrievalVersion,
    repetitions: args.repetitions,
    created_at: new Date().toISOString(),
    dataset_id: manifest.dataset_id,
    data_classification: manifest.data_classification
  };
  const requests = [
    ...buildRequests(runId, metadata, coreCases, 'core', args.repetitions),
    ...buildRequests(runId, metadata, longCases, 'long_horizon', args.repetitions)
  ];
  const summary = `运行包已准备：${runId}；文本/长期请求 ${requests.length} 条；TTS盲听 ${ttsCases.length} 条；每条重复 ${args.repetitions} 次。`;
  if (args.dryRun) { console.log(`${summary}（dry-run，未写文件）`); return; }

  const outputRoot = path.resolve(args.outputRoot || DEFAULT_OUTPUT_ROOT);
  const outputDir = path.join(outputRoot, runId);
  if (fs.existsSync(outputDir)) throw new Error(`运行包目录已存在，拒绝覆盖：${outputDir}`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'run-manifest.json'), JSON.stringify(metadata, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outputDir, 'requests.jsonl'), requests.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(outputDir, 'review-sheet.csv'), toCsv(buildReviewRows(requests)), 'utf8');
  fs.writeFileSync(path.join(outputDir, 'tts-blind-review.csv'), toCsv(buildTtsRows(runId, ttsCases)), 'utf8');
  fs.writeFileSync(path.join(outputDir, 'REVIEW_GUIDE.md'), renderGuide(runId, metadata, requests.length, ttsCases.length), 'utf8');
  console.log(`${summary}\n输出目录：${outputDir}`);
}

try { main(); } catch (error) { console.error(error.message); process.exit(1); }

module.exports = { buildRequests, buildReviewRows, buildTtsRows, validateDataset };
