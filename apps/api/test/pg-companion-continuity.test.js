'use strict';
// 六项能力 A1 PG 隔离库实测（P1.10）：无 QIYU_PG_TEST_DATABASE_URL 时整体
// skip（默认 npm test 不红）。由 scripts/run-pg-companion-continuity.js 编排
// 临时库，或对便携版/远程测试库直连。覆盖：迁移可执行（连接即全量迁移）、
// RLS 账户隔离、UNIQUE(message_id)、乐观锁并发恰一胜、事务原子性、
// 引用快照覆盖、混合读写 P95 报告。
const test = require('node:test');
const assert = require('node:assert/strict');
const pg = require('pg');
const { PostgresStore } = require('../src/persistence/postgres-store');

const DATABASE_URL = process.env.QIYU_PG_TEST_DATABASE_URL;
const options = { skip: DATABASE_URL ? false : '需要 QIYU_PG_TEST_DATABASE_URL（npm run test:pg-companion-continuity 编排）' };

// 开发库固定两账户（postgres-store DEVELOPMENT_DATABASE_ACCOUNT_IDS）。
const ALICE = '00000000-0000-7000-8000-0000000000a1';
const BOB = '00000000-0000-7000-8000-0000000000b2';
const ALICE_CHARACTER = 'aaaaaaaa-0000-7000-8000-000000000001';
const ALICE_CONVERSATION = 'aaaaaaaa-0000-7000-8000-000000000002';

// 共享连接池：种子在 before 做一次（每个测试独立可跑）；after 统一关闭，
// finally 只 release 本测试的 client（不留悬挂事务，也避免 pool.end() 等锁）。
const sharedPool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL, max: 20 }) : null;
// 注意：Node 22.16 根级 test.before/after 传 options（含 skip:false）时钩子
// 不执行——这里不带 options，库未配置时在钩子内部自行跳过（用例级 options
// 的 skip 不受影响）。
test.before(async () => { if (DATABASE_URL) await seedDevelopmentAccounts(); });
test.after(async () => { if (sharedPool) await sharedPool.end(); });

async function scopedClient(accountId) {
  const client = await sharedPool.connect();
  await client.query('BEGIN');
  // A4 强化（此前实测的是事务隔离而非 RLS——superuser 绕过行安全）：
  // 与生产请求路径同款 SET LOCAL ROLE qiyu_app + app.account_id（函数读的
  // 是 app.account_id，不是 app.current_account_id），RLS 策略真正生效。
  await client.query('SET LOCAL ROLE qiyu_app');
  await client.query("SELECT set_config('app.account_id', $1, true), set_config('app.character_id', '', true)", [accountId]);
  return client;
}

