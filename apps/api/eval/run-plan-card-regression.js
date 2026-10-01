'use strict';

// node eval/run-plan-card-regression.js
// 六项能力 A4 计划与卡片固定回归（mock 确定性门禁）：提议三路回退、
// schema 拒绝、卡片内容安全边界，零容差。报告写入 development/eval/。

const fs = require('node:fs');
const path = require('node:path');
const { composePlanProposal } = require('../src/domain/plan-composer');
const { validatePlanProposalOutput } = require('../src/domain/plan-schema');
const { buildEventCard, validateCardActions, renderCardMarkdown } = require('../src/domain/artifact-card');
const { CASES, EVENT } = require('./plan-card-regression-cases');

async function runCase(testCase) {
  if (testCase.kind === 'PROPOSAL_FALLBACK') {
    const proposal = await composePlanProposal({ supportMode: 'PRACTICE_TOGETHER', event: EVENT, model: testCase.model ?? null });
    let passed = proposal.provider === testCase.expect.provider && proposal.steps.length === testCase.expect.steps;
    if (testCase.expect.fallback_reason) passed = passed && proposal.fallback_reason === testCase.expect.fallback_reason;
    if (testCase.expect.fallback_reason_prefix) passed = passed && String(proposal.fallback_reason ?? '').startsWith(testCase.expect.fallback_reason_prefix);
    return { ...testCase, actual: { provider: proposal.provider, fallback_reason: proposal.fallback_reason ?? null, steps: proposal.steps.length }, passed };
  }
  if (testCase.kind === 'SCHEMA_REJECT') {
    const validation = validatePlanProposalOutput(testCase.raw);
    let passed = validation.ok === false;
    const fields = validation.errors.map((item) => item.field).join('；');
    if (testCase.expect.field) passed = passed && validation.errors.some((item) => item.field === testCase.expect.field);
    if (testCase.expect.field_contains) passed = passed && fields.includes(testCase.expect.field_contains);
    return { ...testCase, actual: { ok: validation.ok, fields: validation.ok ? null : fields }, passed };
  }
  if (testCase.kind === 'CARD_BOUNDARY' && testCase.card && testCase.event) {
    const built = buildEventCard({ card: testCase.card, event: testCase.event });
    return { ...testCase, actual: { ok: built.ok, reason: built.ok ? null : built.reason }, passed: built.ok === testCase.expect.ok };
  }
  if (testCase.kind === 'CARD_BOUNDARY' && testCase.actions) {
    const verdict = validateCardActions(testCase.actions);
    return { ...testCase, actual: { ok: verdict.ok, reason: verdict.ok ? null : verdict.reason }, passed: verdict.ok === testCase.expect.ok };
  }
  if (testCase.kind === 'CARD_BOUNDARY' && testCase.card && !testCase.event) {
    const markdown = renderCardMarkdown(testCase.card);
    const passed = testCase.expect.no_html && !markdown.includes('<') && testCase.expect.no_link && !/https?:\/\//.test(markdown)
      && testCase.expect.has_checkbox && /- \[[ x]\]/.test(markdown);
    return { ...testCase, actual: { markdown_head: markdown.split('\n')[0], safe: !markdown.includes('<') && !/https?:\/\//.test(markdown) }, passed };
  }
  return { ...testCase, actual: { skipped: true }, passed: false };
}

function renderReport(results) {
  const failed = results.filter((result) => !result.passed);
  const lines = [
    '# 计划与卡片固定回归报告',
    '',
    `- 运行时间：${new Date().toISOString()}`,
    '- 数据：版本化合成固定集（提议回退/schema 拒绝/卡片边界）；不含真实私聊。',
    '- 口径：确定性判定零容差——HTML/链接/未知动作一律拒绝而非转义放行。',
    '',
    `| 用例 | 场景 | 实际 | 结论 |`,
    `|---|---|---|---|`
  ];
  for (const result of results) {
    lines.push(`| ${result.case_id} | ${result.label} | ${JSON.stringify(result.actual)} | ${result.passed ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('', `共 ${results.length} 条：${results.length - failed.length} PASS / ${failed.length} FAIL。`, failed.length === 0 ? '固定门禁通过。' : '固定门禁失败。');
  return lines.join('\n');
}

async function main() {
  const results = [];
  for (const testCase of CASES) results.push(await runCase(testCase));
  const report = renderReport(results);
  console.log(report);
  const outputDir = path.resolve(__dirname, '../../../development/eval');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, 'plan-card-regression-mock-' + new Date().toISOString().slice(0, 10) + '.md');
  fs.writeFileSync(outputFile, report, 'utf8');
  console.log('\n报告已写入 ' + outputFile);
  process.exitCode = results.every((result) => result.passed) ? 0 : 1;
}

main();
