'use strict';

// Browser structural gate for all 42 V1.2 handoff states. Runtime API and
// provider behavior remains covered by run-browser-e2e.js.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const { chromium } = require('playwright-core');
  const root = path.resolve(__dirname, '../../..');
  const manifestPath = path.join(root, 'designs/qiyu-v1-handoff/static/screen-manifest.json');
  const prototypePath = path.join(root, 'designs/qiyu-v1-handoff/prototype/栖语_V1_高保真原型_v1.2_交付版.html');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest) || manifest.length !== 42) throw new Error(`Expected 42 states, received ${manifest?.length}`);
  if (new Set(manifest.map((item) => item.id)).size !== manifest.length) throw new Error('Duplicate state ids in manifest');

  const browser = await chromium.launch({ channel: process.env.QIYU_E2E_BROWSER_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
  const results = [];
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  try {
    for (const entry of manifest) {
      const url = new URL(pathToFileURL(prototypePath));
      url.searchParams.set('screen', entry.id);
      url.searchParams.set('annotate', '1');
      let status = 'PASS';
      let detail = '—';
      try {
        await page.goto(url.href, { waitUntil: 'load', timeout: 20_000 });
        await page.waitForFunction((id) => window.qiyuHandoff?.manifest?.some((item) => item.id === id), entry.id, { timeout: 10_000 });
        const appText = (await page.locator('#app').innerText()).trim();
        const bodyText = await page.locator('body').innerText();
        if (!appText) throw new Error('#app rendered empty content');
        if (!bodyText.includes(entry.id) || !bodyText.includes(entry.title)) throw new Error('Annotation does not identify requested state');
        if (!bodyText.includes('复制当前链接')) throw new Error('Annotation mode is not visible');
      } catch (error) {
        status = 'FAIL';
        detail = String(error?.message || error).replace(/\|/g, '\\|').slice(0, 240);
      }
      results.push({ id: entry.id, title: entry.title, status, detail });
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const passed = results.every((item) => item.status === 'PASS') && consoleErrors.length === 0;
  const report = renderReport(results, consoleErrors, passed);
  const outputDir = path.join(root, 'development/eval');
  fs.mkdirSync(outputDir, { recursive: true });
  const output = path.join(outputDir, `prototype-42-state-browser-e2e-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(output, report, 'utf8');
  process.stdout.write(`${report}\n\n报告已写入 ${output}\n`);
  process.exitCode = passed ? 0 : 1;
}

function renderReport(results, consoleErrors, passed) {
  const lines = [
    '# 栖语 V1.2 原型 42 状态浏览器门禁', '',
    `- 运行时间：${new Date().toISOString()}`,
    '- 环境：系统 Edge 无头，逐个打开独立状态 URL，并开启标注模式。',
    '- 边界：验证交付原型状态可达性和渲染结构；不替代 Web/API、真实供应商、支付、年龄核验或生产删除验收。', '',
    '| ID | 页面 | 结论 | 说明 |', '|---|---|---|---|'
  ];
  for (const item of results) lines.push(`| ${item.id} | ${item.title} | ${item.status} | ${item.detail} |`);
  lines.push('', `状态：${results.filter((item) => item.status === 'PASS').length}/${results.length} PASS`, `浏览器控制台错误：${consoleErrors.length}`, '', passed ? '42 状态浏览器门禁通过。' : '42 状态浏览器门禁失败。');
  return lines.join('\n');
}

main().catch((error) => { console.error(error); process.exit(1); });
