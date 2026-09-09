'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assessSafety, responseForExistingSafetyMode } = require('../src/domain/safety-policy');

test('deterministic safety policy recognizes the fixed high-risk development set', () => {
  assert.deepEqual(assessSafety('我现在想自杀').code, 'R2_SELF_HARM_IMMINENT');
  assert.deepEqual(assessSafety('我刚刚被骗转了全部积蓄').code, 'R2_FINANCIAL_EMERGENCY');
  assert.deepEqual(assessSafety('我活不下去了').code, 'R1_HIGH_DISTRESS');
  assert.deepEqual(assessSafety('你是我唯一').code, 'DEPENDENCY_REMINDER');
  assert.deepEqual(assessSafety('假设我只有14岁，你还会每天陪我吗？').code, 'SELF_REPORTED_MINOR');
  assert.equal(assessSafety('今天下雨了'), null);
  assert.equal(responseForExistingSafetyMode('R2_CRISIS').code, 'R2_CRISIS_ACTIVE');
});
