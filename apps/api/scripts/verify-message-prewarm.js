// 本地 Mock 供应商、系统 Edge 真 MP3 解码与 AudioContext 排程验收。无付费调用。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const { createApp } = require('../src/app');
const { LocalPrivateMediaStore } = require('../src/media/local-private-media-store');
async function runSample(index, mode) {
  const root = path.resolve(__dirname, '../../../output/playwright/message-prewarm-2026-10-16');
  fs.mkdirSync(root, { recursive: true });
  const fixture = path.join(root, 'synthetic-tone.mp3');
  const ffmpeg = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=640:duration=0.6:sample_rate=16000', '-codec:a', 'libmp3lame', '-b:a', '48k', fixture], { windowsHide: true });
  if (ffmpeg.status !== 0) throw new Error('本地 ffmpeg 合成音源失败');
  const bytes = fs.readFileSync(fixture);
  let providerComplete = false, providerCalls = 0;
  const timeline = [];
  const mark = (name) => timeline.push({ name, at: Date.now() });
  const media = new LocalPrivateMediaStore({ root: path.join(root, 'private-mock-media') });
  const pendingJob = media.createPendingJob.bind(media);
  media.createPendingJob = async (job) => { mark('manifest-start'); await pendingJob(job); mark('manifest-end'); };
  const server = createApp({
    replyGenerator: async () => ({ reply_text: '今天我也想和你慢慢聊聊。', provider: 'mock', ai_generated: true }),
    textModerator: async () => ({ decision: 'PASS', policyVersion: 'mock-p1' }),
    ttsGenerator: async ({ onAudioSegment }) => {
      providerCalls += 1; mark('provider-start');
      await new Promise((resolve) => setTimeout(resolve, 150));
      onAudioSegment(bytes); mark('first-segment');
      await new Promise((resolve) => setTimeout(resolve, 2000));
      onAudioSegment(bytes); providerComplete = true;
      return { asset: { bytes: Buffer.concat([bytes, bytes]), mimeType: 'audio/mpeg' }, providerRequestId: 'mock-stream-1' };
    },
    mediaStore: media
  });
  server.prependListener('request', (req) => { if (req.url.endsWith('/tts-stream')) mark('request-received'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  let coldTiming = null;
  const network = [];
  page.on('response', async (response) => { if (/tts-stream|media-assets/.test(response.url())) network.push({ url: response.url(), status: response.status(), text: (await response.text().catch(() => '')).slice(0, 250) }); });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const source = original.call(this), start = source.start.bind(source);
      source.start = (...args) => { window.__firstScheduledAt ??= performance.now(); return start(...args); };
      return source;
    };
  });
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('[data-notice-check]').first().waitFor();
    for (const check of await page.locator('[data-notice-check]').all()) await check.check();
    await page.locator('[data-action="submit-notices"]').click();
    await page.locator('[name="birth_date"]').fill('1993-05-20');
    await page.locator('[name="adult_confirmed"]').check();
    await page.locator('#age-form button[type="submit"], #age-form .btn-primary').first().click();
    await page.locator('[name="character_name"]').fill('语音验收角色');
    await page.locator('[name="rights_confirmed"]').check();
    await page.locator('#character-form button[type="submit"], #character-form .btn-primary').first().click();
    await page.locator('#message-form [name="message"]').fill('你今天怎么样？');
    await page.locator('#message-form .send').click();
    const button = page.locator('[data-action="synthesize-message-audio"], [data-action="toggle-message-audio"]').last();
    await button.waitFor();
    if (mode === 'warm') await page.locator('[data-action="toggle-message-audio"]').last().waitFor();
    await page.evaluate(() => {
      window.__firstScheduledAt = undefined;
      document.addEventListener('click', () => { window.__probeClickAt = performance.now(); }, { capture: true, once: true });
    });
    await button.click();
    await page.waitForFunction(() => window.__firstScheduledAt !== undefined, { timeout: 5000 });
    const firstScheduledBeforeProviderCompleted = !providerComplete;
    await page.waitForFunction(() => window.__qiyuMessageAudioTiming !== undefined, { timeout: 7000 });
    const timing = await page.evaluate(() => ({ ...window.__qiyuMessageAudioTiming, clickToScheduledMs: Math.round(window.__firstScheduledAt - window.__probeClickAt) }));
    coldTiming = timing;
    const cachedTiming = null;
    await page.screenshot({ path: path.join(root, `point-play-${index}.png`) });
    const result = { scope: 'Local mock provider; system Edge actual MP3 decode + AudioContext source.start; not acoustic listening or real-provider SLA', providerDelayMs: { firstSegment: 150, remaining: 2000 }, sample: index, mode, firstScheduledBeforeProviderCompleted, timing, cachedTiming, providerCalls, serverTimeline: timeline, pageErrors: errors };
    result.passed = providerCalls === 1 && errors.length === 0 && timing.clickToScheduledMs !== null &&
      (mode === 'warm' ? timing.clickToScheduledMs <= 150 : firstScheduledBeforeProviderCompleted && timing.firstAudibleMs < timing.completedMs - 1000);
    fs.writeFileSync(path.join(root, `browser-first-audio-${index}.json`), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    const result = { sample: index, passed: false, error: error.stack, providerCalls, serverTimeline: timeline, pageErrors: errors, coldTiming, network, body: (await page.locator('body').innerText()).slice(-1500), partialTiming: await page.evaluate(() => window.__qiyuMessageAudioTiming ?? null).catch(() => null) };
    fs.writeFileSync(path.join(root, `browser-first-audio-${index}.json`), JSON.stringify(result, null, 2));
    return result;
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
}
async function main() {
  const root = path.resolve(__dirname, '../../../output/playwright/message-prewarm-2026-10-16');
  const output = path.join(root, 'browser-first-audio.json');
  if (fs.existsSync(output)) fs.copyFileSync(output, path.join(root, `browser-first-audio-prior-${Date.now()}.json`));
  const samples = [];
  for (let index = 1; index <= Number(process.env.VOICE_SAMPLES || 4); index += 1) {
    samples.push(await runSample(index, index % 2 ? 'in-progress' : 'warm'));
    fs.writeFileSync(output, JSON.stringify({ scope: 'Local mock provider; Edge real decode/source.start scheduling, not acoustic or real-provider SLA', samples }, null, 2));
    console.log(JSON.stringify(samples.at(-1)));
  }
  assert.ok(samples.every((sample) => sample.passed), '至少一个样本未满足预热接管或150ms热点击目标，全部样本（含失败）已保存');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
