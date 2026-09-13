'use strict';

// 多行聊天输入框浏览器 E2E（2026-09-14）：单行 input 不能换行是用户试用反馈，
// 本脚本验证 textarea 化后的真实浏览器行为——自动增高与换行、增高不盖最后一条
// 消息（--qy-composer-extra 链路）、Enter 发送/Shift+Enter 换行、流式重渲染不冲
// 掉草稿。环境与 run-browser-e2e.js 一致：内存 Store、Mock 回复、系统 Edge。
//

const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

async function main() {
  const { chromium } = require('playwright-core');
  const store = new DevelopmentStore();
  const server = createApp({ store, voiceCallEnabled: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: process.env.QIYU_E2E_BROWSER_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  const steps = [];
  const step = async (name, run) => {
    try {
      await run();
      steps.push({ name, status: 'PASS', detail: '' });
      console.log(`PASS ${name}`);
    } catch (error) {
      steps.push({ name, status: 'FAIL', detail: String(error?.message || error).slice(0, 300) });
      console.log(`FAIL ${name} :: ${String(error?.message || error).slice(0, 300)}`);
      throw error;
    }
  };
  const screenshotDir = path.resolve(__dirname, '../../../output/playwright');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const input = page.locator('#message-form textarea[name="message"]');
  const metrics = () => page.evaluate(() => {
    const el = document.querySelector('#message-form textarea[name="message"]');
    const scroller = document.querySelector('.chat-scroll');
    return {
      height: el?.offsetHeight ?? 0,
      scrollWidth: el?.scrollWidth ?? 0,
      clientWidth: el?.clientWidth ?? 0,
      value: el?.value ?? '',
      extra: document.documentElement.style.getPropertyValue('--qy-composer-extra') || '(unset)',
      scrollPaddingBottom: scroller ? getComputedStyle(scroller).paddingBottom : '',
      userMessages: document.querySelectorAll('article.message.me').length,
    };
  });

  try {
    await step('引导：必要告知→年龄→角色创建→对话页', async () => {
      await page.goto(base, { waitUntil: 'networkidle' });
      const checkboxes = page.locator('[data-notice-check]');
      for (const box of await checkboxes.all()) await box.check();
      await page.locator('[data-action="submit-notices"]').click();
      await page.locator('[name="birth_date"]').fill('1993-05-20');
      await page.locator('#age-form [name="adult_confirmed"]').check();
      await page.locator('#age-form button[type="submit"], #age-form .btn-primary').first().click();
      await page.locator('#character-form [name="character_name"]').fill('E2E 角色');
      await page.locator('#character-form [name="rights_confirmed"]').check();
      await page.locator('#character-form button[type="submit"], #character-form .btn-primary').first().click();
      await page.waitForSelector('#message-form', { timeout: 15_000 });
    });

    await step('输入框是单行起步的 textarea（rows=1、初始 44px）', async () => {
      assert(await input.count() === 1, '应存在 textarea[name=message]');
      const tag = await page.evaluate(() => document.querySelector('#message-form [name="message"]')?.tagName);
      assert(tag === 'TEXTAREA', `元素应为 TEXTAREA，实际 ${tag}`);
      const rows = await page.evaluate(() => document.querySelector('#message-form textarea[name="message"]')?.getAttribute('rows'));
      assert(rows === '1', `rows 应为 1，实际 ${rows}`);
      const m = await metrics();
      assert(m.height === 44, `初始高度应 44px，实际 ${m.height}`);
      assert(m.extra === '(unset)' || m.extra === '0px', `初始无增高，实际 ${m.extra}`);
    });

    await step('长文本自动换行且输入框增高，聊天底部预留同步加大', async () => {
      const longText = '这是一段很长很长的倾诉'.repeat(14); // 154 字，约 5+ 行
      await input.fill(longText);
      await page.waitForFunction(() => (document.querySelector('#message-form textarea[name="message"]')?.offsetHeight ?? 0) > 60, null, { timeout: 5_000 });
      const m = await metrics();
      assert(m.scrollWidth <= m.clientWidth + 1, `长文本必须换行不横向溢出：scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth}`);
      assert(m.height > 60 && m.height <= 112, `增高后应在 (60,112] 内，实际 ${m.height}`);
      const extraValue = parseFloat(m.extra);
      assert(extraValue > 0 && Math.abs(extraValue - (m.height - 44)) < 2, `--qy-composer-extra 应等于增高量，extra=${m.extra} height=${m.height}`);
      const pad = parseFloat(m.scrollPaddingBottom);
      assert(pad > 155, `聊天底部预留应大于 155px，实际 ${m.scrollPaddingBottom}`);
      await page.screenshot({ path: path.join(screenshotDir, 'multiline-input-grown.png') });
    });

    await step('Shift+Enter 插入换行且不发送', async () => {
      const before = (await metrics()).userMessages;
      await input.focus();
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type('第二行');
      const m = await metrics();
      assert(m.value.includes('\n') && m.value.endsWith('第二行'), `应包含换行与续写，实际 ${JSON.stringify(m.value.slice(-8))}`);
      assert(m.userMessages === before, 'Shift+Enter 不应发送消息');
    });

    await step('重渲染（切日夜主题）不冲掉正在输入的草稿', async () => {
      await page.locator('[data-action="toggle-theme"]').click();
      await page.waitForFunction(() => document.documentElement.dataset.qyTheme === 'night', null, { timeout: 5_000 });
      const m = await metrics();
      assert(m.value.includes('\n') && m.value.endsWith('第二行'), `重渲染后草稿应保留，实际 ${JSON.stringify(m.value.slice(-8))}`);
      assert(m.height > 60, `重渲染后增高应恢复，实际 ${m.height}`);
      await page.locator('[data-action="toggle-theme"]').click();
      await page.waitForFunction(() => document.documentElement.dataset.qyTheme === 'day', null, { timeout: 5_000 });
    });

    await step('Enter 发送：清空草稿、高度回落 44、预留复位', async () => {
      await input.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => (document.querySelector('#message-form textarea[name="message"]')?.value ?? 'x') === '', null, { timeout: 15_000 });
      await page.waitForFunction(() => document.querySelectorAll('article.message.me').length > 0, null, { timeout: 15_000 });
      const m = await metrics();
      assert(m.height === 44, `发送后高度应回落 44px，实际 ${m.height}`);
      assert(parseFloat(m.extra) === 0, `发送后额外预留应复位，实际 ${m.extra}`);
      await page.waitForFunction(() => document.body.innerText.includes('开发 Mock 已收到'), null, { timeout: 15_000 });
      await page.screenshot({ path: path.join(screenshotDir, 'multiline-input-sent.png') });
    });
  } finally {
    await browser.close();
    server.close();
    const failed = steps.filter((item) => item.status === 'FAIL');
    console.log(`\n${steps.length - failed.length}/${steps.length} PASS，控制台错误 ${consoleErrors.length} 条${consoleErrors.length ? `：${consoleErrors.join(' | ').slice(0, 300)}` : ''}`);
    if (failed.length > 0) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
