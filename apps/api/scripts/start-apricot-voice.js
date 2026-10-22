'use strict';

// Explicitly opted-in, local-only real voice. Starting this service does not
// open a provider session; only an authenticated user's call can do that.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { MemoryTrialInviteAuth, normalizeInviteCode } = require('../src/domain/trial-invite-auth');
const { createVolcengineRealtimeAdapterFromEnvironment } = require('../src/providers/volcengine-realtime-adapter');
const { createTencentTextModeratorFromEnvironment } = require('../src/providers/tencent-moderation-adapter');

async function startVoicePreview({ environment, inviteCode, port = 4314, factories = {} } = {}) {
  if (!environment || environment.NODE_ENV === 'production') throw new Error('LOCAL_VOICE_ENVIRONMENT_REQUIRED');
  const code = normalizeInviteCode(inviteCode);
  if (!environment.TENCENT_TEXT_MODERATION_BIZ_TYPE?.trim()) throw new Error('REALTIME_MODERATION_CONFIGURATION_REQUIRED');
  const realtimeProvider = (factories.realtime || createVolcengineRealtimeAdapterFromEnvironment)(environment);
  const textModerator = (factories.moderation || createTencentTextModeratorFromEnvironment)({ ...environment, QIYU_TEXT_MODERATION_PROVIDER: 'tencent' });
  if (!realtimeProvider) throw new Error('REALTIME_PROVIDER_CONFIGURATION_REQUIRED');
  if (typeof textModerator !== 'function') throw new Error('REALTIME_MODERATION_CONFIGURATION_REQUIRED');
  const store = new DevelopmentStore({ accountIds: [] });
  const trialAuth = new MemoryTrialInviteAuth({ store });
  await trialAuth.provisionInvite({ inviteCode: code, initialSecret: randomBytes(32).toString('base64url'), label: 'local-apricot-real-voice' });
  const server = createApp({ store, trialAuth, trialAuthEnabled: true, realtimeProvider, realtimeCallEnabled: true, textModerator });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function main() {
  const root = path.resolve(__dirname, '../../..');
  process.loadEnvFile(path.join(root, '.env'));
  const invitePath = path.join(root, 'output/apricot-local-voice-invite.txt');
  let inviteCode;
  try { inviteCode = normalizeInviteCode(fs.readFileSync(invitePath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('LOCAL_VOICE_INVITE_FILE_INVALID');
    fs.mkdirSync(path.dirname(invitePath), { recursive: true });
    inviteCode = `QIYU-${randomBytes(16).toString('hex').toUpperCase()}`;
    // Private local credential artifact; never write the code or keys to logs.
    fs.writeFileSync(invitePath, inviteCode + '\n', { flag: 'wx', mode: 0o600 });
  }
  const { origin } = await startVoicePreview({ environment: process.env, inviteCode });
  console.log(`Local real voice ready: ${origin}; authentication=closed-trial-invite; realtime=enabled`);
  console.log('Invite is in output/apricot-local-voice-invite.txt. Local memory data resets on restart. Text chat remains Mock.');
  console.log('No provider calls were made during startup. Provider charges apply when you initiate real voice.');
}

if (require.main === module) main().catch(() => {
  // Do not serialize provider errors, credentials, environment, or invite codes.
  console.error('Local real voice startup failed. Check port availability, local .env provider configuration and invite file.');
  process.exitCode = 1;
});
module.exports = { startVoicePreview };
