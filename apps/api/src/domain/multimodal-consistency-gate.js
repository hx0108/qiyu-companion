'use strict';

// Media generation must use the same immutable world-state snapshot as the
// originating assistant reply. Model-provided labels are never trusted here.
function assessMultimodalConsistency({ sourceMessage, worldStateId, worldStateVersion, modality }) {
  if (!sourceMessage?.world_state_id || !Number.isInteger(sourceMessage.world_state_version)) return { decision: 'BLOCK', code: 'MULTIMODAL_SOURCE_SNAPSHOT_MISSING' };
  if (sourceMessage.world_state_id !== worldStateId || sourceMessage.world_state_version !== worldStateVersion) return { decision: 'BLOCK', code: 'MULTIMODAL_WORLD_STATE_MISMATCH' };
  if (!['tts', 'image'].includes(modality)) return { decision: 'BLOCK', code: 'MULTIMODAL_MODALITY_INVALID' };
  return { decision: 'PASS', code: null };
}
module.exports = { assessMultimodalConsistency };
