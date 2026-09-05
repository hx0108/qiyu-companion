'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rankRelationshipAssets } = require('../src/domain/relationship-recall');

const accountId = 'acct_1';
const characterId = 'chr_1';
const assets = [
  { asset_id: 'asset_old_match', account_id: accountId, character_id: characterId, state: 'ACTIVE', display_text: '我们周末一起看电影', created_at: '2026-09-01T00:00:00.000Z' },
  { asset_id: 'asset_new_other', account_id: accountId, character_id: characterId, state: 'ACTIVE', display_text: '你喜欢雨天的咖啡馆', created_at: '2026-09-04T00:00:00.000Z' },
  { asset_id: 'asset_other_character', account_id: accountId, character_id: 'chr_2', state: 'ACTIVE', display_text: '周末电影', created_at: '2026-09-05T00:00:00.000Z' },
  { asset_id: 'asset_deleted', account_id: accountId, character_id: characterId, state: 'DELETED', display_text: '周末电影', created_at: '2026-09-05T00:00:00.000Z' }
];

test('结构化回退召回只选择当前账户和角色的有效资产，并按相关性排序', () => {
  const recalled = rankRelationshipAssets(assets, { accountId, characterId, query: '这个周末想看电影', limit: 5 });
  assert.deepEqual(recalled.map((item) => item.asset_id), ['asset_old_match', 'asset_new_other']);
});

test('没有可匹配关键词时，结构化回退按最新有效资产稳定截断', () => {
  const recalled = rankRelationshipAssets(assets, { accountId, characterId, query: '今天心情怎样', limit: 1 });
  assert.deepEqual(recalled.map((item) => item.asset_id), ['asset_new_other']);
});
