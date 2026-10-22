'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startVoicePreview } = require('../scripts/start-apricot-voice');

test('voice startup advertises native availability, requires invite login, and makes no provider calls', async t => {
  let providerCalls = 0;
  const factories = {
    realtime: () => ({ async createSession() { providerCalls++; throw new Error('not part of startup acceptance'); } }),
    moderation: () => async () => { providerCalls++; throw new Error('not part of startup acceptance'); }
  };
  const { server, origin } = await startVoicePreview({ port: 0, environment: { TENCENT_TEXT_MODERATION_BIZ_TYPE: 'unit-test' }, inviteCode: 'QIYU-VOICE-UNIT-TEST', factories });
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(server.address().address, '127.0.0.1');
  const access = await fetch(origin + '/api/v1/trial-access').then(r => r.json());
  assert.equal(access.enabled, true);
  assert.equal(access.authentication, 'closed-trial-invite');
  assert.equal(access.realtime_call.enabled, true);
  assert.equal(access.payment, 'disabled');
  assert.equal((await fetch(origin + '/api/v1/characters', { headers: { authorization: 'Bearer dev-alice-token' } })).status, 401);
  const login = await fetch(origin + '/api/v1/auth/trial-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite_code: 'QIYU-VOICE-UNIT-TEST' }) });
  assert.equal(login.status, 201);
  const session = await login.json();
  const headers = { authorization: `Bearer ${session.tokens.access_token}` };
  const age = await fetch(origin + '/api/v1/age/status', { headers }).then(r => r.json());
  assert.equal(age.status, 'AGE_UNVERIFIED', 'real user must provide their own age declaration');
  const characters = await fetch(origin + '/api/v1/characters', { headers }).then(r => r.json());
  assert.deepEqual(characters.characters, [], 'no synthetic persona or user consent is prefilled');
  assert.equal(providerCalls, 0);
});

test('voice startup refuses incomplete provider configuration or production runtime', async () => {
  await assert.rejects(startVoicePreview({ environment: { NODE_ENV: 'production' }, inviteCode: 'QIYU-VOICE-UNIT-TEST', port: 0 }), /LOCAL_VOICE_ENVIRONMENT_REQUIRED/);
  await assert.rejects(startVoicePreview({ environment: {}, inviteCode: 'QIYU-VOICE-UNIT-TEST', port: 0 }), /REALTIME_MODERATION_CONFIGURATION_REQUIRED/);
  await assert.rejects(startVoicePreview({ environment: { TENCENT_TEXT_MODERATION_BIZ_TYPE: 'unit-test' }, inviteCode: 'QIYU-VOICE-UNIT-TEST', port: 0, factories: { realtime: () => null, moderation: () => async () => {} } }), /REALTIME_PROVIDER_CONFIGURATION_REQUIRED/);
});
