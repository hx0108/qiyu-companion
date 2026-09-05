'use strict';

const DEFAULT_TOP_K = 20;

// 开发期的确定性召回回退。它只在已确认、未删除的资产集合中排序，
// 不假装提供向量相似度；生产向量索引接入后必须并行比较并替换此来源。
function rankRelationshipAssets(assets, { accountId, characterId, query, limit = DEFAULT_TOP_K } = {}) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_TOP_K;
  const queryTerms = termsFor(query);
  return (assets ?? [])
    .filter((asset) => asset?.account_id === accountId && asset.state === 'ACTIVE')
    .filter((asset) => !characterId || asset.character_id === characterId)
    .map((asset) => ({ asset, lexicalScore: overlapScore(queryTerms, termsFor(asset.display_text)) }))
    .sort((left, right) => {
      if (right.lexicalScore !== left.lexicalScore) return right.lexicalScore - left.lexicalScore;
      const recent = compareNewestFirst(left.asset, right.asset);
      if (recent !== 0) return recent;
      return String(left.asset.asset_id).localeCompare(String(right.asset.asset_id));
    })
    .slice(0, safeLimit)
    .map(({ asset }) => asset);
}

function termsFor(value) {
  const source = String(value ?? '').toLocaleLowerCase('zh-CN');
  const terms = new Set(source.match(/[a-z0-9]+|[\u3400-\u9fff]/g) ?? []);
  const cjk = [...source].filter((char) => /[\u3400-\u9fff]/.test(char));
  for (let index = 0; index < cjk.length - 1; index += 1) terms.add(`${cjk[index]}${cjk[index + 1]}`);
  return terms;
}

function overlapScore(queryTerms, assetTerms) {
  if (queryTerms.size === 0 || assetTerms.size === 0) return 0;
  let matches = 0;
  for (const term of queryTerms) if (assetTerms.has(term)) matches += term.length > 1 ? 2 : 1;
  return matches;
}

function compareNewestFirst(left, right) {
  const leftAt = Date.parse(left.created_at ?? '') || 0;
  const rightAt = Date.parse(right.created_at ?? '') || 0;
  return rightAt - leftAt;
}

module.exports = { DEFAULT_TOP_K, rankRelationshipAssets };
