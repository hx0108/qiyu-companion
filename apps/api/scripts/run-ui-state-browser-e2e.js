'use strict';

// Replaces the retired V1.2 HTML annotation gate with 42 actual frontend states.
// Synthetic local invitation, no provider calls, no physical microphone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { launchIsolatedBrowser } = require('./isolated-browser');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { MemoryTrialInviteAuth } = require('../src/domain/trial-invite-auth');

async function main() {
  const output = path.resolve(__dirname, '../../../output/playwright/ui-states');
  fs.mkdirSync(output, { recursive: true });
  const store = new DevelopmentStore({ accountIds: [] });
  const trialAuth = new MemoryTrialInviteAuth({ store });
  const invite = 'DOCS-' + randomBytes(16).toString('hex').toUpperCase();
  await trialAuth.provisionInvite({ inviteCode: invite, initialSecret: randomBytes(32).toString('base64url'), label: 'ui-state-regression' });
  const server = createApp({ store, trialAuth, trialAuthEnabled: true });
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { browser, close } = await launchIsolatedBrowser({ channel: process.env.QIYU_E2E_BROWSER_CHANNEL || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 402, height: 874 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  const errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  const action = name => page.locator(`[data-action="${name}"]`).filter({ visible: true }).first().click();
  async function check(id, selector, expectedText) {
    await page.locator(selector).first().waitFor();
    await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') !== 'true');
    const metrics = await page.evaluate(() => ({ text: document.querySelector('#app').innerText, overflow: document.documentElement.scrollWidth - innerWidth, width: document.querySelector('#app').getBoundingClientRect().width }));
    assert.ok(metrics.text.trim(), `${id}: empty UI`);
    assert.ok(metrics.overflow <= 1 && metrics.width > 0, `${id}: horizontal overflow`);
    if (expectedText) assert.ok(metrics.text.includes(expectedText), `${id}: missing ${expectedText}`);
    results.push({ id, passed: true }); console.log('PASS ' + id);
  }
  const nav = name => page.getByRole('button', { name, exact: true }).click();
  try {
    await page.goto(origin);
    await check('login', '#trial-login-form', '邀请码');
    await page.locator('[name="invite_code"]').fill(invite);
    await page.locator('#trial-login-form .btn-primary').click();
    await check('notice-unchecked', '[data-notice-check]', '告知');
    assert.equal(await page.locator('[data-action="submit-notices"]').isDisabled(), true);
    for (const input of await page.locator('[data-notice-check]').all()) await input.check();
    await check('notice-ready', '[data-action="submit-notices"]');
    assert.equal(await page.locator('[data-action="submit-notices"]').isDisabled(), false);
    await action('submit-notices');
    await check('age-empty', '#age-form');
    await page.locator('[name="birth_date"]').fill('1993-05-20');
    await page.locator('[name="adult_confirmed"]').check();
    await check('age-filled', '#age-form');
    await page.locator('#age-form .btn-primary').click();
    await check('character-empty', '#character-form');
    await page.locator('[name="character_name"]').fill('界面回归角色');
    await page.locator('[name="rights_confirmed"]').check();
    await check('character-ready', '#character-form');
    await page.locator('#character-form .btn-primary').click();
    await page.locator('#message-form').waitFor();
    for (const theme of ['day', 'night']) {
      if (theme === 'night') { await nav('我的'); await action('toggle-theme'); }
      for (const [label, route] of [['此刻','home'],['陪伴','chat'],['回忆','assets'],['我的','profile']]) {
        await nav(label); await check(`${theme}-${route}`, `.apricot-${route === 'chat' ? 'chat' : 'screen'}`, label);
        assert.equal(await page.locator('nav.apricot-nav [aria-current="page"]').count(), 1);
      }
      for (const [name, route, title] of [['open-character-profile','character-profile','角色档案'],['open-persona-versions','persona-versions','人格版本'],['open-proactive','proactive','主动消息与静默时间'],['open-subscription','subscription','试用与可用能力'],['open-data','data','数据与隐私'],['open-safety','safety','帮助与反馈'],['open-plans','plans','陪伴计划']]) {
        await action(name);
        await page.waitForFunction(value => document.querySelector('#app').dataset.route === value, route);
        await check(`${theme}-${route}`, '#app-title', title);
        await action('back-chat');
        await page.waitForFunction(() => document.querySelector('#app').dataset.route === 'profile');
      }
      await action('open-character-profile');
      for (const step of [1,2,3]) {
        await page.locator(`.editor-steps [data-step="${step}"]`).click();
        await check(`${theme}-profile-step-${step + 1}`, '.editor-steps [aria-current="step"]');
        assert.equal(await page.locator('.editor-steps [aria-current="step"]').getAttribute('data-step'), String(step));
      }
      await page.locator('.editor-steps [data-step="0"]').click();
      await action('open-portrait-picker');
      await check(`${theme}-portrait`, '.portrait-picker', '确认');
      await action('close-portrait-picker');
      await page.locator('.profile-editor').waitFor();
      await action('back-chat');
      await nav('陪伴'); await action('open-chat-menu');
      await check(`${theme}-chat-menu`, '[role="dialog"]', '陪伴选项');
      assert.equal(await page.locator('.apricot-chat-menu .apricot-setting').count(), 6);
      await page.keyboard.press('Escape');
      await page.locator('.apricot-chat-menu').waitFor({ state: 'detached' });
      await nav('此刻'); await action('open-notifications');
      await check(`${theme}-notifications`, '#app-title', '站内通知');
      await action('back-notifications');
      await page.waitForFunction(() => document.querySelector('#app').dataset.route === 'home');
    }
    const failurePage = await context.newPage();
    await failurePage.route('**/api/v1/trial-access', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成网络异常：请重试' } }) }));
    await failurePage.goto(origin);
    await failurePage.getByText('合成网络异常：请重试').waitFor();
    assert.ok((await failurePage.locator('#app').innerText()).includes('合成网络异常'));
    results.push({ id: 'bootstrap-error-visible', passed: true }); console.log('PASS bootstrap-error-visible');
    await failurePage.close();
    assert.equal(results.length, 42);
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('STATE FAILURE: ' + error.message);
    results.push({ id: 'failure', passed: false, error: error.message });
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ states: results, page_errors: errors }, null, 2));
    console.log('CLEANUP browser');
    await close();
    console.log('CLEANUP sockets');
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    console.log('CLEANUP complete');
  }
  console.log(JSON.stringify({ states: results.length, passed: results.filter(item => item.passed).length, failed: 0, scope: 'current frontend and local mock API; not real device/provider acceptance' }));
}
main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });
