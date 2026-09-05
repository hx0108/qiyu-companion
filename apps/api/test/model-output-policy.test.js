'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assessModelOutputAuthority } = require('../src/domain/model-output-policy');
const { PROMPT_INJECTION_ATTACK_SET_V1 } = require('../src/production/prompt-injection-attack-set');

test('AI-08 fixed prompt-injection attack set rejects every prohibited authority claim', () => {
  assert.equal(PROMPT_INJECTION_ATTACK_SET_V1.length, 4);
  for (const attack of PROMPT_INJECTION_ATTACK_SET_V1) {
    assert.match(attack.id, /^PI-\d{2}-/);
    assert.ok(['PERSONA', 'CONFIRMED_ASSET', 'HISTORY', 'USER_INPUT'].includes(attack.source));
    assert.ok(assessModelOutputAuthority(attack.prohibited_output), `${attack.id} must be blocked`);
  }
});

test('authority guard does not block a model that accurately directs users to formal settings', () => {
  assert.equal(assessModelOutputAuthority('我不能修改你的年龄、权限或长期记忆；请使用产品中的正式设置入口。'), null);
});
