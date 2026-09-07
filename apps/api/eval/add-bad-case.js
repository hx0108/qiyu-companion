'use strict';

// Bad Case 台账写入器（AI-02 Bad Case 闭环的记录端）：
//   node eval/add-bad-case.js --source persona-regression --case-id NORM-003 \
//     --summary "回复过短，未回应做饭话题" [--note "qwen 2026-09-07 样本"] [--status open|resolved]
// 追加写入 development/eval/bad-cases.jsonl（append-only，不改历史行），
// 结束时打印未解决条数。修复闭环见 development/eval/EVAL_BASELINE.md。

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`无法解析参数：${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = ['source', 'case-id', 'summary'];
  for (const key of required) {
    if (!args[key]) throw new Error(`缺少必填参数 --${key}（用法见文件头注释）`);
  }
  const status = args.status === 'resolved' ? 'resolved' : 'open';
  const ledgerPath = path.resolve(__dirname, '../../../development/eval/bad-cases.jsonl');
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const existing = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean) : [];
  const entry = {
    id: `bc-${String(existing.length + 1).padStart(3, '0')}`,
    source: args.source,
    case_id: args['case-id'],
    summary: args.summary,
    note: args.note || null,
    status,
    created_at: new Date().toISOString()
  };
  fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
  const open = [...existing.map(JSON.parse), entry].filter((row) => row.status === 'open').length;
  console.log(`已记录 ${entry.id}（${status}）。当前未解决 Bad Case：${open} 条。台账：${ledgerPath}`);
}

try { main(); } catch (error) { console.error(error.message); process.exit(1); }
