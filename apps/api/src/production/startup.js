'use strict';

const { safeFeatureFlags, enabledCapabilities } = require('./feature-flags');
const { validateProviderRegistry } = require('./provider-registry');

class StartupConfigurationError extends Error {
  constructor(diagnostics) {
    super('Production provider configuration is incomplete or unapproved');
    this.name = 'StartupConfigurationError';
    this.code = 'PRODUCTION_CONFIGURATION_INVALID';
    this.diagnostics = diagnostics;
  }
}

function assertRuntimeConfiguration(environment = process.env) {
  const production = environment.NODE_ENV === 'production';
  if (!production) return Object.freeze({ mode: 'development', featureFlags: safeFeatureFlags() });
  const raw = environment.QIYU_PROVIDER_CONFIG_JSON;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new StartupConfigurationError([{ code: 'PRODUCTION_CONFIG_REQUIRED', message: 'QIYU_PROVIDER_CONFIG_JSON is required in production' }]);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new StartupConfigurationError([{ code: 'PRODUCTION_CONFIG_INVALID_JSON', message: 'QIYU_PROVIDER_CONFIG_JSON must be valid JSON' }]);
  }
  return assertProductionConfiguration(config);
}

function assertProductionConfiguration(config = {}) {
  const featureFlags = safeFeatureFlags(config.featureFlags);
  const capabilities = enabledCapabilities(featureFlags);
  const diagnostics = validateProviderRegistry({
    providers: config.providers,
    bindings: config.providerBindings,
    enabledCapabilities: capabilities
  });
  if (diagnostics.length) throw new StartupConfigurationError(diagnostics);
  return Object.freeze({ mode: 'production', featureFlags, providerBindings: Object.freeze({ ...(config.providerBindings || {}) }) });
}

// apps/api currently composes DevelopmentStore and a deterministic Mock adapter.
// Keep this guard next to the startup policy so a valid provider record can never
// accidentally make that development composition externally reachable.
function assertLocalSyntheticRuntimeAllowed(runtime) {
  if (runtime.mode === 'production') {
    const error = new Error('The local synthetic runtime cannot serve production traffic');
    error.name = 'ProductionRuntimeNotWiredError';
    error.code = 'PRODUCTION_RUNTIME_NOT_WIRED';
    throw error;
  }
  return runtime;
}

module.exports = { StartupConfigurationError, assertRuntimeConfiguration, assertProductionConfiguration, assertLocalSyntheticRuntimeAllowed };
