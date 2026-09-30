'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { parseDevFlags } = require('../src/development/dev-flags');

const CONTRACT_PATH = path.join(__dirname, '..', '..', '..', 'contracts', 'openapi.yaml');

// 零依赖提取 yaml paths 顶层路径键（两空格缩进、以 / 开头）。本合同测试只需要
// path 清单与每路径的 method 集合，不需要完整 schema 树。
function documentedPathMethods() {
  const lines = fs.readFileSync(CONTRACT_PATH, 'utf8').split(/\r?\n/);
  const result = new Map();
  let inPaths = false;
  let current = null;
  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) { inPaths = true; continue; }
    if (inPaths && /^\S/.test(line)) break; // paths: 段结束（components: 等顶层键）
    const pathMatch = /^  (\/[^:]+):\s*(?:#.*)?$/.exec(line);
    if (pathMatch) { current = pathMatch[1]; result.set(current, new Set()); continue; }
    const methodMatch = /^    (get|post|patch|delete|put):(?:\s|$)/.exec(line);
    if (methodMatch && current) result.get(current).add(methodMatch[1].toUpperCase());
  }
  return result;
}

// 六项能力 A1 契约新增的路径与探针（凭有效 token 区分 ROUTE_NOT_FOUND 与
// RESOURCE_NOT_FOUND：前者=路由缺失，后者=路由存在但资源找不到）。
const A1_PROBES = [
  { method: 'GET', path: '/api/v1/life-events', expectStatus: 200 },
  { method: 'GET', path: '/api/v1/life-events/levt_missing', expectStatus: 404 },
  { method: 'PATCH', path: '/api/v1/life-events/levt_missing', expectStatus: 404, body: { expected_version: 1 } },
  { method: 'DELETE', path: '/api/v1/life-events/levt_missing', expectStatus: 404 },
  { method: 'GET', path: '/api/v1/messages/msg_missing/memory-references', expectStatus: 404 },
];

// A2：事件级跟进许可（嵌在 LIFE_EVENTS 内 + FOLLOWUP_DISPATCH 独立开关）。
const A2_PROBES = [
  { method: 'GET', path: '/api/v1/life-events/levt_missing/followup', expectStatus: 404 },
  { method: 'PUT', path: '/api/v1/life-events/levt_missing/followup', expectStatus: 404, body: { expected_version: 1, followup_kind: 'BEFORE_EVENT' } },
  { method: 'DELETE', path: '/api/v1/life-events/levt_missing/followup', expectStatus: 404 },
];

async function startServer(devFlags) {
  const app = createApp({ store: new DevelopmentStore(), devFlags });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  // 写操作探针需要过年龄准入（与真实用户同路径），否则 403 会掩盖路由可达性。
  if (devFlags?.enabled?.LIFE_EVENTS) await passAdmission(base);
  return { app, base };
}

async function passAdmission(base) {
  const headers = { authorization: 'Bearer dev-alice-token', 'content-type': 'application/json' };
  const notices = await (await fetch(`${base}/api/v1/required-notices`, { headers })).json();
  const notice = notices.notices[0];
  await fetch(`${base}/api/v1/required-notices/${notice.notice_id}/displayed`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': 'contract-notice' }, body: JSON.stringify({ notice_version: notice.notice_version })
  });
  await fetch(`${base}/api/v1/age/declarations`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': 'contract-age' }, body: JSON.stringify({ date_of_birth: '1990-01-01', confirmed_18_plus: true })
  });
}

async function probe(base, { method, path: probePath, body }) {
  const response = await fetch(`${base}${probePath}`, {
    method,
    headers: { authorization: 'Bearer dev-alice-token', 'content-type': 'application/json', ...(method !== 'GET' ? { 'idempotency-key': `contract-${method}-${probePath}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await response.json(); } catch { /* 非 JSON 响应在断言里体现 */ }
  return { status: response.status, json };
}

test('contract: A1 life-events 与 memory-references 路径已写入 openapi.yaml', () => {
  const documented = documentedPathMethods();
  const expected = [
    ['/api/v1/life-events', 'GET'],
    ['/api/v1/life-events/{eventId}', 'GET'],
    ['/api/v1/life-events/{eventId}', 'PATCH'],
    ['/api/v1/life-events/{eventId}', 'DELETE'],
    ['/api/v1/life-events/{eventId}/followup', 'GET'],
    ['/api/v1/life-events/{eventId}/followup', 'PUT'],
    ['/api/v1/life-events/{eventId}/followup', 'DELETE'],
    ['/api/v1/messages/{messageId}/memory-references', 'GET'],
  ];
  for (const [templatePath, method] of expected) {
    assert.ok(documented.has(templatePath), `openapi.yaml 缺少路径 ${templatePath}`);
    assert.ok(documented.get(templatePath).has(method), `openapi.yaml 的 ${templatePath} 缺少 ${method}`);
  }
});

test('contract: 开关开启时新路由可达（不是 ROUTE_NOT_FOUND）且错误响应形状符合合同', async (t) => {
  const devFlags = parseDevFlags({ QIYU_DEV_FLAGS: 'LIFE_EVENTS,MEMORY_REFERENCES,FOLLOWUP_DISPATCH' });
  const { app, base } = await startServer(devFlags);
  t.after(() => app.close());
  for (const spec of [...A1_PROBES, ...A2_PROBES]) {
    const { status, json } = await probe(base, spec);
    const code = json?.error?.code;
    assert.notEqual(code, 'ROUTE_NOT_FOUND', `${spec.method} ${spec.path} 应已接线（收到 ROUTE_NOT_FOUND 说明路由缺失）`);
    assert.equal(status, spec.expectStatus, `${spec.method} ${spec.path} 状态码`);
    if (status >= 400) {
      // 统一错误形状：error.code/message/request_id/retryable(+details)。
      assert.equal(typeof json.error.code, 'string');
      assert.equal(typeof json.error.message, 'string');
      assert.equal(typeof json.error.request_id, 'string');
      assert.equal(typeof json.error.retryable, 'boolean');
      assert.notEqual(code, 'ROUTE_NOT_FOUND');
    }
  }
});

test('contract: 开关关闭时新路由按不存在处理（404 ROUTE_NOT_FOUND），不暴露功能存在', async (t) => {
  const { app, base } = await startServer(parseDevFlags({}));
  t.after(() => app.close());
  for (const spec of [...A1_PROBES, ...A2_PROBES]) {
    const { status, json } = await probe(base, spec);
    assert.equal(status, 404, `${spec.method} ${spec.path} 关闭时应 404`);
    assert.equal(json?.error?.code, 'ROUTE_NOT_FOUND', `${spec.method} ${spec.path} 关闭时应 ROUTE_NOT_FOUND`);
  }
});
