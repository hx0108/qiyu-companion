const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '../../web');
const ui = () => import(`data:text/javascript;base64,${fs.readFileSync(path.join(root, 'apricot-ui.js')).toString('base64')}`);

test('home invitation uses natural height and a compact 20px gap without the removed subtitle space', () => {
  const css = fs.readFileSync(path.join(root, 'apricot.css'), 'utf8');
  const intro = css.match(/\.apricot-intro\{([^}]+)\}/)?.[1];
  const title = css.match(/\.apricot-intro h1\{([^}]+)\}/)?.[1];
  assert.match(intro, /height:auto/);
  assert.match(intro, /padding:3px 0 20px/);
  assert.match(title, /margin:0(?:;|$)/);
});

test('four approved navigation entries preserve real action mappings', async () => {
  const { apricotNav } = await ui();
  const html = apricotNav('home');
  assert.equal((html.match(/class="nav-item/g) || []).length, 4);
  for (const action of ['open-home', 'back-chat', 'open-assets', 'open-profile']) assert.ok(html.includes(`data-action="${action}"`));
  for (const label of ['此刻', '陪伴', '回忆', '我的']) assert.ok(html.includes(label));
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
});

test('homepage escapes service text and never fabricates relationship duration or memories', async () => {
  const { apricotHome } = await ui();
  const html = apricotHome({ name: '<script>x</script>', portrait: '/assets/qiyu-character.png', assets: [], candidates: [], canCall: false });
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(!html.includes('126'));
  assert.ok(!html.includes('那个有阳光的午后'));
  assert.ok(html.includes('disabled aria-label="语音陪伴暂不可用"'));
  assert.ok(html.includes('还没有确认的回忆'));
});

test('profile retains secondary capabilities without removed persona tagline', async () => {
  const { apricotProfile } = await ui();
  const html = apricotProfile({ name: '林默', portrait: '/assets/qiyu-character.png', night: true });
  assert.ok(!html.includes('安静、温柔，有分寸'));
  assert.ok(!html.includes('AI 伙伴 · 人格 v1.4'));
  for (const action of ['open-character-profile', 'open-plans', 'open-proactive', 'open-subscription', 'open-data', 'open-safety']) assert.ok(html.includes(`data-action="${action}"`));
});

test('homepage uses the revised, conversational invitation', async () => {
  const { apricotHome } = await ui();
  const html = apricotHome({ name: '林默', portrait: '/assets/qiyu-character.png', canCall: true });
  assert.ok(html.includes('今天，想和我分享些什么？'));
  assert.ok(!html.includes('今天，想怎么被陪伴？'));
});

test('chat header removes the home back control, retains identity/actions, and exposes the full name', () => {
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const chat = source.slice(source.indexOf('function renderChat()'), source.indexOf('function realtimeCallAvailable()'));
  const header = chat.match(/<header class="app-header">([\s\S]*?)<\/header>/)?.[1];
  assert.ok(header, 'chat header exists');
  assert.ok(header.includes('escapeHtml(characterName)'));
  assert.ok(!header.includes('chat-back') && !header.includes('data-action="open-home"'));
  assert.ok(header.includes('data-action="open-portrait-picker"'));
  assert.ok(header.includes('data-action="start-call"'));
  assert.ok(header.includes('data-action="open-chat-menu"'));
  assert.ok(header.includes('title="${escapeHtml(characterName)}"'));
  assert.ok(!header.includes('AI 伙伴'));
});

test('system toasts sit at the lower-third boundary of the app, centered and clear of bottom navigation', () => {
  const css = fs.readFileSync(path.join(root, 'apricot.css'), 'utf8');
  const rule = css.match(/#app\s*>\s*\.toast\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule, 'shared system toast override exists');
  assert.match(rule, /position:absolute/);
  assert.match(rule, /top:66\.6667%/);
  assert.match(rule, /bottom:auto/);
  assert.match(rule, /left:50%/);
  assert.match(rule, /transform:translate\(-50%,-50%\)/);
  assert.match(rule, /overflow-wrap:anywhere/);
  assert.match(css, /body\.qy-keyboard-open #app > \.toast\{top:auto;bottom:150px;transform:translateX\(-50%\)\}/, 'keyboard toast clears the maximum 132px composer plus bottom gap');
  assert.ok(css.includes('@media(max-height:600px) and (orientation:landscape){#app > .toast{transform:translate(-50%,-100%)}}'), 'short landscape keeps toast above bottom navigation');
});

test('home illustration uses the inspected date-free image and an updated cache version', () => {
  const { createHash } = require('node:crypto');
  const asset = fs.readFileSync(path.join(root, 'assets/apricot-reference.png'));
  assert.equal(asset.readUInt32BE(16), 1536);
  assert.equal(asset.readUInt32BE(20), 1024);
  assert.equal(createHash('sha256').update(asset).digest('hex'), '4fdbcb020859970a6a5416fcdb438dab6ab5fc26db90a36f238f77791995e0d8', 'preserve the visually inspected date-removal result');
  const css = fs.readFileSync(path.join(root, 'apricot.css'), 'utf8');
  const banner = css.match(/\.qiyu-prototype \.apricot-memory-photo\{([^}]+)\}/)?.[1];
  assert.ok(banner.includes('/assets/apricot-reference.png?v=20261020-ui-v23'));
});

test('voice duration is only formatted from finite actual metadata', async () => {
  const { formatVoiceDuration } = await ui();
  assert.equal(formatVoiceDuration(undefined), '');
  assert.equal(formatVoiceDuration(Infinity), '');
  assert.equal(formatVoiceDuration(12.4), '0:12');
  assert.equal(formatVoiceDuration(65), '1:05');
});

test('approved SVG geometry is reused exactly from the confirmed prototype', async () => {
  const { APRICOT_ICONS } = await ui();
  const design = path.resolve(root, '../../designs/qiyu-apricot-gradient');
  const nav = require(path.join(design, 'nav-icons.cjs'));
  const home = require(path.join(design, 'home-icons.cjs'));
  assert.deepEqual(APRICOT_ICONS, { ...nav, ...home });
});

test('inline memory card escapes server text and carries the selected candidate identity', async () => {
  const { apricotCandidate } = await ui();
  assert.equal(apricotCandidate(null), '');
  const card = apricotCandidate({ candidate_id: 'candidate-1', display_text: '<unsafe>' }, true);
  assert.ok(card.includes('&lt;unsafe&gt;'));
  assert.equal((card.match(/data-candidate-id="candidate-1"/g) || []).length, 2);
  assert.ok(card.includes('confirm-inline-candidate'));
  assert.ok(card.includes('reject-inline-candidate'));
  assert.equal((card.match(/ disabled/g) || []).length, 2);
});

test('same-origin server exposes approved presentation assets without opening arbitrary files', async t => {
  const { createApp } = require('../src/app');
  const server = createApp();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [url, type] of [['/apricot.css', 'text/css'], ['/apricot-ui.js', 'javascript'], ['/assets/apricot-reference.png', 'image/png']]) {
    const response = await fetch(origin + url);
    assert.equal(response.status, 200, url);
    assert.ok(response.headers.get('content-type').includes(type));
    assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  assert.equal((await fetch(origin + '/apricot-private-file.txt')).status, 401);
  assert.equal((await fetch(origin + '/apricot-private-file.txt', { headers: { authorization: 'Bearer dev-alice-token' } })).status, 404);
});

test('reply text follows B3 clause rhythm without treating service text as HTML', async () => {
  const { replyTextMarkup } = await ui();
  assert.equal(replyTextMarkup('好，先把今天的忙碌放下来。你已经做得很好了，现在可以好好放松一下。'), '好，先把今天的忙碌放下来。<br>你已经做得很好了，<br>现在可以好好放松一下。');
  assert.equal(replyTextMarkup('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.ok(!replyTextMarkup('我在。').endsWith('<br>'));
  assert.equal(replyTextMarkup('第一句话。\n第二句话。'), '第一句话。<br>第二句话。');
});
