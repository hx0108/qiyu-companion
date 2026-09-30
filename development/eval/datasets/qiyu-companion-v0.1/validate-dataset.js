'use strict';

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

function validateTts(item, file) {
  requireString(item, 'case_id', file);
  if (ids.has(item.case_id)) errors.push(`${file}:${item.case_id} ID 重复`);
  ids.add(item.case_id);
  if (!['MALE', 'FEMALE'].includes(item.voice_gender)) errors.push(`${file}:${item.case_id} voice_gender 非法`);
  if (!['neutral', 'happy', 'caring', 'sad', 'angry', 'intimate'].includes(item.emotion)) errors.push(`${file}:${item.case_id} emotion 非法`);
  requireString(item, 'text', file);
  if (!Array.isArray(item.rubric) || item.rubric.length === 0) errors.push(`${file}:${item.case_id} rubric 不能为空`);
  if (!item.hard_assertions || item.hard_assertions.same_gender_fallback_only !== true) errors.push(`${file}:${item.case_id} 必须声明同性别降级门禁`);
}

for (const [kind, spec] of Object.entries(manifest.files)) {
  const items = readJsonl(spec.path);
  if (items.length !== spec.expected_count) errors.push(`${spec.path} 数量应为 ${spec.expected_count}，实际 ${items.length}`);
  if (kind === 'tts_listening') items.forEach((item) => validateTts(item, spec.path));
  else items.forEach((item) => validateCore(item, spec.path));
}

if (manifest.data_classification !== 'SYNTHETIC_ONLY') errors.push('data_classification 必须为 SYNTHETIC_ONLY');
if (errors.length) {
  console.error(`栖语评测数据集校验失败（${errors.length} 项）`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(`栖语评测数据集校验通过：${ids.size} 个唯一用例，全部为合成数据。`);
}
