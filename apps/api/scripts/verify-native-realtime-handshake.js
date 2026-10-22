'use strict';

// Explicit opt-in only. No audio, prompt, StartConnection or StartSession is sent.
// This checks gateway authentication, not model entitlement or conversational latency.
const { randomUUID } = require('node:crypto');
const PRICE_SOURCE = 'https://docs.volcengine.com/docs/DoubaoVoice/Billinginstructions-21?lang=zh';
async function main() {
  const plan = { probe: 'websocket-upgrade-auth-only', requests: 1, retries: 0, deadline_ms: 5000,
    inference_requests: 0, audio_bytes_sent: 0, prompt_bytes_sent: 0,
    expected_inference_cost_cny: 0, billing_verified: false,
    price_source: PRICE_SOURCE,
    caveat: 'Official pricing bills token inference; idle connection minimum charges are not explicitly documented. Upgrade acceptance does not establish model entitlement.' };
  if (!process.argv.includes('--execute-auth-only')) { process.stdout.write(`${JSON.stringify({ status: 'DRY_RUN_NO_NETWORK', plan }, null, 2)}\n`); return; }
  const raw = process.env.VOLCENGINE_REALTIME_API_KEY || process.env.Doubao_API_KEY;
  if (typeof raw !== 'string' || !raw.trim()) throw Object.assign(new Error('语音权限验证凭据未配置'), { code: 'REALTIME_PROBE_KEY_MISSING' });
  // The existing key is explicitly selected for this probe in memory, never persisted.
  const { WebSocket } = require('ws');
  const started = performance.now();
  const result = await new Promise((resolve) => {
    let finished = false;
    const socket = new WebSocket('wss://openspeech.bytedance.com/api/v3/realtime/dialogue', { headers: {
      'X-Api-Key': raw, 'X-Api-Resource-Id': 'volc.speech.dialog', 'X-Api-Connect-Id': randomUUID()
    }, handshakeTimeout: 5000, perMessageDeflate: false, maxPayload: 4096 });
    function finish(status, httpStatus) {
      if (finished) return; finished = true; clearTimeout(timer); socket.terminate();
      resolve({ status, ...(httpStatus ? { http_status: httpStatus } : {}), elapsed_ms: Math.round(performance.now() - started), plan });
    }
    const timer = setTimeout(() => finish('AUTH_HANDSHAKE_TIMEOUT'), 5000);
    socket.once('open', () => finish('AUTH_UPGRADE_ACCEPTED_MODEL_UNVERIFIED', 101));
    socket.once('unexpected-response', (_request, response) => { response.resume(); finish('AUTH_UPGRADE_REJECTED', response.statusCode); });
    socket.once('error', () => finish('AUTH_HANDSHAKE_FAILED'));
    socket.once('close', () => finish('AUTH_HANDSHAKE_CLOSED'));
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'AUTH_UPGRADE_ACCEPTED_MODEL_UNVERIFIED') process.exitCode = 1;
}
main().catch((error) => {
  // Do not serialize raw WS errors, URLs, headers, process.env or provider payloads.
  process.stderr.write(`${JSON.stringify({ status: 'PROBE_FAILED', code: error.code === 'REALTIME_PROBE_KEY_MISSING' ? error.code : 'REALTIME_PROBE_INTERNAL_ERROR' })}\n`);
  process.exitCode = 1;
});
