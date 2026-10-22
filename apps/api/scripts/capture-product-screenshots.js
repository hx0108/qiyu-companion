'use strict';

// Public documentation assets: actual frontend, isolated Edge, disposable local
// invitation and deterministic replies. Never reads .env or contacts providers.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { launchIsolatedBrowser } = require('./isolated-browser');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { MemoryTrialInviteAuth } = require('../src/domain/trial-invite-auth');

const root = path.resolve(__dirname, '../../..');
const output = path.join(root, 'output/playwright/product-screenshots');
const publish = process.argv.includes('--publish');
const destination = path.join(root, 'docs/screenshots');
const viewport = { width: 402, height: 874 };

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const store = new DevelopmentStore({ accountIds: [] });
  const trialAuth = new MemoryTrialInviteAuth({ store });
  const invite = `DOCS-${randomBytes(16).toString('hex').toUpperCase()}`;
  await trialAuth.provisionInvite({ inviteCode: invite, initialSecret: randomBytes(32).toString('base64url'), label: 'disposable-documentation-fixture' });
  const server = createApp({ store, trialAuth, trialAuthEnabled: true,
    // Call UI is exercised with a fake capture device and inert local provider.
    realtimeCallEnabled: true, realtimeProvider: { model: 'documentation-mock', async createSession() { return { close() {}, async sendAudio() {} }; } },
    textModerator: async () => ({ decision: 'PASS' }),
    replyGenerator: async () => ({ provider: 'mock', model_version: 'documentation-fixture-v1', ai_generated: true,
      reply_text: '那就先把脚步放慢一点吧。今天最想分享的，是哪一个小瞬间？',
      memory_candidate: { type: 'development_note', normalized_value: { text: '喜欢在周末读书' }, display_text: '周末喜欢安静地读书', confidence: 1 } }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, closeBrowser;
  const images = [], errors = [];
  try {
    ({ browser, close: closeBrowser } = await launchIsolatedBrowser({ channel: 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }));
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, serviceWorkers: 'block', reducedMotion: 'reduce', locale: 'zh-CN', permissions: ['microphone'] });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    const action = name => page.locator(`[data-action="${name}"]`).filter({ visible: true }).first().click();
    async function shot(file, title) {
      await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') !== 'true');
      await page.evaluate(() => document.fonts.ready);
      await page.locator('.device-shell').screenshot({ path: path.join(output, file), animations: 'disabled' });
      const bytes = fs.readFileSync(path.join(output, file));
      images.push({ file, title, sha256: createHash('sha256').update(bytes).digest('hex') });
      console.log('CAPTURE ' + file);
    }
    await page.goto(origin);
    await page.locator('#trial-login-form').waitFor();
    // Do not capture an invitation or any browser storage.
    await page.locator('[name="invite_code"]').fill(invite);
    await page.locator('#trial-login-form .btn-primary').click();
    await page.locator('[data-notice-check]').first().waitFor();
    await shot('01-notices.png', '必要告知');
    for (const box of await page.locator('[data-notice-check]').all()) await box.check();
    await action('submit-notices');
    await page.locator('#age-form').waitFor();
    await shot('02-age.png', '年龄声明');
    await page.locator('[name="birth_date"]').fill('1993-05-20');
    await page.locator('[name="adult_confirmed"]').check();
    await page.locator('#age-form .btn-primary').click();
    await page.locator('#character-form').waitFor();
    await shot('03-character.png', '创建角色');
    await page.locator('[name="character_name"]').fill('林默');
    await page.locator('[name="rights_confirmed"]').check();
    await page.locator('#character-form .btn-primary').click();
    await page.locator('#message-form').waitFor();
    await page.locator('[name="message"]').fill('今天想慢下来，周末在家读一本书。');
    await page.locator('#message-form .send').click();
    await page.locator('article.message.ai .bubble').waitFor();
    await shot('04-chat-day.png', '陪伴 · 日间');
    await page.getByRole('button', { name: '我的', exact: true }).click();
    await action('toggle-theme');
    await page.getByRole('button', { name: '陪伴', exact: true }).click();
    await shot('05-chat-night.png', '陪伴 · 夜间');
    await page.getByRole('button', { name: '我的', exact: true }).click();
    await action('toggle-theme');
    await shot('10-profile.png', '我的');
    await action('open-character-profile');
    await page.locator('.profile-editor').waitFor();
    await shot('07-character-profile.png', '角色档案');
    await action('back-chat');
    await action('open-persona-versions');
    await page.locator('.persona-versions').waitFor();
    await shot('11-persona-versions.png', '人格版本');
    await action('back-chat');
    await action('open-data');
    await shot('08-data-center.png', '数据与隐私');
    await action('back-chat');
    await action('open-proactive');
    await shot('14-proactive.png', '主动消息与静默时间');
    await action('back-chat');
    await page.getByRole('button', { name: '此刻', exact: true }).click();
    await shot('09-home.png', '此刻');
    assert.equal(await page.locator('[data-action="start-call"]').isDisabled(), false);
    await action('open-notifications');
    await shot('13-notifications.png', '站内通知');
    await action('back-notifications');
    await page.getByRole('button', { name: '回忆', exact: true }).click();
    await shot('06-timeline.png', '回忆 · 空状态');
    await page.getByRole('button', { name: '陪伴', exact: true }).click();
    await action('open-chat-menu');
    await page.getByRole('dialog', { name: '陪伴选项', exact: true }).waitFor();
    await shot('12-chat-menu.png', '陪伴选项');
    await action('close-chat-menu');
    await action('start-call');
    await page.waitForFunction(() => window.__qiyuCall?.phase === 'ready');
    await shot('15-voice-call.png', '语音通话 · 本机假麦克风与 Mock 连接');
    await action('call-hangup');
    await page.locator('#message-form').waitFor();
    assert.deepEqual(errors, []);
    const sources = ['apps/web/index.html', 'apps/web/app.js', 'apps/web/apricot-ui.js', 'apps/web/apricot.css'];
    const manifest = { captured_at: new Date().toISOString(), viewport_css: viewport, device_scale_factor: 2, browser: 'isolated Microsoft Edge', frontend: '20261021-chat-menu-v32', data: 'local synthetic account; deterministic mock reply; fake microphone and inert mock native provider; no real provider, user data or physical microphone', sources: Object.fromEntries(sources.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])), images };
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    if (publish) {
      fs.mkdirSync(destination, { recursive: true });
      for (const file of [...images.map(item => item.file), 'manifest.json']) fs.copyFileSync(path.join(output, file), path.join(destination, file));
    }
    console.log(JSON.stringify({ images: images.length, page_errors: errors.length, copied_to_docs: publish }));
  } finally {
    await closeBrowser?.();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });
