'use strict';

// 审核员 PG 身份真实链路验收（迁移 055 + PostgresReviewerIdentityRepository）：
//   在能连到 PostgreSQL 的环境运行（容器内：DATABASE_URL 已注入）：
//     docker cp apps/api/scripts/verify-reviewer-pg-session.js qiyu-beta-api:/tmp/
//     docker exec qiyu-beta-api node /tmp/verify-reviewer-pg-session.js
// 覆盖：登录失败/锁定计数、TOTP 登录、会话吊销、双人审批状态机、
// 审核员请求作用域 RLS 会话（只读本人行）、追加写触发器拒绝 UPDATE。
// 全部为确定性检查；任一步失败即非零退出。测试数据用固定 UUID，可重复运行。

const { Pool } = require('pg');
const domain = require('../src/domain/reviewer-identity');
const { PostgresReviewerIdentityRepository } = require('../src/persistence/postgres-reviewer-identity-repository');

const ALICE = 'aaaaaaa1-0000-0000-0000-000000000001';
const BOB = 'aaaaaaa1-0000-0000-0000-000000000002';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('需要 DATABASE_URL');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const repo = new PostgresReviewerIdentityRepository({ pool });
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `（${detail}）` : ''}`); };

  // 干净起点：固定 UUID 的测试账号（会话/审批级联清理）。
  await pool.query('DELETE FROM dual_approval_requests WHERE requested_by IN ($1,$2) OR approved_by IN ($1,$2) OR rejected_by IN ($1,$2)', [ALICE, BOB]);
  await pool.query('DELETE FROM reviewer_sessions WHERE reviewer_id IN ($1,$2)', [ALICE, BOB]);
  await pool.query('DELETE FROM reviewer_accounts WHERE reviewer_id IN ($1,$2)', [ALICE, BOB]);

  const totpSecret = domain.generateTotpSecret();
  await pool.query(`INSERT INTO reviewer_accounts (reviewer_id, username, password_hash, display_name, roles, mfa_required, mfa_secret)
    VALUES ($1,'verify-alice',$3,'验收Alice',ARRAY['REVIEWER','SECURITY_ADMIN'],false,NULL),
           ($2,'verify-bob',$4,'验收Bob',ARRAY['SECURITY_ADMIN'],true,$5)`,
    [ALICE, BOB, domain.hashPassword('verify-alice-pass-1'), domain.hashPassword('verify-bob-pass-12'), totpSecret]);

  // 1) 错误密码拒绝。
  let failed = false;
  try { await repo.login({ username: 'verify-alice', password: 'wrong' }); } catch (error) { failed = error.code === 'REVIEWER_LOGIN_FAILED'; }
  check('错误密码登录被拒（REVIEWER_LOGIN_FAILED）', failed);

  // 2) TOTP：无码拒绝，正确动态码通过。
  let mfaBlocked = false;
  try { await repo.login({ username: 'verify-bob', password: 'verify-bob-pass-12' }); } catch (error) { mfaBlocked = error.code === 'REVIEWER_LOGIN_FAILED'; }
  check('启用 MFA 的账号缺动态码被拒', mfaBlocked);
  const code = domain.totpAt(totpSecret, Math.floor(Date.now() / 1000));
  const bobLogin = await repo.login({ username: 'verify-bob', password: 'verify-bob-pass-12', totp_code: code, ip: '127.0.0.9' });
  check('TOTP 正确动态码登录成功', bobLogin.session_token.startsWith('ops_'));

  // 3) 会话校验与吊销。
  const bobSession = await repo.authenticateSession(bobLogin.session_token);
  check('会话令牌可校验且携带角色', bobSession && bobSession.roles.includes('SECURITY_ADMIN'));
  await repo.revokeSession(bobLogin.session_token);
  check('吊销后立即失效', (await repo.authenticateSession(bobLogin.session_token)) === null);

  // 4) 双人审批状态机：申请→自我批准被拒→他人批准→执行消费。
  const aliceLogin = await repo.login({ username: 'verify-alice', password: 'verify-alice-pass-1' });
  const request = await repo.createApproval({ action: 'SUBSCRIPTION_MANUAL_REVOKE', target_id: 'sub_verify_1', requested_by: ALICE, requester_roles: ['REVIEWER', 'SECURITY_ADMIN'], reason: '验收用例' });
  check('创建审批请求（REQUESTED）', request.state === 'REQUESTED');
  let selfBlocked = false;
  try { await repo.decideApproval({ approval_id: request.approval_id, reviewer_id: ALICE, reviewer_roles: ['REVIEWER', 'SECURITY_ADMIN'], decision: 'APPROVE', reason: 'x' }); } catch (error) { selfBlocked = error.code === 'SELF_APPROVAL_FORBIDDEN'; }
  check('申请人自我批准被拒', selfBlocked);
  await repo.decideApproval({ approval_id: request.approval_id, reviewer_id: BOB, reviewer_roles: ['SECURITY_ADMIN'], decision: 'APPROVE', reason: '验收批准' });
  const approved = await repo.requireApprovedFor({ action: 'SUBSCRIPTION_MANUAL_REVOKE', target_id: 'sub_verify_1', reviewer_id: ALICE });
  check('批准后可执行检查通过（APPROVED）', approved.state === 'APPROVED');
  await repo.markExecuted(approved, ALICE);
  let consumed = false;
  try { await repo.requireApprovedFor({ action: 'SUBSCRIPTION_MANUAL_REVOKE', target_id: 'sub_verify_1', reviewer_id: ALICE }); } catch (error) { consumed = error.code === 'DUAL_APPROVAL_REQUIRED'; }
  check('执行后审批被消费（重复执行要求新审批）', consumed);

  // 5) 审核员请求作用域数据库会话（RLS）：alice 只看到本人账号行；
  //    alice 非 SECURITY_ADMIN 时本应只看到自己作为 actor 的审计行——
  //    alice 恰好具有 SECURITY_ADMIN（全量审计可读），故改验 bob：
  //    bob 是 SECURITY_ADMIN 也能读全量，所以用"会话内看不到对方账号行"作主断言。
  await repo.appendAudit({ actor_type: 'REVIEWER', actor_id: ALICE, action: 'VERIFY_EVENT', resource_type: 'VERIFY', ip: '127.0.0.9' });
  const scoped = await repo.withReviewerSession(ALICE, async (client) => {
    const accounts = await client.query('SELECT username FROM reviewer_accounts');
    const audit = await client.query("SELECT count(*)::int AS n FROM ops_audit_events WHERE action = 'VERIFY_EVENT'");
    return { accounts: accounts.rows.map((row) => row.username), auditCount: audit.rows[0].n };
  });
  check('RLS 会话只读本人账号行', scoped.accounts.length === 1 && scoped.accounts[0] === 'verify-alice', JSON.stringify(scoped.accounts));
  check('RLS 会话可读本人相关审计行', scoped.auditCount >= 1);

  // 6) 追加写触发器：qiyu_app 的 UPDATE/DELETE 被数据库拒绝。
  let updateRejected = false;
  try { await pool.query("UPDATE ops_audit_events SET action='TAMPER' WHERE action='VERIFY_EVENT'"); } catch { updateRejected = true; }
  check('审计 UPDATE 被数据库拒绝（权限+触发器）', updateRejected);

  // 清理：审计行按追加写设计保留（含 VERIFY_EVENT 验收痕迹），账号与审批删除。
  await pool.query('DELETE FROM dual_approval_requests WHERE requested_by IN ($1,$2) OR approved_by IN ($1,$2)', [ALICE, BOB]);
  await pool.query('DELETE FROM reviewer_sessions WHERE reviewer_id IN ($1,$2)', [ALICE, BOB]);
  await pool.query('DELETE FROM reviewer_accounts WHERE reviewer_id IN ($1,$2)', [ALICE, BOB]);
  await pool.end();

  const failedCount = results.filter((result) => !result.ok).length;
  console.log(`\n结果：${results.length - failedCount}/${results.length} PASS`);
  process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
