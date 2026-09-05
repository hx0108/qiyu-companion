'use strict';

const { ADAPTER_CONTRACTS } = require('./adapter-contracts');

const CALLBACK_CAPABILITIES = new Set(['AGE_VERIFICATION', 'PAYMENT']);
const EXTERNAL_CAPABILITIES = new Set(['LLM', 'AGE_VERIFICATION', 'PAYMENT', 'ASR', 'TTS', 'IMAGE_GENERATION', 'TEXT_MODERATION', 'IMAGE_MODERATION']);
const SECRET_REF_PATTERN = /^(secret|vault|kms|sm):\/\/[A-Za-z0-9._\/-]+$/;
const APPROVAL_STATE = 'APPROVED';

function validateProviderRegistry({ providers = [], bindings = {}, enabledCapabilities = [] } = {}) {
  const diagnostics = [];
  const byId = new Map();
  if (!Array.isArray(providers)) {
    return [{ code: 'PROVIDERS_NOT_ARRAY', message: 'providers must be an array' }];
  }
  for (const provider of providers) {
    if (!provider || typeof provider !== 'object' || !nonBlank(provider.id)) {
      diagnostics.push(issue('PROVIDER_ID_REQUIRED', 'Every provider requires a non-empty id'));
      continue;
    }
    if (byId.has(provider.id)) diagnostics.push(issue('PROVIDER_ID_DUPLICATE', `Provider id ${provider.id} is duplicated`, { providerId: provider.id }));
    byId.set(provider.id, provider);
  }
  for (const capability of enabledCapabilities) {
    const providerId = bindings[capability];
    if (!nonBlank(providerId)) {
      diagnostics.push(issue('PROVIDER_BINDING_REQUIRED', `${capability} requires a provider binding`, { capability }));
      continue;
    }
    const provider = byId.get(providerId);
    if (!provider) {
      diagnostics.push(issue('PROVIDER_BINDING_UNKNOWN', `${capability} references unknown provider ${providerId}`, { capability, providerId }));
      continue;
    }
    const record = provider.capabilities && provider.capabilities[capability];
    if (!record || typeof record !== 'object') {
      diagnostics.push(issue('PROVIDER_CAPABILITY_REQUIRED', `${providerId} lacks capability ${capability}`, { capability, providerId }));
      continue;
    }
    validateCapabilityRecord({ capability, providerId, record, diagnostics });
  }
  return diagnostics;
}

function validateCapabilityRecord({ capability, providerId, record, diagnostics }) {
  if (!EXTERNAL_CAPABILITIES.has(capability)) {
    diagnostics.push(issue('CAPABILITY_UNKNOWN', `Unsupported external capability ${capability}`, { capability, providerId }));
    return;
  }
  if (!nonBlank(record.version) || /(^|\/)latest$/i.test(record.version)) {
    diagnostics.push(issue('PROVIDER_VERSION_REQUIRED', `${providerId}/${capability} needs an immutable, non-latest version`, { capability, providerId }));
  }
  if (!nonBlank(record.region)) diagnostics.push(issue('PROVIDER_REGION_REQUIRED', `${providerId}/${capability} needs an approved processing region`, { capability, providerId }));
  if (!isSecretRef(record.credentialRef)) diagnostics.push(issue('CREDENTIAL_REFERENCE_REQUIRED', `${providerId}/${capability} needs a secret reference, not a credential value`, { capability, providerId }));
  validateDataPolicy(record.dataPolicy, capability, providerId, diagnostics);
  validateDeletion(record.deletion, capability, providerId, diagnostics);
  if (CALLBACK_CAPABILITIES.has(capability)) validateWebhook(record.webhook, capability, providerId, diagnostics);
}

function validateDataPolicy(policy, capability, providerId, diagnostics) {
  if (!policy || typeof policy !== 'object' || policy.approvalState !== APPROVAL_STATE || !nonBlank(policy.policyVersion) || !nonBlank(policy.dpaVersion) || !nonBlank(policy.effectiveAt)) {
    diagnostics.push(issue('APPROVED_DATA_POLICY_REQUIRED', `${providerId}/${capability} requires an approved, versioned data policy and DPA`, { capability, providerId }));
    return;
  }
  if (policy.trainingUse !== false || typeof policy.crossBorder !== 'boolean' || !positiveNumber(policy.deleteSlaHours)) {
    diagnostics.push(issue('DATA_POLICY_INCOMPLETE', `${providerId}/${capability} must declare trainingUse=false, crossBorder, and delete SLA`, { capability, providerId }));
  }
}

function validateDeletion(deletion, capability, providerId, diagnostics) {
  if (!deletion || deletion.supported !== true || deletion.receiptRequired !== true || !positiveNumber(deletion.deleteSlaHours)) {
    diagnostics.push(issue('PROVIDER_DELETION_REQUIRED', `${providerId}/${capability} requires a receipted provider deletion contract`, { capability, providerId }));
  }
}

function validateWebhook(webhook, capability, providerId, diagnostics) {
  const acceptedAlgorithms = new Set(['HMAC_SHA256', 'ED25519']);
  if (!webhook || !acceptedAlgorithms.has(webhook.signatureAlgorithm) || !isSecretRef(webhook.signatureSecretRef) || !nonBlank(webhook.signatureHeader) || !nonBlank(webhook.timestampHeader) || !nonBlank(webhook.eventIdPath) || !positiveNumber(webhook.maxAgeSeconds) || !isSecretRef(webhook.replayStoreRef)) {
    diagnostics.push(issue('WEBHOOK_SIGNATURE_CONFIG_REQUIRED', `${providerId}/${capability} requires signature, replay, and freshness configuration`, { capability, providerId }));
  }
}

function issue(code, message, details = {}) { return { code, message, ...details }; }
function nonBlank(value) { return typeof value === 'string' && value.trim().length > 0; }
function positiveNumber(value) { return Number.isFinite(value) && value > 0; }
function isSecretRef(value) { return typeof value === 'string' && SECRET_REF_PATTERN.test(value); }

module.exports = { CALLBACK_CAPABILITIES, APPROVAL_STATE, validateProviderRegistry, isSecretRef };
