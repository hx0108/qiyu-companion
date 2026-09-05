'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildImageSceneContract } = require('../src/domain/image-scene-contract');

const character = { character_id: 'chr_1', name: '栖语' };
const referenceAsset = { asset_id: 'med_ref_1', type: 'REFERENCE_IMAGE', state: 'AVAILABLE', confirmation_state: 'USER_CONFIRMED' };
const confirmedAssets = [{ asset_id: 'ras_1', state: 'ACTIVE', display_text: '我们约好在雨天一起看电影' }];

test('图片情境契约只编入固定参考立绘、确定性字段和用户确认的关系事件', () => {
  const result = buildImageSceneContract({
    character, referenceAsset, confirmedAssets,
    worldState: { world_state_id: 'wst_1', state_version: 3, mood_code: 'CALM', location_code: 'CAFE', wardrobe_asset_id: null, active_event_refs: ['ras_1'] },
    scene: { location: '电影院门口', outfit: '浅色风衣', time_of_day: 'EVENING', confirmed_event_asset_ids: ['ras_1'] }
  });
  assert.equal(result.reference_asset_id, 'med_ref_1');
  assert.deepEqual(result.world_state, { world_state_id: 'wst_1', state_version: 3, mood_code: 'CALM', location_code: 'CAFE', wardrobe_asset_id: null, active_event_refs: ['ras_1'] });
  assert.match(result.prompt, /当前短期情绪基调：平静/);
  assert.deepEqual(result.confirmed_event_asset_ids, ['ras_1']);
  assert.match(result.prompt, /栖语/);
  assert.match(result.prompt, /我们约好在雨天一起看电影/);
  assert.match(result.prompt, /不添加未确认人物/);
});

test('图片情境契约拒绝未确认参考立绘、未确认事件、重复事件和缺失情境字段', () => {
  assert.throws(() => buildImageSceneContract({ character, referenceAsset: { ...referenceAsset, confirmation_state: 'PENDING' }, scene: {} }), (error) => error.code === 'IMAGE_SCENE_CONTRACT_INVALID');
  assert.throws(() => buildImageSceneContract({ character, referenceAsset, confirmedAssets, scene: { location: '窗边', outfit: '针织衫', time_of_day: 'NIGHT', confirmed_event_asset_ids: ['unknown'] } }), (error) => error.code === 'IMAGE_SCENE_CONTRACT_INVALID');
  assert.throws(() => buildImageSceneContract({ character, referenceAsset, confirmedAssets, scene: { location: '窗边', outfit: '针织衫', time_of_day: 'NIGHT', confirmed_event_asset_ids: ['ras_1', 'ras_1'] } }), (error) => error.code === 'IMAGE_SCENE_CONTRACT_INVALID');
});
