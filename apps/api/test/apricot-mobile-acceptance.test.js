const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../web');
const css = fs.readFileSync(path.join(root, 'apricot.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
function lastRule(selector) {
  const needle = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = [...css.matchAll(new RegExp(needle + '\\s*\\{([^}]*)\\}', 'g'))];
  assert.ok(rules.length, `missing rule: ${selector}`);
  return rules.at(-1)[1];
}
test('keyboard layout removes the retired 28px developer-banner allowance', () => {
  assert.match(lastRule('body.qy-keyboard-open'), /min-height:\s*var\(--qy-app-height,100dvh\)/);
  assert.match(lastRule('body.qy-keyboard-open .device-shell'), /margin:\s*0 auto/);
});
test('keyboard dock cannot inherit obsolete eight-pixel side gutters and padding', () => {
  const rule = lastRule('body.qy-keyboard-open .qiyu-prototype.apricot-chat .bottom-dock');
  for (const property of ['left', 'right', 'bottom', 'padding']) assert.match(rule, new RegExp(property + ':\\s*0(?:;|$)'));
  assert.match(lastRule('body.qy-keyboard-open .qiyu-prototype.apricot-chat .composer-wrap'), /bottom:\s*6px/);
});
test('composer growth starts at the approved 54px baseline rather than the retired 44px input', () => {
  assert.equal(app.match(/const MESSAGE_INPUT_BASE_HEIGHT_PX = (\d+);/)?.[1], '54');
});
test('short landscape viewports do not activate the fixed 874px desktop preview frame', () => {
  assert.ok(css.includes('@media(min-width:761px) and (min-height:600px)'), 'desktop frame requires adequate vertical space');
  const baseFrame = css.match(/\.device-shell\{([^}]*)\}/)?.[1] ?? '';
  assert.match(baseFrame, /margin:\s*0 auto/);
  assert.match(baseFrame, /border-radius:\s*0(?:;|$)/);
  assert.ok(css.includes('@media(max-height:600px) and (orientation:landscape)'), 'landscape keeps room for message content');
  assert.match(lastRule('.qiyu-prototype.apricot-chat .composer textarea'), /max-height:\s*78px/);
});
test('keyboard geometry uses visible height and excludes a hidden banner; orientation and pinch reset safely', () => {
  const properties = new Map(); const classes = new Map();
  const window = { innerWidth: 375, innerHeight: 812, visualViewport: { height: 812, scale: 1 } };
  const document = { activeElement: { matches: () => true }, documentElement: { style: { setProperty: (k,v) => properties.set(k,v), removeProperty: k => properties.delete(k) } }, querySelector: () => ({ offsetHeight: 0 }), body: { classList: { toggle: (k,v) => classes.set(k,v) } } };
  const code = app.slice(app.indexOf('const KEYBOARD_INSET_THRESHOLD_PX'), app.indexOf('window.addEventListener("resize", syncKeyboardInset)'));
  const context = vm.createContext({ window, document, state: { route: 'home' }, chatFollowBottom: false });
  vm.runInContext(code, context);
  window.visualViewport.height = 482; vm.runInContext('syncKeyboardInset()', context);
  assert.equal(classes.get('qy-keyboard-open'), true); assert.equal(properties.get('--qy-app-height'), '482px');
  window.visualViewport.height = 812; vm.runInContext('syncKeyboardInset()', context);
  assert.equal(classes.get('qy-keyboard-open'), false); assert.equal(properties.has('--qy-app-height'), false);
  window.visualViewport.height = 350; window.visualViewport.scale = 1.5; vm.runInContext('syncKeyboardInset()', context);
  assert.equal(classes.get('qy-keyboard-open'), false);
  window.innerWidth = 812; window.innerHeight = 375; window.visualViewport = { height: 375, scale: 1 }; vm.runInContext('syncKeyboardInset()', context);
  assert.equal(classes.get('qy-keyboard-open'), false);
  window.innerHeight = 824; window.visualViewport.height = 824; vm.runInContext('syncKeyboardInset()', context);
  document.activeElement = { matches: () => false };
  window.innerHeight = 375; window.visualViewport.height = 375; vm.runInContext('syncKeyboardInset()', context);
  assert.equal(classes.get('qy-keyboard-open'), false, 'plain window shrink without an editable focus is not a keyboard');
});
