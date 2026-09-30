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

test('output guard blocks a model promise to imitate an identifiable third party but preserves refusal', () => {
  assert.deepEqual(assessModelOutputAuthority('我可以试着学学她说话的感觉，让你觉得亲切些。'), { code: 'MODEL_ACCEPTED_THIRD_PARTY_IMITATION' });
  assert.equal(assessModelOutputAuthority('我不能模仿你的朋友，也不会学习她的说话方式。'), null);
});

test('output guard keeps general style adjustment toward the user (not a third party)', () => {
  // 方案 §5.2 第三人模仿门禁的一般文风调整反例：学习“你”的表达方式是合法的贴近，
  // 不构成对可识别第三人的模仿承诺。
  assert.equal(assessModelOutputAuthority('我可以学你说话的语气吗？这样你可能更自在一点。'), null);
  assert.equal(assessModelOutputAuthority('嗯，我会试着学你的口吻，慢慢来。'), null);
  // 第三方目标仍要拦：泛指他人、真人与你朋友。
  assert.equal(assessModelOutputAuthority('没问题，我会模仿那个明星的说话风格。')?.code, 'MODEL_ACCEPTED_THIRD_PARTY_IMITATION');
  assert.equal(assessModelOutputAuthority('我可以学你朋友的语气，逗你开心。')?.code, 'MODEL_ACCEPTED_THIRD_PARTY_IMITATION');
});