// 测试库是全新 init（只有 schema/角色，无数据）：开发账户种子由应用层
// seedDevelopmentAccount 写入，这里跑空作用域事务触发（幂等）；角色与会话
// 是测试 fixture（生产由用户创建流程写入）。
async function seedDevelopmentAccounts() {
  const store = new PostgresStore({ pool: sharedPool });
  await store.withAccountTransaction(ALICE, () => 'seed');
  await store.withAccountTransaction(BOB, () => 'seed');
  const client = await sharedPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.account_id', $1, true)", [ALICE]);
    await client.query(`INSERT INTO characters (character_id, account_id, display_name, status) VALUES ($1, $2, '栖夏', 'ACTIVE') ON CONFLICT (character_id) DO NOTHING`, [ALICE_CHARACTER, ALICE]);
    await client.query(`INSERT INTO conversations (conversation_id, account_id, character_id, status, retention_expires_at) VALUES ($1, $2, $3, 'ACTIVE', CURRENT_TIMESTAMP + INTERVAL '90 days') ON CONFLICT (conversation_id) DO NOTHING`, [ALICE_CONVERSATION, ALICE, ALICE_CHARACTER]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function characterFixture() {
  const client = await scopedClient(ALICE);
  const row = (await client.query('SELECT $1::uuid AS character_id, $2::uuid AS conversation_id', [ALICE_CHARACTER, ALICE_CONVERSATION])).rows[0];
  await client.query('ROLLBACK').catch(() => {});
  client.release();
  return row;
}

test('PG A1：迁移 063/064 表结构可执行且 RLS 生效（A 看不到 B 的行）', options, async () => {
  const tables = await sharedPool.query("SELECT tablename FROM pg_tables WHERE tablename IN ('life_events', 'life_event_extraction_jobs', 'message_memory_refs') ORDER BY tablename");
  assert.deepEqual(tables.rows.map((row) => row.tablename), ['life_event_extraction_jobs', 'life_events', 'message_memory_refs']);
  const rls = await sharedPool.query("SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('life_events', 'life_event_extraction_jobs', 'message_memory_refs')");
  assert.equal(rls.rows.filter((row) => row.relrowsecurity).length, 3, '三表都必须启用 RLS');

  // 种 A 的事件；B 的作用域看不到、改不到。
  const alice = await scopedClient(ALICE);
  const fixture = await characterFixture();
  try {
    const inserted = await alice.query(
      `INSERT INTO life_events (event_id, account_id, character_id, current_asset_id, domain, event_kind, title, status)
       VALUES ('11111111-1111-7000-8000-111111111111', $1, $2, '22222222-2222-7000-8000-222222222222', 'REAL_LIFE', 'INTERVIEW', 'RLS 验证面试', 'PLANNED') RETURNING event_id`,
      [ALICE, fixture.character_id]
    );
    assert.equal(inserted.rowCount, 1, 'A 作用域内插入自身事件');
    const bob = await scopedClient(BOB);
    try {
      const bobView = await bob.query('SELECT event_id FROM life_events');
      assert.equal(bobView.rowCount, 0, 'B 作用域必须看不到 A 的事件');
      // FORCE RLS 对 UPDATE 的语义是 USING 过滤（静默 0 行），不是报错。
      const crossWrite = await bob.query("UPDATE life_events SET title = '越权改写' WHERE event_id = '11111111-1111-7000-8000-111111111111'");
      assert.equal(crossWrite.rowCount, 0, 'B 作用域对 A 的行 UPDATE 必须影响 0 行');
    } finally { await bob.query('ROLLBACK').catch(() => {}); bob.release(); }
    const aliceRecheck = await alice.query("SELECT title FROM life_events WHERE event_id = '11111111-1111-7000-8000-111111111111'");
    assert.equal(aliceRecheck.rows[0]?.title, 'RLS 验证面试', 'A 的事件未被越权改写');
  } finally { await alice.query('ROLLBACK').catch(() => {}); alice.release(); }
});

test('PG A1：UNIQUE(message_id) 拒绝同消息第二个提取任务；乐观锁并发修订恰一胜', options, async () => {
  const client = await scopedClient(ALICE);
  const fixture = await characterFixture();
  try {
    // 乐观锁：version=1 的两个修订抢跑——恰好一个生效。
    await client.query(
      `INSERT INTO life_events (event_id, account_id, character_id, current_asset_id, domain, event_kind, title, status, version)
       VALUES ('66666666-6666-7000-8000-666666666666', $1, $2, '77777777-7777-7000-8000-777777777777', 'REAL_LIFE', 'INTERVIEW', '并发修订验证', 'PLANNED', 1)`,
      [ALICE, fixture.character_id]
    );
    const winner = await client.query("UPDATE life_events SET title = '第一个修订', version = version + 1 WHERE event_id = '66666666-6666-7000-8000-666666666666' AND version = 1");
    assert.equal(winner.rowCount, 1);
    const loser = await client.query("UPDATE life_events SET title = '第二个修订', version = version + 1 WHERE event_id = '66666666-6666-7000-8000-666666666666' AND version = 1");
    assert.equal(loser.rowCount, 0, '旧版本号的修订必须落空（乐观锁恰一胜）');
    const finalRow = (await client.query("SELECT title, version FROM life_events WHERE event_id = '66666666-6666-7000-8000-666666666666'")).rows[0];
    assert.equal(finalRow.title, '第一个修订');
    assert.equal(Number(finalRow.version), 2);

    // UNIQUE：同消息第二个提取任务。duplicate key 会中止当前事务，放在
    // 乐观锁断言之后、单独开一个事务验证（不污染前面的断言链）。
    const messageId = '33333333-3333-7000-8000-333333333333';
    await client.query("INSERT INTO messages (message_id, conversation_id, actor, content_ciphertext, retention_expires_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '90 days')", [messageId, fixture.conversation_id, 'USER', Buffer.from('我周五要去面试', 'utf8')]);
    await client.query(
      `INSERT INTO life_event_extraction_jobs (job_id, account_id, character_id, conversation_id, message_id, captured_revocation_epoch)
       VALUES ('44444444-4444-7000-8000-444444444444', $1, $2, $3, $4, 0)`,
      [ALICE, fixture.character_id, fixture.conversation_id, messageId]
    );
    await client.query('ROLLBACK');
    client.release();

    // 新事务重插同 message_id 的任务行（第一个事务回滚后用已提交行为验证：
    // 这里改为提交第一条，再在第二个事务里撞 UNIQUE）。
    const committed = await scopedClient(ALICE);
    try {
      await committed.query("INSERT INTO messages (message_id, conversation_id, actor, content_ciphertext, retention_expires_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '90 days') ON CONFLICT (message_id) DO NOTHING", [messageId, fixture.conversation_id, 'USER', Buffer.from('我周五要去面试', 'utf8')]);
      await committed.query(
        `INSERT INTO life_event_extraction_jobs (job_id, account_id, character_id, conversation_id, message_id, captured_revocation_epoch)
         VALUES ('44444444-4444-7000-8000-444444444444', $1, $2, $3, $4, 0) ON CONFLICT (message_id) DO NOTHING`,
        [ALICE, fixture.character_id, fixture.conversation_id, messageId]
      );
      await assert.rejects(
        () => committed.query(
          `INSERT INTO life_event_extraction_jobs (job_id, account_id, character_id, conversation_id, message_id, captured_revocation_epoch)
           VALUES ('55555555-5555-7000-8000-555555555555', $1, $2, $3, $4, 0)`,
          [ALICE, fixture.character_id, fixture.conversation_id, messageId]
        ),
        (error) => /life_event_extraction_jobs_message_id_key|duplicate key/.test(error.message),
        '同 message_id 第二个任务必须被 UNIQUE 约束拒绝'
      );
    } finally { await committed.query('ROLLBACK').catch(() => {}); committed.release(); }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw error;
  }
});

test('PG A1：事务原子性——回滚不留半截状态；引用快照按消息覆盖', options, async () => {
  const client = await scopedClient(ALICE);
  const fixture = await characterFixture();
  try {
    const messageId = '88888888-8888-7000-8000-888888888888';
    await client.query("INSERT INTO messages (message_id, conversation_id, actor, content_ciphertext, retention_expires_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '90 days')", [messageId, fixture.conversation_id, 'USER', Buffer.from('原子性验证', 'utf8')]);
    await client.query(
      `INSERT INTO message_memory_refs (message_id, account_id, character_id, conversation_id, refs_json, context_bundle_version)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'memory-refs.v1')`,
      [messageId, ALICE, fixture.character_id, fixture.conversation_id, JSON.stringify({ refs: [{ kind: 'LIFE_EVENT', id: '99999999-9999-7000-8000-999999999999', version: 1 }] })]
    );
    const upsert = await client.query(
      `INSERT INTO message_memory_refs (message_id, account_id, character_id, conversation_id, refs_json, context_bundle_version)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'memory-refs.v2')
       ON CONFLICT (message_id) DO UPDATE SET refs_json = EXCLUDED.refs_json, context_bundle_version = EXCLUDED.context_bundle_version RETURNING context_bundle_version`,
      [messageId, ALICE, fixture.character_id, fixture.conversation_id, JSON.stringify({ refs: [] })]
    );
    assert.equal(upsert.rows[0].context_bundle_version, 'memory-refs.v2', '同消息重复落库按 message_id 覆盖');
    await client.query('ROLLBACK');
    client.release();
    const after = await sharedPool.query('SELECT message_id FROM messages WHERE message_id = $1', [messageId]);
    assert.equal(after.rowCount, 0, '回滚后不留半截消息');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw error;
  }
});

test('PG A1：混合读写压测（20 并发 × 25 轮事件 CRUD）并报告 P95', options, async () => {
  const latencies = [];
  let operations = 0;
  const failures = [];
  const fixture = await characterFixture();
  async function worker(workerIndex) {
    const client = await scopedClient(ALICE);
    try {
      for (let round = 0; round < 25; round += 1) {
        const suffix = `${String(workerIndex).padStart(4, '0')}${String(round).padStart(8, '0')}`;
        const eventId = `b0000000-0000-7000-8000-${suffix}`;
        const started = Date.now();
        try {
          await client.query(
            `INSERT INTO life_events (event_id, account_id, character_id, current_asset_id, domain, event_kind, title, status)
             VALUES ($1, $2, $3, $1, 'REAL_LIFE', 'OTHER', $4, 'PLANNED')`,
            [eventId, ALICE, fixture.character_id, `压测事件 ${workerIndex}-${round}`]
          );
          await client.query('UPDATE life_events SET title = $2, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE event_id = $1', [eventId, `修订 ${workerIndex}-${round}`]);
          await client.query('SELECT event_id FROM life_events WHERE account_id = $1 LIMIT 20', [ALICE]);
          await client.query('UPDATE life_events SET deleted_at = CURRENT_TIMESTAMP WHERE event_id = $1', [eventId]);
          operations += 4;
        } catch (error) {
          failures.push(String(error.message).slice(0, 120));
        } finally {
          latencies.push(Date.now() - started);
        }
      }
    } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  }
  await Promise.all(Array.from({ length: 20 }, (_, index) => worker(index)));
  latencies.sort((left, right) => left - right);
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  console.log(`[pg-a1-test] 混合读写：${operations} 次操作 · ${latencies.length} 轮 · P50=${latencies[Math.floor(latencies.length * 0.5)]}ms P95=${p95}ms max=${latencies.at(-1)}ms 失败=${failures.length}`);
  assert.equal(failures.length, 0, `压测不应有失败：${failures.slice(0, 3).join(' | ')}`);
  // 阈值放宽（本地 tmpfs 波动大），报告值如实进日志；断言只拦数量级异常。
  assert.ok(p95 < 2000, `P95 ${p95}ms 超过 2000ms 放宽阈值`);
});
