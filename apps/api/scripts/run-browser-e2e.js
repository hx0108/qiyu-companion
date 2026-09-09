'use strict';

// 浏览器全链路 E2E（P1-5）：把 development/LOCAL_BROWSER_QA_2026-09-05.md 的人工
// 验收路径固化为可重复回归——必要告知 → 年龄声明 → 角色创建 → 对话（SSE 回放）→
// 候选记忆横幅 → TTS 未启用降级 → 时间线 → 数据中心保留期切换 → 日夜主题。
// 环境：内存开发 Store、Mock 回复生成器；浏览器用系统 Edge（channel: msedge，
// 不下载 Chromium）。外部供应商、支付、年龄核验与生产删除不在本链路内。
// 报告写入 development/eval/browser-e2e-YYYY-MM-DD.md，截图写入 output/playwright/。
//

const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { createQwenReplyGenerator } = require('../src/providers/qwen-adapter');
const { createTencentTextModeratorFromEnvironment, createTencentImageModeratorFromEnvironment } = require('../src/providers/tencent-moderation-adapter');
const { createTencentAsrTranscriberFromEnvironment } = require('../src/providers/tencent-asr-adapter');
const { createTencentTtsGeneratorFromEnvironment } = require('../src/providers/tencent-tts-adapter');
const { createTencentHunyuanImageGeneratorFromEnvironment } = require('../src/providers/tencent-hunyuan-image-adapter');
const { createTencentCosPrivateImageStoreFromEnvironment } = require('../src/media/tencent-cos-private-image-store');
const { createTencentCosPrivateMediaStoreFromEnvironment } = require('../src/media/tencent-cos-private-media-store');
const { fetchTencentGeneratedImage } = require('../src/media/tencent-image-result-fetcher');
const { MediaEntitlementService } = require('../src/domain/media-entitlement-service');
const { createControlledPng } = require('./controlled-probe-png');

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

