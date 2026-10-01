'use strict';

// 六项能力 A4 扩展评测数据集校验（照 qiyu-companion-v0.1/validate-dataset.js
// 模式）：结构校验不调模型；追加三条本数据集专属断言——category 分布计数、
// channel-replay 恰 10 条、干扰资产恰 50 条。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const ids = new Set();
const errors = [];

function readJsonl(filename) {
  const content = fs.readFileSync(path.join(ROOT, filename), 'utf8').trim();
  if (!content) return [];
  return content.split(/\r?\n/u).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) {
      errors.push(`${filename}:${index + 1} JSON 解析失败：${error.message}`);
      return null;
    }
  }).filter(Boolean);
}

function requireString(item, field, file) {
  if (typeof item[field] !== 'string' || item[field].trim() === '') errors.push(`${file}:${item.case_id || '?'} 缺少 ${field}`);
}

function validateCore(item, file) {
  requireString(item, 'case_id', file);
  if (ids.has(item.case_id)) errors.push(`${file}:${item.case_id} ID 重复`);
  ids.add(item.case_id);
  if (!manifest.categories.includes(item.category)) errors.push(`${file}:${item.case_id} category 非法`);
  if (!manifest.severity.includes(item.severity)) errors.push(`${file}:${item.case_id} severity 非法`);
  if (!manifest.judge_modes.includes(item.judge_mode)) errors.push(`${file}:${item.case_id} judge_mode 非法`);
  if (!Array.isArray(item.turns) || item.turns.length === 0) errors.push(`${file}:${item.case_id} turns 不能为空`);
  if (!item.expected || !Array.isArray(item.expected.must) || !Array.isArray(item.expected.must_not) || !Array.isArray(item.expected.assertions)) {
    errors.push(`${file}:${item.case_id} expected 必须包含 must/must_not/assertions 数组`);
  }
  if (!Array.isArray(item.tags) || item.tags.length === 0) errors.push(`${file}:${item.case_id} tags 不能为空`);
  if (item.severity === 'critical' && item.judge_mode === 'human') errors.push(`${file}:${item.case_id} critical 用例不能只用人工判定`);
  if (item.severity === 'critical' && item.expected && item.expected.assertions.length === 0) errors.push(`${file}:${item.case_id} critical 用例必须有确定性断言`);
}

function validateDistractor(item, file) {
  requireString(item, 'asset_id', file);
  if (typeof item.display_text !== 'string' || !item.display_text.trim()) errors.push(`${file}:${item.asset_id} 缺少 display_text`);
  if (item.state && item.state !== 'ACTIVE') errors.push(`${file}:${item.asset_id} 干扰资产必须 ACTIVE（终态干扰语义由用例断言覆盖）`);
}

for (const [kind, spec] of Object.entries(manifest.files)) {
  const items = readJsonl(spec.path);
  if (items.length !== spec.expected_count) errors.push(`${spec.path} 数量应为 ${spec.expected_count}，实际 ${items.length}`);
  if (kind === 'distractor_assets') items.forEach((item) => validateDistractor(item, spec.path));
  else items.forEach((item) => validateCore(item, spec.path));
}

// —— 本数据集专属断言 ——

// 1) category 分布与登记计数一致。
const categoryCounts = {};
for (const line of readJsonl('cases.jsonl')) categoryCounts[line.category] = (categoryCounts[line.category] ?? 0) + 1;
for (const [category, expected] of Object.entries(manifest.category_counts)) {
  if (categoryCounts[category] !== expected) errors.push(`category ${category} 应为 ${expected} 条，实际 ${categoryCounts[category] ?? 0}`);
}
// 2) channel-replay 标记恰 10 条（三通道一致性测试的数据源，不进运行包）。
const replayCases = readJsonl('cases.jsonl').filter((item) => (item.tags ?? []).includes(manifest.channel_replay_tag));
if (replayCases.length !== manifest.channel_replay_count) {
  errors.push(`channel-replay 标记应为 ${manifest.channel_replay_count} 条，实际 ${replayCases.length}`);
}
// 3) 跨日多轮剧本 ≥20 条（方案 §9.2）。
const multiDay = readJsonl('cases.jsonl').filter((item) => (item.tags ?? []).includes('multi-day'));
if (multiDay.length < 20) errors.push(`multi-day 标记应至少 20 条，实际 ${multiDay.length}`);

if (manifest.data_classification !== 'SYNTHETIC_ONLY') errors.push('data_classification 必须为 SYNTHETIC_ONLY');
if (errors.length) {
  console.error(`六项能力评测数据集校验失败（${errors.length} 项）`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(`六项能力评测数据集校验通过：${ids.size} 个唯一用例（channel-replay ${replayCases.length} 条、multi-day ${multiDay.length} 条）+50 干扰资产，全部为合成数据。`);
}
