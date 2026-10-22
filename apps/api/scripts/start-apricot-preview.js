'use strict';

// Local-only, disposable preview. No environment-based provider composition,
// production persistence, or real microphone/voice provider is connected here.
const { createApp } = require('../src/app');

async function startPreview({ port = 4314 } = {}) {
  const server = createApp();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let sequence = 0;
  async function api(path, body) {
    const response = await fetch(origin + '/api/v1' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer dev-alice-token',
        'content-type': 'application/json',
        'idempotency-key': `apricot-preview-${++sequence}`
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`Preview setup failed: ${path} (${response.status}, ${result.error?.code || 'UNKNOWN'})`);
    return result;
  }
  try {
    // These are synthetic development fixtures, not the user's age or consent.
    // Seed through existing contracts rather than bypassing their domain gates.
    const notices = await api('/required-notices');
    for (const notice of notices.notices) {
      await api(`/required-notices/${encodeURIComponent(notice.notice_id)}/displayed`, { notice_version: notice.notice_version });
    }
    await api('/age/declarations', { date_of_birth: '1990-01-01', confirmed_18_plus: true });
    const result = await api('/characters', { name: '林默' });
    await api('/conversations', { character_id: result.character.character_id });
    return { server, origin };
  } catch (error) {
    await new Promise(resolve => server.close(resolve));
    throw error;
  }
}

if (require.main === module) {
  startPreview().then(({ origin }) => {
    console.log(`Apricot preview ready: ${origin}`);
    console.log('Local synthetic account; memory/mock only. Data resets when this process exits. No paid providers.');
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { startPreview };
