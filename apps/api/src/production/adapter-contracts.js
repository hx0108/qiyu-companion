'use strict';

// Adapter method names are intentionally vendor-neutral. Business modules must
// use these contracts rather than vendor SDK fields or raw webhook payloads.
const ADAPTER_CONTRACTS = Object.freeze({
  LLM: Object.freeze({ methods: ['generate'], output: ['text', 'providerRequestId', 'modelVersion', 'usage'] }),
  AGE_VERIFICATION: Object.freeze({ methods: ['startVerification', 'verifyWebhook'], output: ['assertion', 'providerEventId'] }),
  PAYMENT: Object.freeze({ methods: ['createCheckout', 'verifyWebhook'], output: ['providerEventId', 'transactionRef', 'effectiveAt'] }),
  ASR: Object.freeze({ methods: ['transcribe'], output: ['text', 'providerRequestId'] }),
  TTS: Object.freeze({ methods: ['synthesize'], output: ['asset', 'providerRequestId'] }),
  IMAGE_GENERATION: Object.freeze({ methods: ['generate'], output: ['asset', 'providerRequestId'] }),
  TEXT_MODERATION: Object.freeze({ methods: ['moderateText'], output: ['decision', 'providerRequestId', 'policyVersion'] }),
  IMAGE_MODERATION: Object.freeze({ methods: ['moderateImage'], output: ['decision', 'providerRequestId', 'policyVersion'] }),
  PROVIDER_DELETION: Object.freeze({ methods: ['delete'], output: ['state', 'providerReceipt'] })
});

class AdapterContractError extends Error {
  constructor(capability, message) {
    super(message);
    this.name = 'AdapterContractError';
    this.code = 'ADAPTER_CONTRACT_INVALID';
    this.capability = capability;
  }
}

function assertAdapterContract(capability, adapter) {
  const contract = ADAPTER_CONTRACTS[capability];
  if (!contract) throw new AdapterContractError(capability, `Unknown adapter capability: ${capability}`);
  if (!adapter || typeof adapter !== 'object') throw new AdapterContractError(capability, 'Adapter must be an object');
  for (const method of contract.methods) {
    if (typeof adapter[method] !== 'function') {
      throw new AdapterContractError(capability, `Adapter must implement ${method}()`);
    }
  }
  return adapter;
}

function assertAdapterResult(capability, result) {
  const contract = ADAPTER_CONTRACTS[capability];
  if (!contract) throw new AdapterContractError(capability, `Unknown adapter capability: ${capability}`);
  if (!result || typeof result !== 'object') throw new AdapterContractError(capability, 'Adapter result must be an object');
  for (const field of contract.output) {
    if (result[field] === undefined || result[field] === null || result[field] === '') {
      throw new AdapterContractError(capability, `Adapter result must include ${field}`);
    }
  }
  if (capability === 'AGE_VERIFICATION' && !['AGE_18_PLUS', 'UNDER_18', 'UNDETERMINED'].includes(result.assertion)) {
    throw new AdapterContractError(capability, 'Age assertion must be AGE_18_PLUS, UNDER_18, or UNDETERMINED');
  }
  if (['TEXT_MODERATION', 'IMAGE_MODERATION'].includes(capability) && !['PASS', 'REVIEW', 'BLOCK'].includes(result.decision)) {
    throw new AdapterContractError(capability, 'Moderation decision must be PASS, REVIEW, or BLOCK');
  }
  if (capability === 'PROVIDER_DELETION' && result.state !== 'COMPLETED') {
    throw new AdapterContractError(capability, 'Provider deletion is only complete with state COMPLETED');
  }
  return result;
}

// A narrow registration point prevents a live provider from being accidentally
// selected without its companion deletion implementation.
function createAdapterRegistry(adapters = {}) {
  const registered = new Map();
  for (const [capability, adapter] of Object.entries(adapters)) {
    registered.set(capability, assertAdapterContract(capability, adapter));
  }
  return Object.freeze({
    get(capability) { return registered.get(capability); },
    has(capability) { return registered.has(capability); }
  });
}

module.exports = { ADAPTER_CONTRACTS, AdapterContractError, assertAdapterContract, assertAdapterResult, createAdapterRegistry };
