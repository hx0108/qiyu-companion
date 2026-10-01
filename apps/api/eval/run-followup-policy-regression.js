'use strict';

// node eval/run-followup-policy-regression.js
// 六项能力 A4 主动跟进许可固定回归（mock 确定性门禁）：evaluateFollowupPublish
// 是投递决策唯一写者——15 条全分支精确 (action,reason) 对，零容差。报告写入
// development/eval/；这是候选决策层的回归门禁，不是对真实模型措辞的评测。

const fs = require('node:fs');
const path = require('node:path');
const { evaluateFollowupPublish } = require('../src/domain/followup-service');
const { CASES, fixture } = require('./followup-policy-regression-cases');

function runCase(testCase) {
  const merged = fixture(testCase.patch ?? {});
  const decision = evaluateFollowupPublish({
    event: merged.event, grant: merged.grant, job: merged.job, account: merged.account,
    preferences: merged.preferences, sentAt: merged.sentAt, now: new Date(merged.now)
  });
  const actualReason = decision.reason ?? null;
  const passed = decision.action === testCase.expect.action && actualReason === testCase.expect.reason;
  return { ...testCase, actual_action: decision.action, actual_reason: actualReason, defer_until: decision.defer_until ?? null, passed };
}

function renderReport(results) {
  const failed = results.filter((result) => !result.passed);
  const lines = [
    '# 主动跟进许可固定回归报告',
    '',
    `- 运行时间：${new Date().toISOString()}`,
    '- 数据：版本化合成固定集（evaluateFollowupPublish 全分支）；不含真实私聊。',
    '- 口径：投递决策唯一写者的确定性 (action,reason) 精确匹配，零容差。',
    '',
    `| 用例 | 场景 | 预期 | 实际 | 结论 |`,
    `|---|---|---|---|---|`
  ];
  for (const result of results) {
    lines.push(`| ${result.case_id} | ${result.label} | ${result.expect.action}/${result.expect.reason ?? '—'} | ${result.actual_action}/${result.actual_reason ?? '—'} | ${result.passed ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('', `共 ${results.length} 条：${results.length - failed.length} PASS / ${failed.length} FAIL。`, failed.length === 0 ? '固定决策门禁通过。' : '固定决策门禁失败——任何一条 (action,reason) 漂移都不可发布。');
  return lines.join('\n');
}

function main() {
  const results = CASES.map(runCase);
  const report = renderReport(results);
  console.log(report);
  const outputDir = path.resolve(__dirname, '../../../development/eval');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, 'followup-policy-regression-mock-' + new Date().toISOString().slice(0, 10) + '.md');
  fs.writeFileSync(outputFile, report, 'utf8');
  console.log('\n报告已写入 ' + outputFile);
  process.exitCode = results.every((result) => result.passed) ? 0 : 1;
}

main();
