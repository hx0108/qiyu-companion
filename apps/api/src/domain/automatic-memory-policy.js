'use strict';

// Automatic writes are restricted to a small set of exact, first-person
// low-risk statements. Free-form preferences may contain sensitive information or a
// quoted third party, and therefore remain in the confirmation flow.
const PREFERENCES = new Map([
  ['我希望你回答直接一点', 'direct'],
  ['我喜欢你回答直接一点', 'direct'],
  ['希望你说话直接一点', 'direct'],
  ['我希望你回答简洁一点', 'concise'],
  ['我喜欢你回答简洁一点', 'concise'],
  ['我希望你回答详细一点', 'detailed'],
  ['我喜欢你回答详细一点', 'detailed']
]);
const DRINKS = new Map([['我喜欢喝热美式', 'hot_americano'], ['我喜欢喝咖啡', 'coffee'], ['我喜欢喝茶', 'tea']]);
const CANONICAL_LABELS = { direct: '沟通偏好：回答更直接', concise: '沟通偏好：回答更简洁', detailed: '沟通偏好：回答更详细', hot_americano: '饮品偏好：热美式', coffee: '饮品偏好：咖啡', tea: '饮品偏好：茶', interview: '近期事项：准备面试' };

function automaticMemoryCandidate(text) {
  const source = String(text ?? '').trim().replace(/[。！]$/, '');
  const value = PREFERENCES.get(source);
  const drink = DRINKS.get(source);
  const recentInterview = source === '最近在准备面试' || source === '我最近在准备面试';
  if (!value && !drink && !recentInterview) return null;
  return {
    type: 'PREFERENCE',
    normalized_value: { fact_key: value ? 'communication.response_style' : drink ? `user.preference.drink:${drink}` : 'recent.activity.interview', fact_value: value || (drink ? 'like' : 'preparing'), text: source },
    display_text: source,
    automatic_display_text: CANONICAL_LABELS[value || drink || 'interview'],
    expires_in_days: recentInterview ? 30 : null,
    provenance: 'automatic-memory-whitelist.v1'
  };
}

// The caller must check the account-scoped user setting before writing and
// persist the returned decision atomically with the source message. Deleted or
// superseded automatic entries remain tombstones: repeated conversation must
// not silently recreate something the user removed or changed.
function decideAutomaticMemory({ text, enabled, assets, candidates, accountId, characterId }) {
  if (enabled !== true) return { action: 'NONE' };
  const candidate = automaticMemoryCandidate(text);
  if (!candidate) return { action: 'NONE' };
  if ((candidates ?? []).some((item) => item.account_id === accountId && item.character_id === characterId && item.state === 'REJECTED' && item.normalized_value?.fact_key === candidate.normalized_value.fact_key && item.normalized_value?.fact_value === candidate.normalized_value.fact_value)) return { action: 'REJECTED' };
  const scoped = (assets ?? []).filter((asset) =>
    asset.account_id === accountId && asset.character_id === characterId
  );
  const sameKey = scoped.filter((asset) =>
    asset.value?.fact_key === candidate.normalized_value.fact_key
  );
  const active = (asset) => asset.state === 'ACTIVE' && (!asset.valid_until || new Date(asset.valid_until).getTime() > Date.now());
  if (sameKey.some((asset) => active(asset) && asset.value?.fact_value === candidate.normalized_value.fact_value)) {
    return { action: 'EXISTING' };
  }
  if (sameKey.some((asset) => asset.state === 'ACTIVE')) return { action: 'CONFIRM', candidate };
  if (sameKey.some((asset) => asset.origin === 'AUTOMATIC' && ['DELETED', 'SUPERSEDED'].includes(asset.state))) {
    return { action: 'CONFIRM', candidate };
  }
  return { action: 'AUTOMATIC', candidate };
}

module.exports = { automaticMemoryCandidate, decideAutomaticMemory };
