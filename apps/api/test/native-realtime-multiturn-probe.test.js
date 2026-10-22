'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInFlightInterruptionObserver } = require('../scripts/verify-native-realtime-multiturn');
test('ordinary consecutive complete replies do not count as interruption', () => {
  const observer = createInFlightInterruptionObserver();
  observer.observe({ type: 'sentence-start', questionId: 'q1', replyId: 'r1' });
  observer.observe({ type: 'response-complete', questionId: 'q1', replyId: 'r1' });
  assert.equal(observer.observe({ type: 'speech-start', questionId: 'q2' }), false);
  assert.equal(observer.count, 0);
});
test('fresh speech while a provider reply is active counts once', () => {
  const observer = createInFlightInterruptionObserver();
  observer.observe({ type: 'sentence-start', questionId: 'q1', replyId: 'r1' });
  assert.equal(observer.observe({ type: 'speech-start', questionId: 'q1' }), false);
  assert.equal(observer.observe({ type: 'speech-start', questionId: 'q2' }), true);
  assert.equal(observer.observe({ type: 'speech-start', questionId: 'q2' }), false);
  assert.equal(observer.count, 1);
});
test('stale completion cannot hide an active newer reply', () => {
  const observer = createInFlightInterruptionObserver();
  observer.observe({ type: 'sentence-start', questionId: 'q2', replyId: 'r2' });
  observer.observe({ type: 'response-complete', questionId: 'q1', replyId: 'r1' });
  assert.equal(observer.observe({ type: 'speech-start', questionId: 'q3' }), true);
});
