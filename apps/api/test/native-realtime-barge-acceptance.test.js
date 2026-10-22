'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PLAN, createWireBargeObserver } = require('../scripts/verify-native-realtime-barge-acceptance');
const frame = (q, r, extra = {}) => ({ question_id: q, reply_id: r, ...extra });

test('ordinary next question after matching old completion is not wire interruption', () => {
  const observer = createWireBargeObserver();
  observer.observe(550, frame('old', 'old-reply'));
  observer.observe(359, frame('old', 'old-reply'));
  observer.observe(450, frame('next', undefined, { is_duplex_interrupted: false }));
  assert.equal(observer.interrupted, false);
});

test('genuine wire interruption requires new question before old completion; stale completions do not pass', () => {
  const events = []; const observer = createWireBargeObserver((event, extra) => events.push({ event, ...extra }));
  observer.observe(550, frame('private-old', 'private-old-reply'));
  observer.observe(450, frame('private-new', undefined, { is_duplex_interrupted: true }));
  observer.observe(359, frame('private-old', 'private-old-reply'));
  observer.observe(550, frame('private-new', 'private-new-reply'));
  observer.observe(359, frame('private-new', 'wrong-reply'));
  assert.equal(observer.interrupted, true);
  assert.equal(observer.duplexConfirmed, true);
  assert.equal(observer.bargeCompleted, false);
  observer.observe(359, frame('private-new', 'private-new-reply'));
  assert.equal(observer.bargeCompleted, true);
  assert.equal(observer.bargeApproved, false);
  observer.observeApproved('realtime.audio', { question_id: 'private-old', reply_id: 'private-new-reply', audio_base64: 'AAA=' });
  observer.observeApproved('realtime.response-completed', { reply_id: 'private-new-reply' });
  assert.equal(observer.bargeApproved, false);
  observer.observeApproved('realtime.audio', { question_id: 'private-new', reply_id: 'private-new-reply', audio_base64: 'AAA=' });
  assert.equal(observer.bargeApproved, true);
  observer.observe(450, frame('private-third'));
  observer.observe(550, frame('private-third', 'private-third-reply'));
  observer.observe(359, frame('private-new', 'private-new-reply'));
  assert.equal(observer.nextCompleted, false);
  observer.observe(359, frame('private-third', 'private-third-reply'));
  observer.observeApproved('realtime.audio', { question_id: 'private-third', reply_id: 'private-third-reply', audio_base64: 'AAA=' });
  observer.observeApproved('realtime.response-completed', { reply_id: 'private-third-reply' });
  assert.equal(observer.nextCompleted && observer.followupApproved, true);
  assert.doesNotMatch(JSON.stringify(events), /private-/);
});

test('probe stays bounded, includes complete three inputs, and cannot retry automatically', () => {
  assert.equal(PLAN.automatic_retries, 0);
  assert.equal(PLAN.sessions, 1);
  assert.equal(PLAN.max_input_audio_ms, 7000);
  assert.equal(PLAN.max_received_output_audio_ms, 12000);
  assert.equal(PLAN.max_tms_calls, 8);
  assert.equal(PLAN.wall_clock_ms, 45000);
  assert.equal(PLAN.strict_provider_spend_cap_enforced, false);
});
