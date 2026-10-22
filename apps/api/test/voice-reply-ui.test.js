const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const webRoot = path.resolve(__dirname, '../../web');
const css = fs.readFileSync(path.join(webRoot, 'prototype-restoration.css'), 'utf8') + '\n' + fs.readFileSync(path.join(webRoot, 'apricot.css'), 'utf8');
const ui = fs.readFileSync(path.join(webRoot, 'apricot-ui.js'), 'utf8');
const app = fs.readFileSync(path.join(webRoot, 'app.js'), 'utf8');
const session = fs.readFileSync(path.join(webRoot, 'encrypted-session.js'), 'utf8');
const mediaInput = fs.readFileSync(path.join(webRoot, 'media-input.js'), 'utf8');

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  assert.ok(matches.length, `missing CSS rule: ${selector}`);
  // Desktop breakpoint rules override individual declarations, not the entire base rule.
  const declarations = new Map();
  for (const match of matches) for (const entry of match[1].split(';')) {
    const pair = entry.trim().match(/^([-\w]+)\s*:\s*(.*)$/);
    if (pair) declarations.set(pair[1], pair[2]);
  }
  return [...declarations].map(([key, value]) => `${key}:${value}`).join(';');
}

test('B3 voice control is inline before reply text with no separate player row', () => {
  assert.ok(app.includes('class="bubble">') && app.includes('voiceRow'));
  assert.ok(app.includes('<span class="message-copy">'));
  const row = rule('.qiyu-prototype .voice-control-row');
  assert.match(row, /position:\s*static/);
  assert.match(row, /display:\s*inline/);
  assert.match(rule('.qiyu-prototype .voice-control-row::before'), /display:\s*none/);
  assert.match(rule('.qiyu-prototype .voice-trigger'), /width:\s*16px/);
  assert.match(rule('.qiyu-prototype .voice-trigger::before'), /width:\s*44px/);
});

test('B3 bubble shares warm matte surface, rounded outline and readable body text', () => {
  assert.ok(css.includes('background:#f7f2ee'));
  assert.ok(css.includes('border-radius:23px 23px 23px 5px'));
  assert.ok(css.includes('font:16px/1.7'));
  assert.ok(css.includes('padding-right:18px;padding-bottom:15px'));
});

test('B3 night mode has independent text, surface and audible highlight colors', () => {
  assert.ok(css.includes('background:#352923;color:#fff4eb'));
  assert.ok(css.includes('color:#ffcaab'));
  assert.ok(css.includes('box-shadow:inset 0 -.29em #694630'));
});

test('voice duration comes from decoded audio and playback UI uses real audio state', () => {
  assert.ok(app.includes('formatVoiceDuration(audio?.duration)'));
  assert.ok(app.includes('formatVoiceDuration(active.player.holdDuration)'));
  assert.ok(app.includes('active.player.outputPaused = active.paused'));
  assert.ok(app.includes('active.player.context.suspend()'));
  assert.ok(app.includes('active.player.context.resume()'));
  assert.ok(app.includes('refreshMessageAudioUi()'));
  assert.ok(!app.includes('0:12'));
});

test('four approved primary tabs retain hidden secondary capabilities and full-width nav', () => {
  assert.ok(ui.includes("['home','navHome','此刻','open-home']"));
  assert.ok(ui.includes("['chat','navCompanion','陪伴','back-chat']"));
  assert.ok(ui.includes("['assets','navMemory','回忆','open-assets']"));
  assert.ok(ui.includes("['profile','navProfile','我的','open-profile']"));
  assert.ok(ui.includes('data-action="open-plans"'));
  const nav = rule('.qiyu-prototype .bottom-nav.apricot-nav');
  assert.match(nav, /left:\s*0/);
  assert.match(nav, /right:\s*0/);
  assert.match(nav, /repeat\(4,minmax\(0,1fr\)\)/);
  assert.ok(ui.includes('查看角色档案') && ui.includes('主动关心与提醒'));
});

