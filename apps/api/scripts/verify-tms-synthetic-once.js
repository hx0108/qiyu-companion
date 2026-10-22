'use strict';

// One approved synthetic comparison request, never retries, no private data.
const fs = require('node:fs');
const path = require('node:path');
const { createTencentTextModeratorFromEnvironment } = require('../src/providers/tencent-moderation-adapter');
async function main() {
  const scope = process.argv.includes('--scope-server') ? 'same-region-api-container' : 'local-workstation';
  const result = { scope, synthetic_text: true, requests: 0, automatic_retries: 0,
    configured_timeout_ms: Number(process.env.TENCENT_MODERATION_TIMEOUT_MS) || 10000,
    effective_diagnostic_timeout_ms: Math.min(Number(process.env.TENCENT_MODERATION_TIMEOUT_MS) || 10000, 3000),
    price_per_request_cny: 0.0025, price_source: 'https://cloud.tencent.com/document/product/1124/37118', billed_cost_verified: false };
  if (!process.argv.includes('--execute-approved-once')) { process.stdout.write(JSON.stringify({ ...result, status: 'DRY_RUN_NO_NETWORK' }) + '\n'); return; }
  const started = performance.now();
  try {
    const moderate = createTencentTextModeratorFromEnvironment({ ...process.env, QIYU_TEXT_MODERATION_PROVIDER: 'tencent', TENCENT_MODERATION_TIMEOUT_MS: String(result.effective_diagnostic_timeout_ms) });
    result.requests = 1;
    const response = await moderate({ text: '你好。', accountId: 'synthetic-latency-probe' });
    result.status = 'SUCCEEDED'; result.decision = response.decision;
  } catch (error) {
    result.status = 'FAILED'; result.code = /^TENCENT_[A-Z_]+$/.test(error.code || '') ? error.code : 'DIAGNOSTIC_FAILED';
  }
  result.elapsed_ms = Math.round(performance.now() - started);
  if (scope === 'local-workstation') {
    const destination = path.resolve(__dirname, '../../../output/native-realtime-2026-10-16/tms-local-once.json');
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.status !== 'SUCCEEDED') process.exitCode = 1;
}
if (require.main === module) main();
