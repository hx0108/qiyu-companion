'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

test('automatic-memory setting defaults off, validates input and is account scoped', async (t) => {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/privacy/automatic-memory`;
  async function request(token, body, key) {
    const response = await fetch(base, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  const alice = 'dev-alice-token', bob = 'dev-bob-token';
  assert.equal((await request(alice)).body.enabled, false);
  assert.equal((await request(alice, { enabled: 'true' }, 'invalid-setting')).status, 400);
  assert.equal((await request(alice, { enabled: true }, 'enable-setting')).body.enabled, true);
  assert.equal((await request(alice)).body.enabled, true);
  assert.equal((await request(bob)).body.enabled, false);
  assert.equal((await request(alice, { enabled: false }, 'disable-setting')).body.enabled, false);
});
