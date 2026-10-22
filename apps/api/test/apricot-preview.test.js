'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startPreview } = require('../scripts/start-apricot-preview');

test('local apricot preview serves versioned entry resources and restores a synthetic character through API contracts', async t => {
  const { server, origin } = await startPreview({ port: 0 });
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(server.address().address, '127.0.0.1');
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  const html = await page.text();
  const resources = [...html.matchAll(/(?:href|src)="([^"#]+\.(?:css|js)(?:\?[^"\s]+)?)"/g)].map(match => match[1]);
  assert.equal(resources.length, 4);
  for (const resource of resources) {
    const response = await fetch(new URL(resource, origin));
    assert.equal(response.status, 200, resource);
    assert.match(response.headers.get('content-type'), resource.includes('.css') ? /text\/css/ : /javascript/);
    assert.ok((await response.arrayBuffer()).byteLength > 100, resource);
  }
  const headers = { authorization: 'Bearer dev-alice-token' };
  const age = await fetch(origin + '/api/v1/age/status', { headers }).then(r => r.json());
  assert.equal(age.status, 'AGE_PASS');
  const characters = await fetch(origin + '/api/v1/characters', { headers }).then(r => r.json());
  const character = characters.characters.find(item => item.status === 'ACTIVE');
  assert.equal(character.name, '林默');
  const conversations = await fetch(origin + '/api/v1/conversations', { headers }).then(r => r.json());
  assert.ok(conversations.conversations.some(item => item.character_id === character.character_id && item.status === 'OPEN'));
  const access = await fetch(origin + '/api/v1/trial-access').then(r => r.json());
  assert.equal(access.voice_call_enabled, false);
});
