#!/usr/bin/env node
'use strict';

// 六项能力 A3 PG 隔离测试编排（P3.5）：照 run-pg-followup-dispatch.js——
// 检测 Docker → 起临时库（tmpfs，端口 54329，迁移含 066/067）→ 设 env 跑
// pg-companion-plans 测试 → 无论成败 down -v 清理。Docker 不可用且未显式
// 提供 QIYU_PG_TEST_DATABASE_URL 时打印便携版指引并以退出码 0 结束（不假装
// 跑过）。与 A1/A2 编排共用同一 compose 文件（每次都是全新 tmpfs 库）。

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const pg = require('pg');

// healthcheck 通过后连接仍可能被初始化期重置（A2 轮登记的瞬时问题）：
// 正式跑测试前用轻量连接探测预热，最多 5 次 × 2 秒。
async function warmupConnection(databaseUrl) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const client = new pg.Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      await client.query('SELECT 1');
      return true;
    } catch {
      // 继续重试
    } finally {
      await client.end().catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const COMPOSE_FILE = path.join(REPO_ROOT, 'infra', 'postgres', 'docker-compose.test.yml');
const TEST_DATABASE_URL = process.env.QIYU_PG_TEST_DATABASE_URL || 'postgres://postgres:qiyu-a1-test-only@127.0.0.1:54329/qiyu_a1_test';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32', ...options });
  return result.status === 0;
}

function dockerAvailable() {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore', shell: process.platform === 'win32' });
  return result.status === 0;
}

async function main() {
  if (process.env.QIYU_PG_TEST_DATABASE_URL) {
    // 外部库直连模式：跳过编排（便携版 PG 或远程测试库）。
    console.log('[pg-a3-test] 使用 QIYU_PG_TEST_DATABASE_URL 直连，不起 Docker。');
    return run(process.execPath, ['--test', path.join(__dirname, '..', 'test', 'pg-companion-plans.test.js')], {
      env: { ...process.env, QIYU_PG_TEST_DATABASE_URL: process.env.QIYU_PG_TEST_DATABASE_URL }
    }) ? 0 : 1;
  }
  if (!dockerAvailable()) {
    console.log('[pg-a3-test] Docker 不可用，测试未运行（不算失败）。两个选择：');
    console.log('  1) 启动 Docker Desktop 后重跑 npm run test:pg-companion-plans；');
    console.log('  2) 用便携版 PostgreSQL 在 54329 端口建库 qiyu_a1_test 并跑 infra/postgres/init 下两个脚本，然后设 QIYU_PG_TEST_DATABASE_URL 直连。');
    return 0;
  }
  console.log('[pg-a3-test] 启动隔离测试库（tmpfs，端口 54329）…');
  // 先清掉可能残留的旧容器/卷（compose up 对已存在容器幂等复用，残留数据
  // 会让固定 UUID 的种子撞主键）。
  run('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v']);
  if (!run('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait'])) {
    run('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v']);
    console.error('[pg-a3-test] 临时库启动失败。');
    return 1;
  }
  try {
    console.log('[pg-a3-test] 库就绪，预热连接…');
    if (!(await warmupConnection(TEST_DATABASE_URL))) {
      console.error('[pg-a3-test] 预热连接失败（连续 5 次）。');
      return 1;
    }
    console.log('[pg-a3-test] 运行 pg-companion-plans 测试…');
    const passed = run(process.execPath, ['--test', path.join(__dirname, '..', 'test', 'pg-companion-plans.test.js')], {
      env: { ...process.env, QIYU_PG_TEST_DATABASE_URL: TEST_DATABASE_URL }
    });
    return passed ? 0 : 1;
  } finally {
    console.log('[pg-a3-test] 清理临时库（down -v）。');
    run('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v']);
  }
}

main().then((code) => process.exit(code ?? 0)).catch((error) => { console.error('[pg-a3-test] 编排失败：', error.message); process.exit(1); });
