'use strict';

// node eval/run-memory-recall-regression.js
// 输出固定合成集报告，写入 development/eval/。这是召回候选层的 AI-04 回归门禁，
// 不是对真实模型自然语言引用正确率的统计；后者需固定模型环境、盲评和真实 Bad Case 分开报告。
// P1-4 起包含语义向量召回段（混合召回层）：
//   mock 模式：语义改写用例 SKIP（确定性嵌入无语义能力），但版本隔离守卫仍计数；
//   qwen 模式（QIYU_LLM_PROVIDER=qwen + QWEN_API_KEY）：语义用例计入门禁。

const fs = require('node:fs');
const path = require('node:path');
const { rankRelationshipAssets } = require('../src/domain/relationship-recall');
const { rankAssetsForContext } = require('../src/app');
const { deterministicEmbedding, enqueueAssetEmbedding, runNextAssetEmbeddingJob, DEVELOPMENT_EMBEDDING_MODEL_VERSION } = require('../src/domain/asset-embedding-worker');
const { ACCOUNT_ID, CHARACTER_ID, ASSETS, CASES, SEMANTIC_CASES } = require('./memory-recall-regression-cases');

const WRONG_REFERENCE_RATE_LIMIT = 0.02;

async function main() {
  const useQwen = process.env.QIYU_LLM_PROVIDER === 'qwen' && (process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY);
  let embeddingProvider = null;
  if (useQwen) {
    const { createQwenEmbeddingProvider } = require('../src/providers/qwen-adapter');
    embeddingProvider = createQwenEmbeddingProvider(process.env);
    if (!embeddingProvider) throw new Error('QIYU_LLM_PROVIDER=qwen 但未提供有效 QWEN_API_KEY');
  }
  const provider = embeddingProvider || { modelVersion: DEVELOPMENT_EMBEDDING_MODEL_VERSION, dimensions: 256, embed: deterministicEmbedding };

  const results = CASES.map(runCase);
  const semantic = await runSemanticCases(provider, useQwen);
  const versionGuard = await runVersionMismatchGuard(provider);

  const positive = results.filter((result) => result.kind === 'POSITIVE_REFERENCE');
  const wrongTopReferenceCount = positive.filter((result) => !result.expected_top_matches).length;
  const deletedRecallCount = results.filter((result) => result.forbidden_hits.includes('ras_deleted_movie')).length;
  const scopeLeakCount = results.filter((result) => result.forbidden_hits.some((assetId) => assetId === 'ras_other_account' || assetId === 'ras_other_character')).length;
  const wrongReferenceRate = positive.length === 0 ? 1 : wrongTopReferenceCount / positive.length;
  const semanticFailures = semantic.filter((item) => item.status === 'FAIL').length;
  const passed = wrongReferenceRate <= WRONG_REFERENCE_RATE_LIMIT && deletedRecallCount === 0 && scopeLeakCount === 0
    && semanticFailures === 0 && versionGuard.passed;
  const summary = { results, positiveCount: positive.length, wrongTopReferenceCount, wrongReferenceRate, deletedRecallCount, scopeLeakCount, semantic, semanticProvider: embeddingProvider ? `qwen ${embeddingProvider.modelVersion}（${embeddingProvider.dimensions} 维）` : '确定性开发嵌入（语义用例 SKIP）', versionGuard, passed };
  const report = renderReport(summary);
  console.log(report);
  const outputDir = path.resolve(__dirname, '../../../development/eval');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, 'memory-recall-regression-' + new Date().toISOString().slice(0, 10) + '.md');
  fs.writeFileSync(outputFile, report, 'utf8');
  console.log('\n报告已写入 ' + outputFile);
  process.exitCode = passed ? 0 : 1;
}

function runCase(testCase) {
  const recalled = rankRelationshipAssets(ASSETS, {
    accountId: ACCOUNT_ID, characterId: CHARACTER_ID, query: testCase.query, limit: 3
  });
  const recalledIds = recalled.map((asset) => asset.asset_id);
  const forbiddenHits = testCase.forbidden_asset_ids.filter((assetId) => recalledIds.includes(assetId));
  const expectedTopMatches = testCase.expected_top_asset_id === null || recalledIds[0] === testCase.expected_top_asset_id;
  return { ...testCase, recalled_asset_ids: recalledIds, expected_top_matches: expectedTopMatches, forbidden_hits: forbiddenHits, passed: expectedTopMatches && forbiddenHits.length === 0 };
}

// 语义段走真实混合召回层：入队 → Worker 建索引（provider 同源）→ rankAssetsForContext。
function semanticIndexStore(provider) {
  const store = {
    assets: new Map(ASSETS.map((asset) => [asset.asset_id, { ...asset, version: 1, index_state: 'PENDING' }])),
    assetEmbeddings: new Map(), assetEmbeddingJobs: new Map(), outboxEvents: new Map(),
    next: ((count) => () => `semantic_${count += 1}`)(0)
  };
  for (const asset of store.assets.values()) enqueueAssetEmbedding({ store, asset });
  return store;
}

async function drainEmbeddingJobs(store, provider) {
  for (let round = 0; round < 20; round += 1) {
    const outcome = await runNextAssetEmbeddingJob({ store, embeddingProvider: provider.embed, modelVersion: provider.modelVersion, expectedDimensions: provider.dimensions, now: new Date() });
    if (outcome.state !== 'COMPLETED') break;
  }
  const readyCount = [...store.assets.values()].filter((asset) => asset.state === 'ACTIVE' && asset.index_state === 'READY').length;
  const activeCount = [...store.assets.values()].filter((asset) => asset.state === 'ACTIVE').length;
  return { complete: readyCount === activeCount, readyCount, activeCount };
}

