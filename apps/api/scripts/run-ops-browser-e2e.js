'use strict';

// 运营台生产写操作浏览器 E2E（个人项目可完成项）：
// 登录失败提示 → 账号密码登录 → RBAC 拒绝（REVIEWER 无审计权）→ 年龄复核决定 →
// MFA 账号错码/正确码 → 双人审批发布链路（无审批被拒 → 申请 → 第二人批准 → 执行 →
// 审计可见）。系统 Edge 无头（playwright-core，免下载 Chromium）。
// 诚实边界：双人审批的“两个账号”由同一测试过程扮演——机制上要求账号不同，
// 不代表真实组织内有两人参与。

const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const reviewerIdentity = require('../src/domain/reviewer-identity');

const MFA_SECRET = 'JBSWY3DPEHPK3PXP'; // 固定测试密钥（RFC 6238 向量常用值），仅 E2E 使用

async function main() {
  const { chromium } = require('playwright-core');
  const store = new DevelopmentStore();
  // MFA 测试账号（域层创建：scrypt + TOTP 密钥固定以便脚本算码）。
  reviewerIdentity.createReviewerAccount(store, { reviewer_id: 'rev_ops_e2e_mfa', username: 'dev-mfa', password: 'dev-mfa-local-only1', roles: ['REVIEWER'], mfa_required: true, mfa_secret: MFA_SECRET });
  const api = createApp({ store });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${api.address().port}`;
  // 管道预置：alice 的角色人格版本推进到 CANARY（走真实用户+内部接口，账户须先完成引导）。
  const characterId = await seedCanaryPersona(base, store);
  // 预置队列数据放在 seed 之后：R2/AGE_REVIEW 会阻断上面的用户侧建角色调用。
  const account = store.accounts.get('acct_dev_alice');
  account.age_status = 'AGE_REVIEW'; account.age_reason_codes = ['APPEAL_REQUESTED']; account.age_review_requested_at = new Date().toISOString();
  account.safety_mode = 'R2_CRISIS';
  store.complaints.set('cpl_ops_e2e', { complaint_id: 'cpl_ops_e2e', account_id: account.account_id, kind: 'SAFETY', target_resource_id: null, description: '运营台浏览器受控投诉', state: 'OPEN', resolution_note: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  store.deletionJobs.set('del_ops_e2e', { deletion_job_id: 'del_ops_e2e', account_id: account.account_id, scope: 'ACCOUNT', state: 'FAILED', physical_cleanup_state: 'DELETE_FAILED', created_at: new Date().toISOString() });

  const opsPort = await freePort();
  const ops = spawn(process.execPath, [path.resolve(__dirname, '../../ops/server.js')], {
    env: { ...process.env, QIYU_OPS_PORT: String(opsPort), QIYU_OPS_API_BASE_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  const browser = await chromium.launch({ channel: process.env.QIYU_E2E_BROWSER_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  const negativeResponses = [];
  // 负路径（错密 401 / RBAC 403 / 双人审批 409 / favicon 404）是本 E2E 的断言
  // 对象，浏览器会把它们记为资源加载 console error——单独归档，不计入
  // console_errors（那里只收真正的 JS/pageerror）。
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('response', (response) => { if (response.status() >= 400) negativeResponses.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  page.on('dialog', (dialog) => dialog.type() === 'prompt' ? dialog.accept(promptValue) : dialog.accept());
  let promptValue = '';
  try {
    await waitForHttp(`http://127.0.0.1:${opsPort}/`);
    await page.goto(`http://127.0.0.1:${opsPort}/`, { waitUntil: 'networkidle' });

    // 1) 错误密码：明确失败提示（不泄露具体原因）。
    await login(page, 'dev-reviewer', 'wrong-password-x');
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('登录失败'));

    // 2) 正确登录：REVIEWER 会话建立，队列可读。
    await login(page, 'dev-reviewer', 'dev-reviewer-local-only');
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('年龄申诉 · 1 项'));

    // 3) RBAC：REVIEWER 无 VIEW_AUDIT → 明确 403 提示。
    await page.getByRole('button', { name: '运营审计', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('VIEW_AUDIT'));

    // 4) 年龄复核决定（维持复核，理由写审计）。
    await page.getByRole('button', { name: '年龄申诉', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#queue')?.textContent.includes('APPEAL_REQUESTED'));
    promptValue = '浏览器 E2E：材料保持人工复核';
    await page.getByRole('button', { name: '维持复核' }).click();
    await page.waitForFunction(() => document.querySelector('#queue')?.textContent.includes('MAINTAIN_REVIEW'));

    // 5) 只读队列巡检。
    for (const [tab, expected] of [['投诉', 'cpl_ops_e2e'], ['安全事件', 'R2_CRISIS'], ['删除异常', 'del_ops_e2e']]) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      await page.waitForFunction((text) => document.querySelector('#queue')?.textContent.includes(text), expected);
    }

    // 6) 注销：会话吊销后本地清除。
    await page.locator('#logout').click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('会话已注销'));

    // 7) MFA：错码拒绝，正确动态码登录成功。
    await login(page, 'dev-mfa', 'dev-mfa-local-only1', '000000');
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('登录失败'));
    const totp = reviewerIdentity.totpAt(MFA_SECRET, Math.floor(Date.now() / 1000));
    await login(page, 'dev-mfa', 'dev-mfa-local-only1', totp);
    await page.waitForFunction(() => document.querySelector('#who')?.textContent.includes('dev-mfa'));
    await page.locator('#logout').click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('会话已注销'));

    // 8) 发布员登录：stable 无双人审批被拒（409）→ 申请审批。
    await login(page, 'dev-release', 'dev-release-local-only');
    await page.getByRole('button', { name: '人格发布', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#queue')?.textContent.includes('CANARY'));
    promptValue = 'canary-report-e2e';
    await page.getByRole('button', { name: `发布稳定 v2` }).click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('DUAL_APPROVAL_REQUIRED'));
    promptValue = '浏览器 E2E：灰度报告已复核，申请发布';
    await page.getByRole('button', { name: '申请发布审批 v2' }).click();
    // 成功提示会被队列刷新覆盖（竞态）：申请是否成立由下一步的 REQUESTED 断言验证。
    await page.locator('#logout').click();

    // 9) 第二人（发布兼安全管理员）批准 → 执行发布 → 审计可见。
    await login(page, 'dev-release-admin', 'dev-release-admin-local');
    await page.getByRole('button', { name: '双人审批', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#queue')?.textContent.includes('REQUESTED'));
    promptValue = '浏览器 E2E：第二审批人核对灰度报告';
    await page.getByRole('button', { name: '批准（需他人申请）' }).click();
    await page.waitForFunction(() => document.querySelector('#queue')?.textContent.includes('APPROVED'));
    await page.getByRole('button', { name: '人格发布', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#queue')?.textContent.includes('CANARY'));
    promptValue = 'canary-report-e2e';
    await page.getByRole('button', { name: '发布稳定 v2' }).click();
    // 发布成功后队列刷新为 STABLE（成功提示文案会被刷新覆盖，以状态为准）。
    await page.waitForFunction(() => document.querySelector('#queue')?.textContent.includes('"STABLE"'));
    await page.getByRole('button', { name: '运营审计', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#queue')?.textContent.includes('PERSONA_RELEASED_STABLE'));

    console.log(JSON.stringify({
      acceptance: 'passed',
      flow: ['login-fail', 'login-session', 'rbac-denied', 'age-decision', 'queues', 'logout', 'mfa-reject-and-pass', 'dual-approval-block', 'request', 'second-approver', 'execute-stable', 'audit-visible'],
      console_errors: consoleErrors.length,
      expected_negative_http: negativeResponses,
      note: '双人审批的两个账号由同一测试过程扮演：机制要求账号不同，不构成真实组织的职责分离。'
    }));
    if (consoleErrors.length > 0) throw new Error(`控制台存在非预期错误：${JSON.stringify(consoleErrors)}`);
  } catch (error) {
    console.error('E2E 失败于状态：', await page.locator('#status').textContent().catch(() => 'n/a'), '| 控制台错误：', JSON.stringify(consoleErrors));
    throw error;
  } finally {
    await browser.close().catch(() => {});
    ops.kill();
    await new Promise((resolve) => api.close(resolve));
  }
}

async function login(page, username, password, totp) {
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  if (totp !== undefined) await page.locator('#totp').fill(totp);
  await page.locator('#login button').click();
}

// 预置 CANARY 人格版本：走用户 API 建角色 + 内部接口推进 DRAFT→EVALUATING→SHADOW→CANARY。
async function seedCanaryPersona(base, store) {
  const userHeaders = { authorization: 'Bearer dev-alice-token', 'content-type': 'application/json', 'idempotency-key': 'seed-c' };
  const notices = await fetch(`${base}/api/v1/required-notices`, { headers: { authorization: 'Bearer dev-alice-token' } }).then((response) => response.json());
  await fetch(`${base}/api/v1/required-notices/${notices.notices[0].notice_id}/displayed`, { method: 'POST', headers: userHeaders, body: JSON.stringify({ notice_version: notices.notices[0].notice_version }) });
  await fetch(`${base}/api/v1/age/declarations`, { method: 'POST', headers: { ...userHeaders, 'idempotency-key': 'seed-a' }, body: JSON.stringify({ date_of_birth: '1990-01-01', confirmed_18_plus: true }) });
  const character = await fetch(`${base}/api/v1/characters`, { method: 'POST', headers: { ...userHeaders, 'idempotency-key': 'seed-c2' }, body: JSON.stringify({ name: 'E2E 发布角色', persona: { worldview: '测试世界观', age_setting: '27', relationship_to_user: '朋友', personality: '安静', expression_style: '短句', hard_boundaries: ['不复刻真人'], example_behaviors: [] } }) }).then((response) => response.json());
  const characterId = character.character.character_id;
  const internal = (pathName, body, key) => fetch(`${base}/internal${pathName}`, { method: 'POST', headers: { authorization: 'Bearer reviewer-dev-token', 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) }).then((response) => response.json());
  // 草稿走用户接口（版本 2：与建站 persona 有一处字段差异即可）。
  const created = await fetch(`${base}/api/v1/characters/${characterId}/persona-versions`, { method: 'POST', headers: { ...userHeaders, 'idempotency-key': 'seed-d' }, body: JSON.stringify({ expected_version: 1, note: 'E2E 草稿', persona: { worldview: '测试世界观改', age_setting: '27', relationship_to_user: '朋友', personality: '安静', expression_style: '短句', hard_boundaries: ['不复刻真人'], example_behaviors: [] } }) }).then((response) => response.json());
  if (!created.persona_version) throw new Error(`草稿创建失败：${JSON.stringify(created)}`);
  await internal(`/persona-versions/${characterId}/2/evaluate`, { suite_version: 'persona-regression-v1', critical_pass_rate: 1, overall_pass_rate: 0.9, report_ref: 'seed-eval' }, 'seed-e');
  await internal(`/persona-versions/${characterId}/2/shadow`, {}, 'seed-s');
  await internal(`/persona-versions/${characterId}/2/canary`, { traffic_percent: 5, shadow_report_ref: 'seed-shadow' }, 'seed-ca');
  const finalState = [...store.characters.get(characterId).persona_history].find((entry) => entry.version === 2).state;
  if (finalState !== 'CANARY') throw new Error(`预置失败：期望 CANARY，实际 ${finalState}`);
  return characterId;
}

function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
async function waitForHttp(url) { for (let i = 0; i < 40; i += 1) { try { const response = await fetch(url); if (response.ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error('ops server did not start'); }
main().catch((error) => { console.error(error); process.exit(1); });
