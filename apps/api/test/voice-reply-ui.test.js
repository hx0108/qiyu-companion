const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const webRoot = path.resolve(__dirname, '../../web');
const css = fs.readFileSync(path.join(webRoot, 'prototype-restoration.css'), 'utf8');
const app = fs.readFileSync(path.join(webRoot, 'app.js'), 'utf8');

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
