'use strict';

// An episode is always a candidate. It never becomes an ACTIVE relationship
// asset without the existing user confirmation flow.
function deriveEpisodeCandidate({ text, characterId, worldState }) {
  const value = String(text || '').trim();
  if (value.length < 8 || value.length > 240) return null;
  if (!/(?:我们|一起|约好|第一次|今天).{0,36}(?:见面|去了|看了|吃了|聊了|约在|庆祝|散步)/u.test(value)) return null;
  return {
    type: 'relationship_episode',
    normalized_value: { text: value, character_id: characterId, world_state_version: worldState?.state_version ?? null },
    display_text: `关系情节：${value}`,
    confidence: 0.6,
    provenance: 'deterministic-episode-candidate.v1'
  };
}
module.exports = { deriveEpisodeCandidate };