async function main() {
  const { chromium } = require('playwright-core');
  const realQwen = process.env.QIYU_E2E_REAL_QWEN === '1';
  const realTencentMedia = process.env.QIYU_E2E_REAL_TENCENT_MEDIA === '1';
  if (realTencentMedia && !realQwen) throw new Error('QIYU_E2E_REAL_TENCENT_MEDIA=1 requires QIYU_E2E_REAL_QWEN=1.');
  const store = new DevelopmentStore();
  const replyGenerator = realQwen ? createQwenReplyGenerator(process.env) : null;
  if (realQwen && !replyGenerator) throw new Error('QIYU_E2E_REAL_QWEN=1 requires QIYU_LLM_PROVIDER=qwen and QWEN_API_KEY.');
  const providerRuntime = realTencentMedia ? createTencentMediaRuntime(process.env, store) : {};
  const server = createApp({ store, ...(replyGenerator ? { replyGenerator } : {}), ...providerRuntime.appOptions });
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
    // 默认模式下 TTS 未启用是预期降级；真实媒体模式不豁免供应商失败。
    if (response.status() >= 500 && !(response.url().includes('/tts-jobs') && !realTencentMedia)) {
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

    if (realTencentMedia) {
      await step('媒体权益：审核员受控授予单周期开发订阅', async () => {
        const response = await fetch(`${base}/internal/subscriptions/manual-grant`, {
          method: 'POST', headers: reviewerHeaders(), body: JSON.stringify({ account_id: 'acct_dev_alice', sku: 'qiyu_public_monthly_v1', reason: '同会话真实腾讯媒体浏览器验收' })
        });
        const payload = await response.json();
        assert(response.ok && payload.subscription?.state === 'ACTIVE', `媒体权益授予失败：${response.status} ${payload.error?.code || ''}`);
      });
    }

    await step(realQwen ? '对话：真实 Qwen 回复经 SSE 回放完整呈现' : '对话：Mock 回复经 SSE 回放完整呈现', async () => {
      await page.locator('#message-form [name="message"]').fill(realTencentMedia ? '请用一句简短中文问候我，不要解释。' : '今天下班好累呀');
      await page.locator('#message-form .send').click();
      // 真实 Qwen 的服务端生成预算为 20 秒，另留渲染与 SSE 回放余量；Mock
      // 仍会立即通过，不能用其 15 秒等待时间约束真实供应商链路。
      await page.waitForSelector('article.message.ai .bubble', { timeout: realQwen ? 45_000 : 15_000 });
      if (realQwen) {
        const assistant = [...store.messages.values()].filter((message) => message.actor === 'ASSISTANT').at(-1);
        assert(assistant?.provider === 'qwen' && assistant.ai_generated === true, `真实对话未由 Qwen 完成：${assistant?.provider || 'missing'}`);
        assert((await page.locator('article.message.ai .bubble').last().innerText()).trim().length > 0, 'Qwen 回复应完整回放到浏览器');
      } else {
        await page.waitForFunction(() => document.body.innerText.includes('开发 Mock 已收到'), null, { timeout: 15_000 });
      }
    });

    if (!realQwen) {
      await step('记忆拒绝撤销：不记住后 30 秒内可由服务端恢复候选', async () => {
        const candidate = page.locator('[data-action="open-candidate"]');
        await candidate.waitFor({ state: 'visible', timeout: 10_000 });
        await candidate.click();
        await page.locator('[data-action="reject-candidate"]').click();
        const undo = page.locator('[data-action="undo-memory-reject"]');
        await undo.waitFor({ state: 'visible', timeout: 10_000 });
        await undo.click();
        await page.locator('[data-action="open-candidate"]').waitFor({ state: 'visible', timeout: 10_000 });
      });
    }

    await step(realTencentMedia ? 'TTS：真实腾讯语音生成并由鉴权媒体接口播放' : 'TTS 未启用降级：受控失败视图且文字保留', async () => {
      const ttsButton = page.locator('[data-action="synthesize-message-audio"]').first();
      assert(await ttsButton.count() > 0, '助手回复应提供语音按钮');
      await ttsButton.click();
      if (realTencentMedia) {
        await page.waitForFunction(() => Boolean(document.querySelector('article.message.ai audio')) || Boolean(document.querySelector('[data-media-type="TTS"]')), null, { timeout: 60_000 });
        const job = [...store.mediaJobs.values()].find((item) => item.type === 'TTS');
        assert(job?.state === 'COMPLETED', `真实 TTS 未完成：${job?.failure_code || job?.state || 'missing'}`);
        const audio = page.locator('article.message.ai audio').first();
        assert((await audio.getAttribute('src'))?.startsWith('blob:'), '真实 TTS 应经鉴权接口加载为浏览器 Blob');
        return;
      }
      // 两条受控降级路径都算过：无额度 → 权益页引导；有额度但 TTS 未启用 → 失败横幅。
      await page.waitForFunction(() => Boolean(document.querySelector('.rights[data-media-type="TTS"]'))
        || /权益与领取|角色语音/.test(document.body.innerText), null, { timeout: 10_000 });
    });

    if (realTencentMedia) {
      await step('ASR：浏览器上传受控腾讯语音、真实转写、用户确认后回填输入框', async () => {
        const ttsAsset = [...store.mediaAssets.values()].find((item) => item.type === 'TTS_AUDIO' && item.state === 'AVAILABLE');
        assert(ttsAsset?.object_key, 'ASR 串联前应存在浏览器刚生成的私有 TTS 音频');
        const speechBytes = await providerRuntime.mediaStore.readTtsAudio(ttsAsset.object_key);
        await page.locator('[data-action="open-asr"]').click();
        await page.waitForSelector('#asr-file', { timeout: 10_000 });
        await page.locator('#asr-file').setInputFiles({ name: 'qiyu-controlled-asr.mp3', mimeType: 'audio/mpeg', buffer: speechBytes });
        await page.locator('[data-action="create-asr-job"]').click();
        await page.waitForSelector('#asr-edit', { timeout: 60_000 });
        const transcript = (await page.locator('#asr-edit').inputValue()).trim();
        assert(transcript.length > 0, '腾讯 ASR 应返回非空转写');
        await page.locator('[data-action="confirm-asr"]').click();
        await page.waitForSelector('#message-form', { timeout: 15_000 });
        assert((await page.locator('#message-form [name="message"]').inputValue()).trim().length > 0, '确认后的转写应回填但不自动发送');
      });

      await step('图片：浏览器上传受控参考图、IMS 前审与独立权利审核', async () => {
        await page.locator('[data-action="open-image"]').click();
        await page.waitForSelector('#reference-image-file', { timeout: 10_000 });
        await page.locator('#reference-image-file').setInputFiles({ name: 'qiyu-controlled-reference.png', mimeType: 'image/png', buffer: createControlledPng() });
        await page.locator('#reference-image-form [name="image_rights_confirmed"]').check();
        await page.locator('#reference-image-form button[type="submit"], #reference-image-form .btn-primary').first().click();
        await page.waitForFunction(() => document.body.innerText.includes('REVIEW_REQUIRED'), null, { timeout: 60_000 });
        const review = [...store.contentRightsReviews.values()].find((item) => item.account_id === 'acct_dev_alice' && item.subject_type === 'REFERENCE_IMAGE');
        assert(review, '参考图通过 IMS 后应创建独立权利审核');
        const response = await fetch(`${base}/internal/content-rights-reviews/${encodeURIComponent(review.review_id)}/decisions`, {
          method: 'POST', headers: reviewerHeaders(), body: JSON.stringify({ decision: 'APPROVED', reason: '受控无人物测试图，仅用于供应商 E2E' })
        });
        const payload = await response.json();
        assert(response.ok && payload.content_rights_review?.state === 'APPROVED', `权利审核失败：${response.status} ${payload.error?.code || ''}`);
        await page.locator('[data-action="refresh-reference-rights"]').click();
        await page.waitForSelector('#image-scene-form', { timeout: 15_000 });
      });

      await step('图片：真实混元生成、私有 COS 入库、IMS 二审并在浏览器鉴权展示', async () => {
        await page.locator('#image-scene-form [name="scene_location"]').fill('浅米色室内窗边');
        await page.locator('#image-scene-form [name="scene_outfit"]').fill('浅米色针织衫');
        await page.locator('#image-scene-form [name="scene_time_of_day"]').selectOption('AFTERNOON');
        await page.locator('#image-scene-form button[type="submit"], #image-scene-form .btn-primary').first().click();
        await page.waitForFunction(() => Boolean(document.querySelector('[data-action="refresh-image-job"]')) || Boolean(document.querySelector('[data-media-type="IMAGE_GENERATION"]')), null, { timeout: 15_000 });
        const submittedJob = [...store.mediaJobs.values()].find((item) => item.type === 'IMAGE_GENERATION');
        assert(submittedJob?.state === 'PENDING', `图片任务未进入队列：${submittedJob?.failure_code || submittedJob?.state || 'missing'}`);
        const deadline = Date.now() + 210_000;
        while (Date.now() < deadline && await page.locator('[data-action="refresh-image-job"]').count()) {
          const refresh = page.locator('[data-action="refresh-image-job"]');
          await page.waitForFunction(() => {
            const button = document.querySelector('[data-action="refresh-image-job"]');
            return !button || !button.disabled;
          }, null, { timeout: 60_000 });
          if (!await refresh.count()) break;
          await refresh.click();
          await page.waitForFunction(() => {
            const button = document.querySelector('[data-action="refresh-image-job"]');
            return !button || !button.disabled;
          }, null, { timeout: 60_000 });
          if (await page.locator('.generated-image img, img.generated-image').count()) break;
          if (/情境图未交付|BLOCKED|FAILED/.test(await page.locator('body').innerText())) {
            const failedJob = [...store.mediaJobs.values()].find((entry) => entry.type === 'IMAGE_GENERATION');
            throw new Error(`真实图片任务进入失败或阻断态：${failedJob?.failure_code || failedJob?.provider_error_code || failedJob?.state || 'unknown'}`);
          }
          await page.waitForTimeout(5_000);
        }
        const generated = page.locator('.generated-image img, img.generated-image').first();
        assert(await generated.count() > 0, '混元结果应通过私有媒体接口在浏览器显示');
        assert((await generated.getAttribute('src'))?.startsWith('blob:'), '真实图片不得向浏览器暴露 COS 地址');
      });
    }

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

    await step('数据中心：安全中心与站内通知入口可达', async () => {
      await page.locator('[data-action="open-safety"]').click();
      await page.waitForFunction(() => /安全中心|安全/.test(document.body.innerText), null, { timeout: 10_000 });
      // 安全中心设计为回到对话页（不是 data center）；通过其“打开数据中心”
      // 入口返回，避免把原型的真实导航契约错当成浏览器故障。
      await page.locator('[data-action="open-data"]').click();
      await page.waitForFunction(() => document.body.innerText.includes('数据中心'), null, { timeout: 10_000 });
      await page.locator('[data-action="open-notifications"]').click();
      await page.waitForFunction(() => /通知|暂无通知/.test(document.body.innerText), null, { timeout: 10_000 });
      await page.locator('[data-action="back-data"]').click();
      // 通知页的“返回数据中心”按钮本身带有“数据中心”文案，不能把该文案
      // 当作路由已切换的证据；等待数据中心独有的通知入口重新出现。
      await page.waitForSelector('[data-action="open-notifications"]', { state: 'visible', timeout: 10_000 });
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
    if (realTencentMedia) await cleanupControlledMedia(store, providerRuntime).catch((error) => console.error(`受控媒体清理失败：${error.message}`));
  }

  const unexpectedConsoleErrors = consoleErrors.filter((text) => !text.includes('tts') && !text.includes('Failed to load resource'));
  const unexpectedServerErrors = expectedFailures;
  const passed = steps.every((item) => item.status === 'PASS') && unexpectedConsoleErrors.length === 0 && unexpectedServerErrors.length === 0;
  const report = renderReport(steps, consoleErrors, unexpectedServerErrors, passed, realQwen, realTencentMedia);
  console.log(report);
  const outputDir = path.resolve(__dirname, '../../../development/eval');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, `browser-e2e-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(outputFile, report, 'utf8');
  console.log(`\n报告已写入 ${outputFile}`);
  process.exitCode = passed ? 0 : 1;
}

function renderReport(steps, consoleErrors, serverErrors, passed, realQwen, realTencentMedia) {
  const lines = [
    '# 浏览器全链路 E2E 回归报告',
    '',
    `- 运行时间：${new Date().toISOString()}`,
    `- 环境：内存开发 Store + ${realQwen ? '真实 Qwen 回复' : 'Mock 回复'}${realTencentMedia ? ' + 真实腾讯 TTS/ASR/IMS/混元/COS' : ''}；系统 Edge 无头（channel: msedge，不下载 Chromium）。`,
    `- 覆盖：必要告知 → 年龄声明 → 角色创建 → 对话 SSE 回放 → ${realTencentMedia ? '真实 TTS → 真实 ASR → 真实受控图片' : 'TTS 未启用降级'} → 时间线 → 数据中心保留期切换 → 安全中心/通知入口 → 日夜主题。`,
    realTencentMedia ? '- 边界：媒体由同一浏览器会话触发并使用受控资产；账户/权益仍为内存开发态，支付、第三方年龄核验和生产删除不在本链路。' : realQwen ? '- 边界：本轮仅把浏览器聊天替换为真实 Qwen；TTS/ASR/图片仍须由各自腾讯验收脚本覆盖，支付、增强年龄核验和生产删除不在本链路。' : '- 边界：该脚本仍是内存开发 Store + Mock；外部供应商、支付、增强年龄核验和生产删除不在本链路。',
    '',
    '| 步骤 | 结论 | 说明 |',
    '|---|---|---|'
  ];
  for (const step of steps) lines.push(`| ${step.name} | ${step.status} | ${step.detail || '—'} |`);
  lines.push('', `浏览器控制台错误（排除 TTS 预期降级与资源加载噪声）：${consoleErrors.length} 条`, `服务端 5xx（排除 TTS 预期 503）：${serverErrors.length} 条${serverErrors.length ? '：' + serverErrors.join('、') : ''}`, '', passed ? '浏览器 E2E 门禁通过。' : '浏览器 E2E 门禁失败。');
  return lines.join('\n');
}

function reviewerHeaders() {
  return { Authorization: 'Bearer reviewer-dev-token', 'Content-Type': 'application/json', 'Idempotency-Key': `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}` };
}

function createTencentMediaRuntime(environment, store) {
  const configured = { ...environment, TENCENT_HUNYUAN_REGION: environment.TENCENT_HUNYUAN_REGION || environment.TENCENT_REGION || 'ap-guangzhou' };
  const ttsGenerator = createTencentTtsGeneratorFromEnvironment(configured);
  const asrTranscriber = createTencentAsrTranscriberFromEnvironment(configured);
  const textModerator = configured.QIYU_E2E_REAL_TENCENT_TEXT_MODERATION === '1' ? createTencentTextModeratorFromEnvironment(configured) : null;
  const imageModerator = createTencentImageModeratorFromEnvironment(configured);
  const imageGenerator = createTencentHunyuanImageGeneratorFromEnvironment(configured);
  const imageStore = createTencentCosPrivateImageStoreFromEnvironment(configured);
  const mediaStore = createTencentCosPrivateMediaStoreFromEnvironment(configured);
  const providers = { ttsGenerator, asrTranscriber, imageModerator, imageGenerator, imageStore, mediaStore };
  for (const [name, provider] of Object.entries(providers)) if (!provider) throw new Error(`真实腾讯媒体 E2E 缺少 ${name} 配置。`);
  return { ...providers, appOptions: { ttsGenerator, asrTranscriber, textModerator, imageModerator, imageGenerator, imageStore, mediaStore, imageResultFetcher: fetchTencentGeneratedImage, imageEntitlementService: new MediaEntitlementService({ store }) } };
}

async function cleanupControlledMedia(store, runtime) {
  const deletions = [];
  for (const asset of store.mediaAssets.values()) {
    if (!asset.object_key) continue;
    const target = asset.media_type === 'IMAGE' ? runtime.imageStore : runtime.mediaStore;
    if (target?.deleteAsset) deletions.push(target.deleteAsset(asset.object_key));
  }
  await Promise.allSettled(deletions);
}

main().catch((error) => {
  // 工具/终端偶尔会吞掉浏览器子进程 stderr；保留无凭据失败摘要，避免把
  // “没有报告”误判为通过或网络问题。
  try {
    const outputDir = path.resolve(__dirname, '../../../development/eval');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, `browser-e2e-failure-${new Date().toISOString().slice(0, 10)}.txt`), String(error?.stack || error).slice(0, 4000), 'utf8');
  } catch { /* failure evidence must not mask the original error */ }
  console.error(error);
  process.exit(1);
});
