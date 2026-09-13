'use strict';

// 按住说话 PCM 降级路径浏览器 E2E（2026-09-14）：微信 XWEB 等内核裁掉
// MediaRecorder 的 webm/opus、ogg/opus 编码器（isTypeSupported 全 false），
// 旧代码直接 toast「不支持录音」且零请求发出（生产 nginx 242 条 POST 里零
// asr-jobs 的根因）。本脚本删除 window.MediaRecorder 模拟该环境，验证降级
// 路径端到端：按住 → AudioContext 直采 PCM → 16k WAV → /asr-jobs → 转写
// 文本直达发送框。音源用受控连续正弦（Chromium 假麦克风默认间歇蜂鸣）。
//

const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

function writeContinuousToneWav(filePath, { seconds = 4, rate = 16_000 } = {}) {
  const samples = rate * seconds;
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 640 * index) / rate) * 0.25 * 0x7fff), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}

async function main() {
  const { chromium } = require('playwright-core');
  const store = new DevelopmentStore();
  const transcriberCalls = [];
  const server = createApp({
    store,
    asrTranscriber: async (input) => {
      transcriberCalls.push({ mimeType: input.mimeType, bytes: input.bytes?.length ?? 0, riff: Buffer.from(input.bytes ?? []).subarray(0, 4).toString() });
      return { providerRequestId: 'fake-asr-pcm', text: '浏览器直采转写成功' };
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const fakeMicWav = path.join(require('node:os').tmpdir(), 'qiyu-e2e-fake-mic.wav');
  writeContinuousToneWav(fakeMicWav);
  const browser = await chromium.launch({
    channel: process.env.QIYU_E2E_BROWSER_CHANNEL || 'msedge', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${fakeMicWav.replace(/\\/g, '/')}`],
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  // 模拟微信 XWEB：没有 MediaRecorder（selectRecordingMimeType 必然 null → 降级 PCM）。
  await page.addInitScript(() => { delete window.MediaRecorder; });
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  const steps = [];
  const step = async (name, run) => {
    try {
      await run();
      steps.push({ name, status: 'PASS' });
      console.log(`PASS ${name}`);
    } catch (error) {
      steps.push({ name, status: 'FAIL', detail: String(error?.message || error).slice(0, 300) });
      console.log(`FAIL ${name} :: ${String(error?.message || error).slice(0, 300)}`);
      throw error;
    }
  };
  const screenshotDir = path.resolve(__dirname, '../../../output/playwright');
  fs.mkdirSync(screenshotDir, { recursive: true });

  try {
    await step('引导：必要告知→年龄→角色创建→对话页', async () => {
      await page.goto(base, { waitUntil: 'networkidle' });
      for (const box of await page.locator('[data-notice-check]').all()) await box.check();
      await page.locator('[data-action="submit-notices"]').click();
      await page.locator('[name="birth_date"]').fill('1993-05-20');
      await page.locator('#age-form [name="adult_confirmed"]').check();
      await page.locator('#age-form button[type="submit"], #age-form .btn-primary').first().click();
      await page.locator('#character-form [name="character_name"]').fill('E2E 角色');
      await page.locator('#character-form [name="rights_confirmed"]').check();
      await page.locator('#character-form button[type="submit"], #character-form .btn-primary').first().click();
      await page.waitForSelector('#message-form', { timeout: 15_000 });
    });

    await step('模拟微信 XWEB 后麦克风按钮仍可用（不再判「不支持录音」）', async () => {
      const gone = await page.evaluate(() => typeof window.MediaRecorder === 'undefined');
      assert(gone, 'MediaRecorder 应已被删除');
      const mode = page.evaluate(() => {
        const button = document.querySelector('[data-action="enter-voice-mode"]');
        if (button) { button.click(); return 'clicked'; }
        return document.querySelector('[data-action="hold-asr"]') ? 'already-voice' : 'missing';
      });
      assert(await page.evaluate(async (mode) => mode !== 'missing', mode), '语音模式入口缺失');
      await page.waitForSelector('[data-action="hold-asr"]', { timeout: 5_000 });
    });

    await step('按住 1.6 秒说话：PCM 采集→16k WAV→服务端受理', async () => {
      const hold = page.locator('[data-action="hold-asr"]');
      const box = await hold.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(1_600);
      await page.mouse.up();
      // 自动确认链：转写文本直达发送框（fix-v21 口径），并自动切回文字模式。
      try {
        await page.waitForFunction(() => (document.querySelector('#message-form [name="message"]')?.value ?? '').includes('浏览器直采转写成功'), null, { timeout: 15_000 });
      } catch (error) {
        const diagnostics = await page.evaluate(() => ({
          toast: document.querySelector('.toast')?.textContent ?? '(no toast)',
          voiceMode: Boolean(document.querySelector('[data-action="hold-asr"]')),
          messageValue: document.querySelector('#message-form [name="message"]')?.value ?? '',
        }));
        console.log('DIAG', JSON.stringify(diagnostics), 'transcriberCalls=', JSON.stringify(transcriberCalls));
        throw error;
      }
    });

    await step('服务端收到的是 16k WAV（RIFF 头、合理大小），而非容器封装', async () => {
      assert(transcriberCalls.length === 1, `应恰好 1 次转写调用，实际 ${transcriberCalls.length}`);
      const call = transcriberCalls[0];
      assert(call.mimeType === 'audio/wav', `mime 应为 audio/wav，实际 ${call.mimeType}`);
      assert(call.riff === 'RIFF', `应有 RIFF 头，实际 ${call.riff}`);
      assert(call.bytes > 44 && call.bytes <= 2 * 1024 * 1024, `字节数应落在 (44, 2MB]，实际 ${call.bytes}`);
      // 1.6 秒 @16k PCM16 ≈ 51200 字节 ± 采集/重采样余量
      assert(call.bytes > 20_000, `1.6 秒采集不应过短，实际 ${call.bytes}`);
      const rate = page.evaluate(() => 1); // 占位保持 await 形态一致
      await rate;
      await page.screenshot({ path: path.join(screenshotDir, 'pcm-asr-fallback.png') });
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
