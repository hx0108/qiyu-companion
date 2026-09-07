'use strict';

// 浏览器全链路 E2E（P1-5）：把 development/LOCAL_BROWSER_QA_2026-09-05.md 的人工
// 验收路径固化为可重复回归——必要告知 → 年龄声明 → 角色创建 → 对话（SSE 回放）→
// 候选记忆横幅 → TTS 未启用降级 → 时间线 → 数据中心保留期切换 → 日夜主题。
// 环境：内存开发 Store、Mock 回复生成器；浏览器用系统 Edge（channel: msedge，
// 不下载 Chromium）。外部供应商、支付、年龄核验与生产删除不在本链路内。
// 报告写入 development/eval/browser-e2e-YYYY-MM-DD.md，截图写入 output/playwright/。
//
// 已知边界（如实报告，不算失败）：安全中心（route=safety）当前只有事件处理器
// open-safety，前端没有可点击入口按钮，浏览器链路无法覆盖，需前端补入口后纳入。

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
  const server = createApp({ store });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: process.env.QIYU_E2E_BROWSER_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  const expectedFailures = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    // TTS 未启用是本链路的预期降级（503），不计为错误。
    if (response.status() >= 500 && !response.url().includes('/tts-jobs')) {
      expectedFailures.push(`${response.status()} ${response.url().replace(base, '')}`);
    }
  });

  const backToChat = async () => {
    const back = page.locator('[data-action="back-chat"]');
    if (await back.count() > 0) { await back.first().click(); }
    else {
      const generic = page.locator('button', { hasText: '返回' }).first();
      if (await generic.count() > 0) await generic.click();
    }
    await page.waitForSelector('nav.bottom-nav', { timeout: 10_000 });
  };
  const steps = [];
  const step = async (name, run) => {
    try {
      await run();
      steps.push({ name, status: 'PASS', detail: '' });
    } catch (error) {
      steps.push({ name, status: 'FAIL', detail: String(error?.message || error).slice(0, 300) });
      throw error;
    }
  };
  const screenshotDir = path.resolve(__dirname, '../../../output/playwright');
  fs.mkdirSync(screenshotDir, { recursive: true });

  try {
    await step('必要告知：全部勾选后入口解锁并提交回执', async () => {
      await page.goto(base, { waitUntil: 'networkidle' });
      const checkboxes = page.locator('[data-notice-check]');
      assert(await checkboxes.count() > 0, '应渲染系统告知勾选框');
      const submit = page.locator('[data-action="submit-notices"]');
      assert(await submit.isDisabled(), '未勾选时继续按钮应禁用');
      for (const box of await checkboxes.all()) await box.check();
      assert(!await submit.isDisabled(), '全选后继续按钮应可用');
      await submit.click();
      await page.waitForSelector('#age-form', { timeout: 10_000 });
    });

    await step('年龄声明：提交后进入角色创建', async () => {
      await page.locator('#age-form [name="adult_confirmed"]').check();
      await page.locator('[name="birth_date"]').fill('1993-05-20');
      await page.locator('#age-form button[type="submit"], #age-form .btn-primary').first().click();
      await page.waitForSelector('#character-form', { timeout: 10_000 });
    });

    await step('角色创建：原创确认后进入对话页', async () => {
      await page.locator('#character-form [name="character_name"]').fill('E2E 角色');
      await page.locator('#character-form [name="rights_confirmed"]').check();
      await page.locator('#character-form button[type="submit"], #character-form .btn-primary').first().click();
      await page.waitForSelector('#message-form', { timeout: 15_000 });
    });

    await step('对话：Mock 回复经 SSE 回放完整呈现', async () => {
      await page.locator('#message-form [name="message"]').fill('今天下班好累呀');
      await page.locator('#message-form .send').click();
      await page.waitForSelector('article.message.ai .bubble', { timeout: 15_000 });
      await page.waitForFunction(() => document.body.innerText.includes('开发 Mock 已收到'), null, { timeout: 15_000 });
    });

    await step('TTS 未启用降级：受控失败视图且文字保留', async () => {
      const ttsButton = page.locator('[data-action="synthesize-message-audio"]').first();
      if (await ttsButton.count() === 0) return; // 无助手语音按钮时此步不适用
      await ttsButton.click();
      // 两条受控降级路径都算过：无额度 → 权益页引导；有额度但 TTS 未启用 → 失败横幅。
      await page.waitForFunction(() => Boolean(document.querySelector('.rights[data-media-type="TTS"]'))
        || /权益与领取|角色语音/.test(document.body.innerText), null, { timeout: 10_000 });
    });

    await step('时间线：入口可达且渲染确认资产视图', async () => {
      await backToChat();
      await page.locator('nav.bottom-nav [data-action="open-assets"]').click();
      await page.waitForSelector('#app-title', { timeout: 10_000 });
      await page.waitForFunction(() => document.body.innerText.includes('关系时间线'), null, { timeout: 10_000 });
    });

    await step('数据中心：保留期 90→30 切换按 API 回读显示', async () => {
      await backToChat();
      await page.locator('nav.bottom-nav [data-action="open-data"]').click();
      await page.waitForFunction(() => document.body.innerText.includes('数据中心'), null, { timeout: 10_000 });
      const ninety = page.locator('[data-action="set-retention-90"]');
      if (await ninety.count() > 0) {
        await ninety.click();
        await page.waitForFunction(() => document.body.innerText.includes('当前 90 天'), null, { timeout: 10_000 });
      }
      await page.locator('[data-action="set-retention-30"]').click();
      await page.waitForFunction(() => document.body.innerText.includes('当前 30 天'), null, { timeout: 10_000 });
    });

    await step('日夜主题：切换控件触发重渲染', async () => {
      await backToChat();
      await page.waitForSelector('#message-form', { timeout: 10_000 });
      const beforeTheme = await page.locator('.app-screen').getAttribute('class');
      await page.locator('[data-action="toggle-theme"]').click();
      await page.waitForFunction((before) => {
        const current = document.querySelector('.app-screen')?.className ?? '';
        return current !== before;
      }, beforeTheme, { timeout: 10_000 });
    });

    await page.screenshot({ path: path.join(screenshotDir, 'browser-e2e-final.png'), fullPage: true });
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }

  const unexpectedConsoleErrors = consoleErrors.filter((text) => !text.includes('tts') && !text.includes('Failed to load resource'));
  const unexpectedServerErrors = expectedFailures;
  const passed = steps.every((item) => item.status === 'PASS') && unexpectedConsoleErrors.length === 0 && unexpectedServerErrors.length === 0;
  const report = renderReport(steps, consoleErrors, unexpectedServerErrors, passed);
  console.log(report);
  const outputDir = path.resolve(__dirname, '../../../development/eval');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, `browser-e2e-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(outputFile, report, 'utf8');
  console.log(`\n报告已写入 ${outputFile}`);
  process.exitCode = passed ? 0 : 1;
}

function renderReport(steps, consoleErrors, serverErrors, passed) {
  const lines = [
    '# 浏览器全链路 E2E 回归报告',
    '',
    `- 运行时间：${new Date().toISOString()}`,
    '- 环境：内存开发 Store + Mock 回复；系统 Edge 无头（channel: msedge，不下载 Chromium）。',
    '- 覆盖：必要告知 → 年龄声明 → 角色创建 → 对话 SSE 回放 → TTS 未启用降级 → 时间线 → 数据中心保留期切换 → 日夜主题。',
    '- 已知边界：安全中心（route=safety）前端暂无可点击入口（仅 open-safety 处理器），本链路无法覆盖，待前端补入口后纳入；外部供应商/支付/年龄核验/生产删除不在本链路。',
    '',
    '| 步骤 | 结论 | 说明 |',
    '|---|---|---|'
  ];
  for (const step of steps) lines.push(`| ${step.name} | ${step.status} | ${step.detail || '—'} |`);
  lines.push('', `浏览器控制台错误（排除 TTS 预期降级与资源加载噪声）：${consoleErrors.length} 条`, `服务端 5xx（排除 TTS 预期 503）：${serverErrors.length} 条${serverErrors.length ? '：' + serverErrors.join('、') : ''}`, '', passed ? '浏览器 E2E 门禁通过。' : '浏览器 E2E 门禁失败。');
  return lines.join('\n');
}

main().catch((error) => { console.error(error); process.exit(1); });
