'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWireSchemaRecorder } = require('../scripts/verify-native-realtime-synthetic');
const { encodeRealtimeFrame } = require('../src/providers/volcengine-realtime-adapter');
function frame(event, payload) { const bytes = encodeRealtimeFrame(event, payload, 'private-session'); bytes[1] = 0x94; return bytes; }
test('private probe wire diagnostic keeps schema and equality but no text or identifiers', () => {
  const events = []; const record = createWireSchemaRecorder((name, data) => events.push({ name, ...data }));
  record(frame(450, { question_id: 'private-question' }), true);
  record(frame(550, { content: 'private-content', question_id: 'private-question', reply_id: 'private-reply' }), true);
  record(frame(350, { text: 'private-text', tts_type: 'default', question_id: 'private-question', reply_id: 'private-reply' }), true);
  record(frame(350, { text: '', tts_type: 'untrusted-value', question_id: '', reply_id: 'different-reply' }), true);
  assert.equal(events[2].question_matches_latest_asr, true);
  assert.equal(events[2].reply_matches_previous, true);
  assert.equal(events[2].text_length, 12);
  assert.equal(events[3].question_id_present, false);
  assert.equal(events[3].reply_matches_previous, false);
  assert.equal(events[3].tts_type, 'OTHER');
  assert.doesNotMatch(JSON.stringify(events), /private-|different-reply|untrusted-value/);
});
test('private probe wire diagnostic is bounded and malformed frames expose no bytes', () => {
  const events = []; const record = createWireSchemaRecorder((name, data) => events.push({ name, ...data }));
  record(Buffer.from('private-invalid'), true);
  for (let i = 0; i < 100; i++) record(frame(351, {}), true);
  assert.equal(events.length, 30);
  assert.equal(events[0].name, 'wire-schema-decode-failed');
  assert.doesNotMatch(JSON.stringify(events), /private-invalid/);
});
