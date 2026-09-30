'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');

test('陪伴评测运行包：dry-run 验证96条数据并按重复次数展开，不写评测结果', { timeout: 20_000 }, async () => {
  const script = path.resolve(__dirname, '../eval/prepare-companion-eval-run.js');
  const { stdout, stderr } = await new Promise((resolve, reject) => {
    execFile(process.execPath, [script, '--dry-run', '--run-id', 'test-companion-v01', '--repetitions', '3'], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${stdout}\n${stderr}`));
      resolve({ stdout, stderr });
    });
  });
  assert.equal(stderr, '');
  assert.match(stdout, /文本\/长期请求 216 条/u);
  assert.match(stdout, /TTS盲听 24 条/u);
  assert.match(stdout, /dry-run，未写文件/u);
});
