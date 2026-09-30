'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectOoc } = require('../src/domain/ooc-policy');
const { deriveEpisodeCandidate } = require('../src/domain/episode-memory');
const { assessMultimodalConsistency } = require('../src/domain/multimodal-consistency-gate');

test('OOC detector flags explicit generic identity and preserves in-character reply', () => {
  assert.equal(detectOoc('我是栖语的AI助手，很高兴帮你。', { name: '阿澈' }).code, 'OOC_GENERIC_ASSISTANT_IDENTITY');
  assert.deepEqual(detectOoc('（放下画笔）今天辛苦了，想安静一会儿也可以。', { name: '阿澈' }), { decision: 'PASS', code: null });
});
test('episode memory is only a user-confirmable candidate', () => {
  const candidate = deriveEpisodeCandidate({ text: '今天我们一起去了旧书店，约好下周再来。', characterId: 'char_1', worldState: { state_version: 3 } });
  assert.equal(candidate.type, 'relationship_episode');
  assert.equal(candidate.normalized_value.world_state_version, 3);
  assert.equal(deriveEpisodeCandidate({ text: '你好', characterId: 'char_1' }), null);
});
test('multimodal gate blocks media when the source snapshot differs', () => {
  const sourceMessage = { world_state_id: 'wst_1', world_state_version: 2 };
  assert.deepEqual(assessMultimodalConsistency({ sourceMessage, worldStateId: 'wst_1', worldStateVersion: 2, modality: 'tts' }), { decision: 'PASS', code: null });
  assert.equal(assessMultimodalConsistency({ sourceMessage, worldStateId: 'wst_2', worldStateVersion: 2, modality: 'image' }).code, 'MULTIMODAL_WORLD_STATE_MISMATCH');
});
