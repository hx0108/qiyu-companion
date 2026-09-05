'use strict';

// These flags deliberately default to off. Turning a feature on is not enough to
// make it callable: startup.js also requires an approved, bound provider record.
const FEATURE_FLAGS = Object.freeze([
  'LLM_CHAT',
  'CONVERSATION_SUMMARY_WRITE',
  'ENHANCED_AGE_VERIFICATION',
  'PAYMENTS',
  'ASR',
  'TTS',
  'IMAGE_GENERATION',
  'TEXT_MODERATION',
  'IMAGE_MODERATION'
]);

const FEATURE_CAPABILITY = Object.freeze({
  LLM_CHAT: 'LLM',
  CONVERSATION_SUMMARY_WRITE: 'LLM',
  ENHANCED_AGE_VERIFICATION: 'AGE_VERIFICATION',
  PAYMENTS: 'PAYMENT',
  ASR: 'ASR',
  TTS: 'TTS',
  IMAGE_GENERATION: 'IMAGE_GENERATION',
  TEXT_MODERATION: 'TEXT_MODERATION',
  IMAGE_MODERATION: 'IMAGE_MODERATION'
});

function safeFeatureFlags(overrides = {}) {
  const flags = Object.fromEntries(FEATURE_FLAGS.map((name) => [name, false]));
  for (const [name, value] of Object.entries(overrides || {})) {
    if (!FEATURE_FLAGS.includes(name)) continue;
    flags[name] = value === true;
  }
  return Object.freeze(flags);
}

function enabledCapabilities(featureFlags) {
  return [...new Set(FEATURE_FLAGS
    .filter((name) => featureFlags[name] === true)
    .map((name) => FEATURE_CAPABILITY[name]))];
}

module.exports = { FEATURE_FLAGS, FEATURE_CAPABILITY, safeFeatureFlags, enabledCapabilities };
