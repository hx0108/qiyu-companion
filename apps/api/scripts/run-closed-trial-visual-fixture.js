'use strict';

// Local-only browser visual fixture. It never loads deployment configuration,
// external providers, or persistent storage. Both values must be passed by the
// test runner and must not be production invitation credentials.
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { MemoryTrialInviteAuth } = require('../src/domain/trial-invite-auth');

const port = Number(process.env.PORT || 3103);
const host = process.env.HOST || '127.0.0.1';
const inviteCode = String(process.env.QIYU_VISUAL_FIXTURE_INVITE_CODE || '');
const initialSecret = String(process.env.QIYU_VISUAL_FIXTURE_INITIAL_SECRET || '');

if (!inviteCode || !initialSecret) {
  throw new Error('QIYU_VISUAL_FIXTURE_INVITE_CODE and QIYU_VISUAL_FIXTURE_INITIAL_SECRET are required');
}

async function main() {
  const store = new DevelopmentStore();
  const trialAuth = new MemoryTrialInviteAuth({ store });
  await trialAuth.provisionInvite({ inviteCode, initialSecret, label: 'isolated-visual-fixture' });
  createApp({ store, trialAuthEnabled: true, trialAuth }).listen(port, host);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
