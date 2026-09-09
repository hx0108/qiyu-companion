'use strict';

const queues = [
  ['年龄申诉', '/age-reviews', 'age_reviews'], ['内容权利', '/content-rights-reviews', 'reviews'],
  ['摘要 DLQ', '/conversation-summary-dead-letters', 'dead_letters'], ['向量 DLQ', '/asset-embedding-dead-letters', 'dead_letters'],
  ['投诉', '/complaints', 'complaints'], ['安全事件', '/safety-events', 'safety_events'],
  ['删除异常', '/deletion-exceptions', 'deletion_exceptions'], ['人格发布', '/persona-releases', 'persona_releases'],
  ['双人审批', '/dual-approvals', 'dual_approvals'], ['运营审计', '/audit-events', 'audit_events'],
  ['成本与时延', '/cost-report', 'rows']
];
let token = '';
let active = 0;
const tabs = document.querySelector('#tabs');
const queue = document.querySelector('#queue');
const status = document.querySelector('#status');

queues.forEach(([label], index) => {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
  button.addEventListener('click', () => { active = index; renderTabs(); load(); }); tabs.append(button);
});

// 账号登录（正式路径）：用户名 + 密码（scrypt）+ TOTP（启用 MFA 的账号）→
// 会话令牌 ops_*（8 小时，可吊销）；令牌只存当前页面内存。
document.querySelector('#login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await fetch('/_api/internal/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ username: document.querySelector('#username').value.trim(), password: document.querySelector('#password').value, totp_code: document.querySelector('#totp').value.trim() || undefined }) });
  document.querySelector('#password').value = ''; document.querySelector('#totp').value = '';
  const payload = await response.json();
  if (!response.ok) { status.textContent = `登录失败：${payload.error?.code || ''} ${payload.error?.message || response.status}`; return; }
  token = payload.session_token;
  document.querySelector('#who').textContent = `${payload.reviewer.display_name}（${(payload.reviewer.roles || []).join('+')}，会话 ${new Date(payload.session.expires_at).toLocaleTimeString()} 过期）`;
  showSession(true); load();
});
document.querySelector('#logout').addEventListener('click', async () => {
  if (token.startsWith('ops_')) await fetch('/_api/internal/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() } });
  token = ''; showSession(false); status.textContent = '会话已注销（服务端吊销 + 本地清除）。'; queue.replaceChildren();
});
document.querySelector('#use-token').addEventListener('click', () => { showSession(false); document.querySelector('#auth').hidden = false; });
document.querySelector('#auth').addEventListener('submit', (event) => {
  event.preventDefault(); token = document.querySelector('#token').value; document.querySelector('#token').value = '';
  document.querySelector('#who').textContent = '静态开发令牌（全部角色，仅本地开发）'; showSession(true); load();
});
function showSession(on) { document.querySelector('#session').hidden = !on; document.querySelector('#login').hidden = on; }

function renderTabs() { [...tabs.children].forEach((item, index) => item.classList.toggle('active', index === active)); }
async function load() {
  if (!token) return status.textContent = '请输入审核员令牌；令牌只保存在当前页面内存中。';
  const [label, endpoint, key] = queues[active]; status.textContent = `正在加载：${label}`; queue.replaceChildren();
  try {
    const response = await fetch(`/_api/internal${endpoint}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error?.message || `HTTP ${response.status}`);
    const items = payload[key] || []; status.textContent = `${label} · ${items.length} 项 · ${payload.note || ''}`;
    if (!items.length) return queue.append(document.querySelector('#empty').content.cloneNode(true));
    items.forEach((item) => {
      const card = document.createElement('article'); card.className = 'card';
      const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = item.state || item.safety_mode || 'OPEN';
      const pre = document.createElement('pre'); pre.textContent = JSON.stringify(item, null, 2);
      card.append(tag, pre); appendActions(card, endpoint, item); queue.append(card);
    });
  } catch (error) { status.textContent = `加载失败：${error.message}`; }
}

function appendActions(card, endpoint, item) {
  const actions = [];
  if (endpoint === '/age-reviews') {
    actions.push(['放行', () => decision(`/age-reviews/${encodeURIComponent(item.account_id)}/decisions`, { decision: 'PASS' })]);
    actions.push(['维持复核', () => decision(`/age-reviews/${encodeURIComponent(item.account_id)}/decisions`, { decision: 'MAINTAIN_REVIEW' })]);
    actions.push(['确认未成年', () => decision(`/age-reviews/${encodeURIComponent(item.account_id)}/decisions`, { decision: 'DENIED_MINOR' })]);
  } else if (endpoint === '/content-rights-reviews' && item.state === 'REVIEW_REQUIRED') {
    actions.push(['通过权利审核', () => decision(`/content-rights-reviews/${encodeURIComponent(item.review_id)}/decisions`, { decision: 'APPROVED' })]);
    actions.push(['驳回权利审核', () => decision(`/content-rights-reviews/${encodeURIComponent(item.review_id)}/decisions`, { decision: 'REJECTED' })]);
  } else if (endpoint.includes('dead-letters') && item.state === 'OPEN') {
    actions.push(['人工重放一次', () => replay(endpoint, item.job_id)]);
  } else if (endpoint === '/dual-approvals' && item.state === 'REQUESTED') {
    actions.push(['批准（需他人申请）', () => decision(`/dual-approvals/${encodeURIComponent(item.approval_id)}/decisions`, { decision: 'APPROVE' })]);
    actions.push(['驳回', () => decision(`/dual-approvals/${encodeURIComponent(item.approval_id)}/decisions`, { decision: 'REJECT' })]);
  } else if (endpoint === '/persona-releases') {
    for (const version of item.versions || []) appendPersonaAction(actions, item.character_id, version);
  }
  for (const [label, run] of actions) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.addEventListener('click', run); card.append(button);
  }
}

function appendPersonaAction(actions, characterId, version) {
  const root = `/persona-versions/${encodeURIComponent(characterId)}/${version.version}`;
  if (version.state === 'DRAFT') actions.push([`评测 v${version.version}`, async () => {
    const reportRef = prompt('输入固定评测报告引用'); if (!reportRef) return;
    await post(`${root}/evaluate`, { suite_version: 'persona-regression-v1', critical_pass_rate: 1, overall_pass_rate: 0.9, report_ref: reportRef });
  }]);
  if (version.state === 'EVALUATING') actions.push([`进入影子 v${version.version}`, () => post(`${root}/shadow`, {})]);
  if (version.state === 'SHADOW') actions.push([`灰度 v${version.version}`, async () => {
    const report = prompt('输入影子报告引用'); if (!report) return;
    const traffic = Number(prompt('灰度流量 1-10（整数）', '5')); if (!Number.isInteger(traffic)) return;
    await post(`${root}/canary`, { traffic_percent: traffic, shadow_report_ref: report });
  }]);
  if (version.state === 'CANARY') {
    actions.push([`申请发布审批 v${version.version}`, async () => {
      const reason = prompt('输入发布申请理由（写入双人审批与审计）'); if (!reason) return;
      await post('/dual-approvals', { action: 'PERSONA_STABLE_RELEASE', target_id: `${characterId}@v${version.version}`, reason });
    }]);
    actions.push([`发布稳定 v${version.version}`, async () => {
      const report = prompt('输入灰度报告引用'); if (report) await post(`${root}/stable`, { canary_report_ref: report });
    }]);
  }
  if (['CANARY', 'STABLE'].includes(version.state)) actions.push([`回退 v${version.version}`, async () => {
    const target = Number(prompt('输入要恢复的 RETIRED 版本号')); const reason = prompt('输入回退原因');
    if (Number.isInteger(target) && reason) await post(`${root}/rollback`, { rollback_to_version: target, reason });
  }]);
}

async function decision(path, base) { const reason = prompt('输入审核理由（必填，将写入审计记录）'); if (reason) await post(path, { ...base, reason }); }
async function replay(endpoint, jobId) { const reason = prompt('输入重放理由（每个任务最多一次）'); if (reason) await post(`${endpoint}/${encodeURIComponent(jobId)}/replay`, { reason }); }
async function post(path, body) {
  if (!confirm('确认执行该受控操作？')) return;
  const response = await fetch(`/_api/internal${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) { status.textContent = `操作失败：${payload.error?.code || ''} ${payload.error?.message || response.status}`; return; }
  status.textContent = '操作已由服务端接受，正在刷新队列。'; await load();
}
renderTabs();