async function runSemanticCases(provider, useQwen) {
  const store = semanticIndexStore(provider);
  const drain = await drainEmbeddingJobs(store, provider);
  const outcome = [];
  for (const testCase of SEMANTIC_CASES) {
    if (!useQwen) { outcome.push({ ...testCase, status: 'SKIP', recalled_asset_ids: [] }); continue; }
    if (!drain.complete) { outcome.push({ ...testCase, status: 'FAIL', note: `索引未完成（READY ${drain.readyCount}/${drain.activeCount}）` }); continue; }
    const ranked = await rankAssetsForContext(store, ACCOUNT_ID, CHARACTER_ID, testCase.query, provider);
    const ids = ranked.map((asset) => asset.asset_id);
    outcome.push({ ...testCase, status: ids.slice(0, 3).includes(testCase.expected_top3_asset_id) ? 'PASS' : 'FAIL', recalled_asset_ids: ids });
  }
  return outcome;
}

// 版本隔离守卫（两种模式都计数）：索引用 provider 建好后，用不同 model_version
// 的查询 provider 召回——不得抛错、不得把跨版本向量算成余弦（回退词法序），
// 且召回结果不丢失（仍返回账户内资产）。
async function runVersionMismatchGuard(provider) {
  const store = semanticIndexStore(provider);
  const drain = await drainEmbeddingJobs(store, provider);
  if (!drain.complete) return { passed: false, error: `索引未完成（READY ${drain.readyCount}/${drain.activeCount}）` };
  const alienProvider = { modelVersion: `${provider.modelVersion}#alien`, dimensions: provider.dimensions, embed: provider.embed };
  try {
    const ranked = await rankAssetsForContext(store, ACCOUNT_ID, CHARACTER_ID, SEMANTIC_CASES[0].query, alienProvider);
    const ownAssets = ranked.filter((asset) => asset.account_id === ACCOUNT_ID && asset.character_id === CHARACTER_ID);
    return { passed: ranked.length > 0 && ownAssets.length === ranked.length };
  } catch (error) {
    return { passed: false, error: String(error?.message || error) };
  }
}

function renderReport(summary) {
  const percent = (value) => (value * 100).toFixed(2) + '%';
  const lines = [
    '# 记忆召回固定回归报告',
    '',
    '- 运行时间：' + new Date().toISOString(),
    '- 数据：版本化合成固定集；不含真实私聊或 Bad Case。',
    '- 覆盖：已确认事实 Top-1、修订替换、删除资产零召回、账户与角色硬隔离；语义改写用例（混合召回层）与跨版本向量隔离守卫。',
    '- 语义向量来源：' + summary.semanticProvider,
    '- 证据边界：此门禁只衡量进入模型上下文前的确定性召回候选；不等同于真实模型最终文本的引用正确率或统计置信区间。',
    '',
    '| 指标 | 阈值 | 实测 | 结论 |',
    '|---|---:|---:|---|',
    '| 已确认事实 Top-1 错误率 | ≤' + percent(WRONG_REFERENCE_RATE_LIMIT) + ' | ' + summary.wrongTopReferenceCount + '/' + summary.positiveCount + '（' + percent(summary.wrongReferenceRate) + '） | ' + (summary.wrongReferenceRate <= WRONG_REFERENCE_RATE_LIMIT ? 'PASS' : 'FAIL') + ' |',
    '| 已删除记忆召回 | 0 | ' + summary.deletedRecallCount + ' | ' + (summary.deletedRecallCount === 0 ? 'PASS' : 'FAIL') + ' |',
    '| 跨账户/角色召回 | 0 | ' + summary.scopeLeakCount + ' | ' + (summary.scopeLeakCount === 0 ? 'PASS' : 'FAIL') + ' |',
    '| 语义改写 Top-3 命中（qwen 模式计门禁） | FAIL=0 | ' + summary.semantic.filter((item) => item.status === 'FAIL').length + '/' + summary.semantic.length + ' | ' + (summary.semantic.every((item) => item.status !== 'FAIL') ? 'PASS' : 'FAIL') + ' |',
    '| 跨版本向量隔离（不抛错、不混算、不丢召回） | PASS | ' + (summary.versionGuard.passed ? '通过' : '违反：' + (summary.versionGuard.error || '行为异常')) + ' | ' + (summary.versionGuard.passed ? 'PASS' : 'FAIL') + ' |',
    '',
    '| 用例 | 查询 | 预期 Top-1 | 实际候选 | 禁止命中 | 结论 |',
    '|---|---|---|---|---|---|'
  ];
  for (const result of summary.results) {
    lines.push('| ' + result.case_id + ' | ' + result.query + ' | ' + (result.expected_top_asset_id || '无（只验禁止项）') + ' | ' + (result.recalled_asset_ids.join(', ') || '无') + ' | ' + (result.forbidden_hits.join(', ') || '无') + ' | ' + (result.passed ? 'PASS' : 'FAIL') + ' |');
  }
  lines.push('', '## 语义改写用例（混合召回层）', '', '| 用例 | 查询 | 预期 Top-3 | 实际候选 | 结论 |', '|---|---|---|---|---|');
  for (const item of summary.semantic) {
    lines.push('| ' + item.case_id + ' | ' + item.query + ' | ' + item.expected_top3_asset_id + ' | ' + (item.recalled_asset_ids.join(', ') || '—') + ' | ' + item.status + (item.note ? '（' + item.note + '）' : '') + ' |');
  }
  lines.push('', summary.passed ? '固定召回门禁通过。' : '固定召回门禁失败。');
  return lines.join('\n');
}

main().catch((error) => { console.error(error); process.exit(1); });
