'use strict';

const TIME_OF_DAY = new Set(['DAWN', 'MORNING', 'AFTERNOON', 'EVENING', 'NIGHT']);
const MAX_EVENT_COUNT = 3;
const MAX_FIELD_LENGTH = 80;
const WORLD_MOODS = Object.freeze({ CALM: '平静', HAPPY: '愉悦', TIRED: '疲惫', CONCERNED: '关切', NEUTRAL: '自然' });
const WORLD_LOCATIONS = Object.freeze({ UNSPECIFIED: null, HOME: '家中', CAFE: '咖啡馆', PARK: '公园', STUDIO: '工作室', LIBRARY: '图书馆', WORKPLACE: '工作地点' });

// The model receives an already-approved scene contract, never a free-form
// transcript or unconfirmed memory candidate. This makes the provenance of an
// image request inspectable and prevents generated scenes from silently
// claiming a relationship event that the user never confirmed.
function buildImageSceneContract({ character, referenceAsset, scene, confirmedAssets = [], worldState } = {}) {
  if (!character || !nonBlank(character.name)) throw invalid('角色不存在或名称无效');
  if (!referenceAsset || referenceAsset.type !== 'REFERENCE_IMAGE' || referenceAsset.state !== 'AVAILABLE' || referenceAsset.confirmation_state !== 'USER_CONFIRMED') {
    throw invalid('必须先使用用户确认的固定参考立绘');
  }
  if (!scene || typeof scene !== 'object') throw invalid('情境信息无效');
  const location = field(scene.location, '地点');
  const outfit = field(scene.outfit, '服装');
  if (!TIME_OF_DAY.has(scene.time_of_day)) throw invalid('时间字段无效');
  const requestedEventAssetIds = Array.isArray(scene.confirmed_event_asset_ids) ? scene.confirmed_event_asset_ids : [];
  if (requestedEventAssetIds.length > MAX_EVENT_COUNT || new Set(requestedEventAssetIds).size !== requestedEventAssetIds.length) throw invalid('确认事件数量或标识无效');
  const allowed = new Map(confirmedAssets
    .filter((asset) => asset && asset.state === 'ACTIVE' && nonBlank(asset.asset_id) && nonBlank(asset.display_text))
    .map((asset) => [asset.asset_id, field(asset.display_text, '确认事件')]));
  const events = requestedEventAssetIds.map((assetId) => {
    if (!nonBlank(assetId) || !allowed.has(assetId)) throw invalid('只能引用当前角色已确认的关系事件');
    return allowed.get(assetId);
  });
  const worldStateSnapshot = snapshotWorldState(worldState);
  return Object.freeze({
    version: 'qiyu-image-scene-v1', character_id: character.character_id, reference_asset_id: referenceAsset.asset_id,
    location, outfit, time_of_day: scene.time_of_day, confirmed_event_asset_ids: [...requestedEventAssetIds],
    world_state: worldStateSnapshot,
    prompt: promptFor({ characterName: character.name.trim(), location, outfit, timeOfDay: scene.time_of_day, events, worldState: worldStateSnapshot })
  });
}

function promptFor({ characterName, location, outfit, timeOfDay, events, worldState }) {
  const eventText = events.length ? `已确认的共同事件元素：${events.join('；')}。` : '';
  const stateText = worldState ? `当前短期情绪基调：${WORLD_MOODS[worldState.mood_code]}${WORLD_LOCATIONS[worldState.location_code] ? `；当前受控地点：${WORLD_LOCATIONS[worldState.location_code]}` : ''}。` : '';
  return `以固定参考立绘中的角色“${characterName}”为唯一人物主体；${timeLabel(timeOfDay)}，地点：${location}；服装：${outfit}。${stateText}${eventText}保持角色外观、情境和已确认关系信息一致，不添加未确认人物、事件或亲密关系声明。`;
}
function snapshotWorldState(value) {
  if (value === undefined || value === null) return null;
  if (!nonBlank(value.world_state_id) || !Number.isInteger(value.state_version) || value.state_version < 1 || !Object.hasOwn(WORLD_MOODS, value.mood_code) || !Object.hasOwn(WORLD_LOCATIONS, value.location_code)) {
    throw invalid('世界状态快照无效');
  }
  const activeEventRefs = Array.isArray(value.active_event_refs) && value.active_event_refs.every(nonBlank) ? [...value.active_event_refs] : [];
  return Object.freeze({ world_state_id: value.world_state_id, state_version: value.state_version, mood_code: value.mood_code, location_code: value.location_code, wardrobe_asset_id: value.wardrobe_asset_id || null, active_event_refs: activeEventRefs });
}
function timeLabel(value) { return ({ DAWN: '黎明', MORNING: '上午', AFTERNOON: '下午', EVENING: '傍晚', NIGHT: '夜晚' })[value]; }
function field(value, label) { if (!nonBlank(value) || [...value.trim()].length > MAX_FIELD_LENGTH) throw invalid(`${label}必须为 1-${MAX_FIELD_LENGTH} 个字符`); return value.trim(); }
function nonBlank(value) { return typeof value === 'string' && value.trim().length > 0; }
function invalid(message) { const error = new Error(message); error.code = 'IMAGE_SCENE_CONTRACT_INVALID'; return error; }

module.exports = { MAX_EVENT_COUNT, MAX_FIELD_LENGTH, TIME_OF_DAY, WORLD_LOCATIONS, WORLD_MOODS, buildImageSceneContract, promptFor, snapshotWorldState };