test('keyboard resizes chat, hides navigation and keeps composer at keyboard edge', () => {
  assert.ok(css.includes('body.qy-keyboard-open .qiyu-prototype.apricot-chat'));
  assert.ok(css.includes('body.qy-keyboard-open .qiyu-prototype.apricot-chat .composer-wrap{bottom:6px}'));
  assert.ok(css.includes('body.qy-keyboard-open .qiyu-prototype .bottom-nav.apricot-nav{display:none}'));
  assert.ok(app.includes('--qy-app-height'));
  assert.ok(app.includes('visualViewport?.addEventListener("resize", syncKeyboardInset)'));
});

test('multiline input preserves composition, draft and scrolling while matching B3 composer', () => {
  assert.match(app, /<textarea name="message" rows="1" maxlength="2000"/);
  assert.doesNotMatch(app, /<input name="message"/);
  assert.ok(app.includes('MESSAGE_INPUT_MAX_HEIGHT_PX'));
  assert.ok(app.includes('--qy-composer-extra'));
  assert.ok(app.includes('state.pendingTranscript = event.target.value'));
  assert.match(app, /event\.key !== "Enter" \|\| event\.shiftKey \|\| event\.isComposing \|\| event\.keyCode === 229/);
  const baseTextarea = [...css.matchAll(/\.qiyu-prototype\.apricot-chat \.composer textarea\s*\{([^}]*)\}/g)][0]?.[1] ?? '';
  assert.match(baseTextarea, /max-height:\s*112px/);
  assert.ok(css.includes('padding:31px 19px calc(220px + var(--qy-composer-extra,0px))'));
});

test('人格表单提供角色性别选择，性别值随 persona 提交给服务端驱动男/女声', () => {
  assert.match(app, /name="persona_gender"/);
  assert.match(app, /genderOption\("female", "女性 · 女声"\)/);
  assert.match(app, /genderOption\("male", "男性 · 男声"\)/);
  assert.match(app, /gender:\s*\["male", "female"\]\.includes\(form\.elements\.persona_gender\?\.value\)/);
});

test('历史通话消息缺少情境快照时显示准确错误而不是归因于语音供应商', () => {
  assert.match(app, /MULTIMODAL_SOURCE_SNAPSHOT_MISSING/);
  assert.match(app, /这条历史通话消息缺少生成语音所需的情境记录，无法播放/);
});

test('微信 XWEB 等 MediaRecorder 不可用的内核：按住说话降级 AudioContext 直采 PCM 自封 WAV', () => {
  // 根因（2026-09-14）：微信裁掉 webm/opus、ogg/opus 编码器，selectRecordingMimeType
  // 返回 null 后旧代码直接 toast「不支持录音」，零请求发出（nginx 零 asr-jobs 记录）。
  // getUserMedia 能开麦就必须能录：PCM 直采绕开 MediaRecorder 容器与 decodeAudioData。
  assert.match(mediaInput, /export async function createPcmWavRecorder\(stream\)/);
  assert.match(mediaInput, /createScriptProcessor/);
  assert.match(mediaInput, /renderMonoWav/);
  assert.match(mediaInput, /encodePcm16Wav/);
  // 前端在无可用编码器时走 PCM 路径，且两条路径共用同一收尾（取消/太短/转码/上传）。
  assert.match(app, /import \{[^}]*createPcmWavRecorder[^}]*\} from '\.\/media-input\.js'/);
  assert.match(app, /const pcm = await createPcmWavRecorder\(stream\)/);
  assert.match(app, /state: "recording",/);
  // getUserMedia 缺失才拒绝；格式探测不再单独拦住录音入口。
  assert.doesNotMatch(app, /!mimeType &{0,2}\s*\|\|\s*!navigator\.mediaDevices/);
  assert.match(app, /if \(!navigator\.mediaDevices\?\.getUserMedia\)/);
});

test('试用会话令牌保存在 localStorage：退出浏览器后邀请码不需重复输入', () => {  assert.match(session, /localStorage\.getItem\(storageKey\)/);
  assert.match(session, /localStorage\.setItem\(storageKey/);
  assert.doesNotMatch(session, /sessionStorage/);
  // 主动退出试用会话仍要能清除凭据。
  assert.match(app, /function logoutTrial\(\)[\s\S]*?clearTrialSession\(\)/);
});
