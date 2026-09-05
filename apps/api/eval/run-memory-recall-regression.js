'use strict';

// node eval/run-memory-recall-regression.js
// 输出固定合成集报告，写入 development/eval/。这是召回候选层的 AI-04 回归门禁，
// 不是对真实模型自然语言引用正确率的统计；后者需固定模型环境、盲评和真实 Bad Case 分开报告。

const fs = require('node:fs');
const path = require('node:path');
const { rankRelationshipAssets } = require('../src/domain/relationship-recall');
const { ACCOUNT_ID, CHARACTER_ID, ASSETS, CASES } = require('./memory-recall-regression-cases');

const WRONG_REFERENCE_RATE_LIMIT = 0.02;

function main() {
  const results = CASES.map(runCase);
  const positive = results.filter((result) => result.kind === 'POSITIVE_REFERENCE');
  const wrongTopReferenceCount = positive.filter((result) => !result.expected_top_matches).length;
  const deletedRecallCount = results.filter((result) => result.forbidden_hits.includes('ras_deleted_movie')).length;
  const scopeLeakCount = results.filter((result) => result.forbidden_hits.some((assetId) => assetId === 'ras_other_account' || assetId === 'ras_other_character')).length;
  const wrongReferenceRate = positive.length === 0 ? 1 : wrongTopReferenceCount / positive.length;
  const passed = wrongReferenceRate <= WRONG_REFERENCE_RATE_LIMIT && deletedRecallCount === 0 && scopeLeakCount === 0;
  const summary = { results, positiveCount: positive.length, wrongTopReferenceCount, wrongReferenceRate, deletedRecallCount, scopeLeakCount, passed };
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

function renderReport(summary) {
  const percent = (value) => (value * 100).toFixed(2) + '%';
  const lines = [
    '# 记忆召回固定回归报告',
    '',
    '- 运行时间：' + new Date().toISOString(),
    '- 数据：版本化合成固定集；不含真实私聊或 Bad Case。',
    '- 覆盖：已确认事实 Top-1、修订替换、删除资产零召回、账户与角色硬隔离。',
    '- 证据边界：此门禁只衡量进入模型上下文前的确定性召回候选；不等同于真实模型最终文本的引用正确率或统计置信区间。',
    '',
    '| 指标 | 阈值 | 实测 | 结论 |',
    '|---|---:|---:|---|',
    '| 已确认事实 Top-1 错误率 | ≤' + percent(WRONG_REFERENCE_RATE_LIMIT) + ' | ' + summary.wrongTopReferenceCount + '/' + summary.positiveCount + '（' + percent(summary.wrongReferenceRate) + '） | ' + (summary.wrongReferenceRate <= WRONG_REFERENCE_RATE_LIMIT ? 'PASS' : 'FAIL') + ' |',
    '| 已删除记忆召回 | 0 | ' + summary.deletedRecallCount + ' | ' + (summary.deletedRecallCount === 0 ? 'PASS' : 'FAIL') + ' |',
    '| 跨账户/角色召回 | 0 | ' + summary.scopeLeakCount + ' | ' + (summary.scopeLeakCount === 0 ? 'PASS' : 'FAIL') + ' |',
    '',
    '| 用例 | 查询 | 预期 Top-1 | 实际候选 | 禁止命中 | 结论 |',
    '|---|---|---|---|---|---|'
  ];
  for (const result of summary.results) {
    lines.push('| ' + result.case_id + ' | ' + result.query + ' | ' + (result.expected_top_asset_id || '无（只验禁止项）') + ' | ' + (result.recalled_asset_ids.join(', ') || '无') + ' | ' + (result.forbidden_hits.join(', ') || '无') + ' | ' + (result.passed ? 'PASS' : 'FAIL') + ' |');
  }
  lines.push('', summary.passed ? '固定召回门禁通过。' : '固定召回门禁失败。');
  return lines.join('\n');
}

main();
