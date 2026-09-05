'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { safeFeatureFlags } = require('../src/production/feature-flags');
const { assertAdapterContract, assertAdapterResult, createAdapterRegistry, AdapterContractError } = require('../src/production/adapter-contracts');
const { assertRuntimeConfiguration, assertProductionConfiguration, assertLocalSyntheticRuntimeAllowed, StartupConfigurationError } = require('../src/production/startup');

function approvedCapability(version = 'model-2026-09-01') {
  return {
    version,
    region: 'cn-north-1',
    credentialRef: 'secret://qiyu/providers/example',
    dataPolicy: { approvalState: 'APPROVED', policyVersion: 'policy-2026-09', dpaVersion: 'dpa-4', effectiveAt: '2026-09-01T00:00:00Z', trainingUse: false, crossBorder: false, deleteSlaHours: 24 },
    deletion: { supported: true, receiptRequired: true, deleteSlaHours: 24 }
  };
}

test('all external high-risk feature flags fail closed by default', () => {
  assert.deepEqual(safeFeatureFlags(), {
    LLM_CHAT: false, CONVERSATION_SUMMARY_WRITE: false, ENHANCED_AGE_VERIFICATION: false, PAYMENTS: false, ASR: false, TTS: false, IMAGE_GENERATION: false, TEXT_MODERATION: false, IMAGE_MODERATION: false
  });
  assert.equal(assertRuntimeConfiguration({ NODE_ENV: 'development' }).mode, 'development');
});

test('production startup refuses absent or malformed provider configuration', () => {
  assert.throws(() => assertRuntimeConfiguration({ NODE_ENV: 'production' }), (error) => error instanceof StartupConfigurationError && error.diagnostics[0].code === 'PRODUCTION_CONFIG_REQUIRED');
  assert.throws(() => assertRuntimeConfiguration({ NODE_ENV: 'production', QIYU_PROVIDER_CONFIG_JSON: '{bad' }), (error) => error instanceof StartupConfigurationError && error.diagnostics[0].code === 'PRODUCTION_CONFIG_INVALID_JSON');
});

test('enabled LLM requires binding, immutable version, region, secret reference, approved policy, and deletion receipt', () => {
  const base = { featureFlags: { LLM_CHAT: true }, providerBindings: { LLM: 'model-a' }, providers: [{ id: 'model-a', capabilities: { LLM: approvedCapability() } }] };
  assert.equal(assertProductionConfiguration(base).mode, 'production');
  for (const [mutate, expected] of [
    [(item) => { item.capabilities.LLM.version = 'latest'; }, 'PROVIDER_VERSION_REQUIRED'],
    [(item) => { item.capabilities.LLM.credentialRef = 'sk-live-value'; }, 'CREDENTIAL_REFERENCE_REQUIRED'],
    [(item) => { item.capabilities.LLM.dataPolicy.approvalState = 'PENDING'; }, 'APPROVED_DATA_POLICY_REQUIRED'],
    [(item) => { item.capabilities.LLM.deletion.supported = false; }, 'PROVIDER_DELETION_REQUIRED']
  ]) {
    const config = structuredClone(base);
    mutate(config.providers[0]);
    assert.throws(() => assertProductionConfiguration(config), (error) => error instanceof StartupConfigurationError && error.diagnostics.some((issue) => issue.code === expected));
  }
});

test('a passing provider configuration still cannot boot the local Mock and in-memory runtime as production', () => {
  const config = { featureFlags: { LLM_CHAT: true }, providerBindings: { LLM: 'model-a' }, providers: [{ id: 'model-a', capabilities: { LLM: approvedCapability() } }] };
  const runtime = assertProductionConfiguration(config);
  assert.throws(() => assertLocalSyntheticRuntimeAllowed(runtime), (error) => error.code === 'PRODUCTION_RUNTIME_NOT_WIRED');
});

test('age and payment callback capabilities require signed, replay-protected webhook configuration', () => {
  const age = approvedCapability('age-rule-2026-09');
  const config = { featureFlags: { ENHANCED_AGE_VERIFICATION: true }, providerBindings: { AGE_VERIFICATION: 'age-a' }, providers: [{ id: 'age-a', capabilities: { AGE_VERIFICATION: age } }] };
  assert.throws(() => assertProductionConfiguration(config), (error) => error.diagnostics.some((issue) => issue.code === 'WEBHOOK_SIGNATURE_CONFIG_REQUIRED'));
  age.webhook = { signatureAlgorithm: 'HMAC_SHA256', signatureSecretRef: 'vault://qiyu/age-webhook', signatureHeader: 'x-signature', timestampHeader: 'x-timestamp', eventIdPath: 'event.id', maxAgeSeconds: 300, replayStoreRef: 'secret://qiyu/replay-store' };
  assert.equal(assertProductionConfiguration(config).mode, 'production');
});

test('all provider adapter contracts are explicit and reject incomplete adapters', () => {
  assert.doesNotThrow(() => createAdapterRegistry({
    LLM: { generate() {} },
    AGE_VERIFICATION: { startVerification() {}, verifyWebhook() {} },
    PAYMENT: { createCheckout() {}, verifyWebhook() {} },
    ASR: { transcribe() {} }, TTS: { synthesize() {} }, IMAGE_GENERATION: { generate() {} }, TEXT_MODERATION: { moderateText() {} }, IMAGE_MODERATION: { moderateImage() {} }, PROVIDER_DELETION: { delete() {} }
  }));
  assert.throws(() => assertAdapterContract('PAYMENT', { createCheckout() {} }), AdapterContractError);
  assert.throws(() => assertAdapterContract('UNKNOWN', {}), AdapterContractError);
  assert.doesNotThrow(() => assertAdapterResult('AGE_VERIFICATION', { assertion: 'AGE_18_PLUS', providerEventId: 'evt_1' }));
  assert.doesNotThrow(() => assertAdapterResult('TEXT_MODERATION', { decision: 'PASS', providerRequestId: 'req_1', policyVersion: 'tencent-tms-v1' }));
  assert.doesNotThrow(() => assertAdapterResult('PROVIDER_DELETION', { state: 'COMPLETED', providerReceipt: 'receipt_1' }));
  assert.throws(() => assertAdapterResult('AGE_VERIFICATION', { assertion: 'UNKNOWN', providerEventId: 'evt_2' }), AdapterContractError);
  assert.throws(() => assertAdapterResult('TEXT_MODERATION', { decision: 'UNKNOWN', providerRequestId: 'req_2', policyVersion: 'tencent-tms-v1' }), AdapterContractError);
  assert.throws(() => assertAdapterResult('PROVIDER_DELETION', { state: 'PROCESSING', providerReceipt: 'receipt_2' }), AdapterContractError);
});
