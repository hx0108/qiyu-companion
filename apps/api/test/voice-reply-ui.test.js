const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const webRoot = path.resolve(__dirname, '../../web');
const css = fs.readFileSync(path.join(webRoot, 'prototype-restoration.css'), 'utf8');
const app = fs.readFileSync(path.join(webRoot, 'app.js'), 'utf8');
const session = fs.readFileSync(path.join(webRoot, 'encrypted-session.js'), 'utf8');

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  assert.ok(matches.length, `missing CSS rule: ${selector}`);
  return matches.at(-1)[1];
}

test('assistant voice control is a compact edge-docked capsule in the bubble lower-right', () => {
  const message = rule('.qiyu-prototype .message.ai');
  const bubble = rule('.qiyu-prototype .ai .bubble');
  const bubbleWithVoice = rule('.qiyu-prototype .ai .bubble:has(.voice-control-row)');
  const row = rule('.qiyu-prototype .voice-control-row');
  const trigger = rule('.qiyu-prototype .voice-trigger');
  const visual = rule('.qiyu-prototype .voice-trigger-visual');

  assert.match(bubble, /background:\s*#1d1e20/);
  assert.match(bubble, /border:\s*0/);
  assert.doesNotMatch(bubble, /linear-gradient/);
  assert.match(bubble, /border-bottom-left-radius:\s*20px/);
  assert.match(bubble, /position:\s*relative/);
  assert.match(bubble, /overflow:\s*hidden/);
  assert.match(message, /max-width:\s*100%/);
  assert.match(bubbleWithVoice, /padding-right:\s*60px/);
  assert.match(row, /position:\s*absolute/);
  assert.match(row, /right:\s*2px/);
  assert.match(row, /bottom:\s*2px/);
  assert.match(row, /margin:\s*0/);
  assert.match(row, /width:\s*52px/);
  assert.match(row, /min-height:\s*44px/);
  assert.match(row, /padding:\s*0/);
  assert.match(trigger, /width:\s*44px/);
  assert.match(trigger, /height:\s*44px/);
  assert.match(trigger, /border-radius:\s*999px/);
  assert.match(visual, /width:\s*40px/);
  assert.match(visual, /height:\s*24px/);
  assert.match(visual, /border-radius:\s*999px/);
});

test('selected edge dock uses a small recess without creating a bottom row', () => {
  const recess = rule('.qiyu-prototype .voice-control-row::before');
  const trigger = rule('.qiyu-prototype .voice-trigger');
  const visual = rule('.qiyu-prototype .voice-trigger-visual');

  assert.match(recess, /width:\s*58px/);
  assert.match(recess, /height:\s*42px/);
  assert.match(recess, /border-radius:\s*28px 0 18px 28px/);
  assert.match(recess, /z-index:\s*0/);
  assert.match(trigger, /position:\s*relative/);
  assert.match(trigger, /z-index:\s*1/);
  assert.match(visual, /linear-gradient/);
});

test('option 1 keeps the same matte reply surface in night mode', () => {
  const nightBubble = rule('.qiyu-prototype.night .ai .bubble');
  assert.match(nightBubble, /background:\s*#1d1e20/);
});

test('assistant voice control stays inside the message bubble and has no visible label or duration', () => {
  assert.match(app, /<div class="bubble">[\s\S]*\$\{voiceRow\}<\/div><\/article>/);
  assert.doesNotMatch(app, /<span[^>]*>\s*(?:播放|播放语音|AI 生成语音|\d+[″"'])\s*<\/span>/);
  assert.doesNotMatch(app, /class="voice-trigger"[^>]*\stitle=/);
});

test('软键盘弹出时底部导航保持锚在物理屏幕底部，不被顶到键盘上方', () => {
  const nav = rule('.qiyu-prototype .bottom-nav');
  assert.match(nav, /position:\s*absolute/);
  // 键盘压缩布局视口时，JS 写入等量 inset 把导航推回屏幕底部（藏在键盘后）。
  assert.match(nav, /bottom:\s*calc\(0px - var\(--qy-keyboard-inset, 0px\)\)/);
  assert.match(app, /--qy-keyboard-inset/);
  assert.match(app, /KEYBOARD_INSET_THRESHOLD_PX/);
  assert.match(app, /visualViewport\?\.addEventListener\("resize", syncKeyboardInset\)/);
});

test('键盘打开时对话屏按可视视口收缩，输入行贴住键盘顶部不留空档', () => {
  // 部分 WebView 100dvh 滞后：对话屏高度必须由 JS 按实际可视高度重设，
  // 且 body/.device-shell/.app 链路同步收缩，否则文档高出一截被下滚露出空档。
  const screenRule = rule('.qiyu-prototype.app-screen');
  assert.match(screenRule, /height:\s*var\(--qy-app-height, calc\(100dvh - 28px\)\)/);
  assert.match(screenRule, /min-height:\s*var\(--qy-app-height, calc\(100dvh - 28px\)\)/);
  const wrap = rule('body.qy-keyboard-open .qiyu-prototype.app-screen .composer-wrap');
  assert.match(wrap, /bottom:\s*0/);
  const navHidden = rule('body.qy-keyboard-open .qiyu-prototype.app-screen .bottom-nav');
  assert.match(navHidden, /display:\s*none/);
  assert.match(app, /--qy-app-height/);
  assert.match(app, /qy-keyboard-open/);
  const styles = fs.readFileSync(path.join(webRoot, 'styles.css'), 'utf8');
  assert.match(styles, /body\.qy-keyboard-open \.app \{ min-height: var\(--qy-app-height/);
  assert.match(styles, /body\.qy-keyboard-open \.device-shell \{ min-height: calc\(var\(--qy-app-height/);
});

test('人格表单提供角色性别选择，性别值随 persona 提交给服务端驱动男/女声', () => {
  assert.match(app, /name="persona_gender"/);
  assert.match(app, /genderOption\("female", "女性 · 女声"\)/);
  assert.match(app, /genderOption\("male", "男性 · 男声"\)/);
  assert.match(app, /gender:\s*\["male", "female"\]\.includes\(form\.elements\.persona_gender\?\.value\)/);
});

test('试用会话令牌保存在 localStorage：退出浏览器后邀请码不需重复输入', () => {
  assert.match(session, /localStorage\.getItem\(storageKey\)/);
  assert.match(session, /localStorage\.setItem\(storageKey/);
  assert.doesNotMatch(session, /sessionStorage/);
  // 主动退出试用会话仍要能清除凭据。
  assert.match(app, /function logoutTrial\(\)[\s\S]*?clearTrialSession\(\)/);
});
