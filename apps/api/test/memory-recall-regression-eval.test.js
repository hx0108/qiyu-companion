'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');

test('固定记忆召回回归（AI-04）：确认事实 Top-1、删除零召回与账户/角色隔离均通过', { timeout: 30_000 }, async () => {
  const script = path.resolve(__dirname, '../eval/run-memory-recall-regression.js');
  const { stdout, stderr } = await new Promise((resolve, reject) => {
    execFile(process.execPath, [script], { timeout: 20_000 }, (error, stdout, stderr) => {
      if (error && error.code !== 0) return reject(new Error('评测进程退出码 ' + error.code + '\n' + stdout + '\n' + stderr));
      resolve({ stdout, stderr });
    });
  });
  assert.match(stdout, /已确认事实 Top-1 错误率.*0\/3.*PASS/);
  assert.match(stdout, /已删除记忆召回.*0.*PASS/);
  assert.match(stdout, /跨账户\/角色召回.*0.*PASS/);
  assert.match(stdout, /固定召回门禁通过/);
});
