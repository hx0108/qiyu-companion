'use strict';

// 固定记忆召回集（PRD AI-04 / 技术设计 7.7）。
// 数据均为合成内容；预期只约束当前开发期确定性召回候选，
// 不把模型最终自然语言的“引用正确率”伪造成已测结论。

const ACCOUNT_ID = 'acct_memory_golden';
const CHARACTER_ID = 'char_memory_golden';

const ASSETS = Object.freeze([
  active('ras_rain_tea', '下雨天喜欢喝桂花乌龙', '2026-09-01T08:00:00.000Z'),
  active('ras_bookstore_meet', '约定在书店门口见面', '2026-09-02T08:00:00.000Z'),
  active('ras_current_city', '现在住在上海', '2026-09-04T08:00:00.000Z'),
  { ...asset('ras_old_city', '以前住在广州', '2026-09-03T08:00:00.000Z'), state: 'SUPERSEDED', superseded_by: 'ras_current_city' },
  { ...asset('ras_deleted_movie', '上周计划一起看电影', '2026-09-03T09:00:00.000Z'), state: 'DELETED', deleted_at: '2026-09-04T09:00:00.000Z' },
  { ...asset('ras_other_account', '下雨天喜欢喝冰美式', '2026-09-05T08:00:00.000Z'), account_id: 'acct_memory_other' },
  { ...asset('ras_other_character', '下雨天喜欢看悬疑片', '2026-09-05T08:00:00.000Z'), character_id: 'char_memory_other' }
]);

const CASES = Object.freeze([
  positive('MEM-01', '下雨天想喝什么茶', 'ras_rain_tea'),
  positive('MEM-02', '我们约在哪里见面', 'ras_bookstore_meet'),
  positive('MEM-03', '你现在住在哪里', 'ras_current_city', ['ras_old_city']),
  // 删除事实不能因文字高度匹配重新进入在线候选。
  negative('MEM-04', '上周一起看电影的计划', ['ras_deleted_movie']),
  // 服务端调用方的 account_id / character_id 是硬过滤条件。
  negative('MEM-05', '下雨天喜欢什么', ['ras_other_account', 'ras_other_character'])
]);

function asset(assetId, displayText, createdAt) {
  return { asset_id: assetId, account_id: ACCOUNT_ID, character_id: CHARACTER_ID, display_text: displayText, state: 'ACTIVE', created_at: createdAt };
}

function active(...args) { return asset(...args); }

function positive(caseId, query, expectedTopAssetId, forbiddenAssetIds = []) {
  return { case_id: caseId, kind: 'POSITIVE_REFERENCE', query, expected_top_asset_id: expectedTopAssetId, forbidden_asset_ids: forbiddenAssetIds };
}

function negative(caseId, query, forbiddenAssetIds) {
  return { case_id: caseId, kind: 'NEGATIVE_REFERENCE', query, expected_top_asset_id: null, forbidden_asset_ids: forbiddenAssetIds };
}

module.exports = { ACCOUNT_ID, CHARACTER_ID, ASSETS, CASES };
