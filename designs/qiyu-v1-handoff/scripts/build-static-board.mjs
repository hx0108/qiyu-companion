import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const handoffRoot = path.resolve(here, '..');
const sourceRoot = path.resolve(handoffRoot, '..', 'qiyu-v1-prototype');
const sourceFile = path.join(sourceRoot, '栖语_V1_高保真原型_v1.2.html');
const outputDir = path.join(handoffRoot, 'static');
const outputFile = path.join(outputDir, '栖语_V1.2_全页面静态展开版.html');
const figmaImportFile = path.join(outputDir, '栖语_V1.2_Figma导入_42Frames_393x852.html');

const source = await fs.readFile(sourceFile, 'utf8');
const styleMatch = source.match(/<style>([\s\S]*?)<\/style>/i);
const scriptBlocks = [...source.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);

if (!styleMatch || scriptBlocks.length === 0) {
  throw new Error('Unable to extract CSS or prototype scripts from V1.2 source.');
}

const app = { innerHTML: '' };
const documentStub = {
  querySelector(selector) {
    return selector === '#app' ? app : null;
  },
  querySelectorAll() {
    return [];
  },
  addEventListener() {},
};

const context = {
  console,
  document: documentStub,
  window: {},
  setTimeout() { return 0; },
  clearTimeout() {},
};
context.globalThis = context;
vm.createContext(context);

const exportBridge = `
globalThis.__qiyuStatic = {
  render(renderer, patch) {
    state = Object.assign(initial(), patch || {});
    const renderers = {
      notice, age, contact, create, chat, timeline, relation, profile,
      trial, subscribe, safety: safetyCenter, data: dataCenter,
      receipt: deletionReceipt, version: versionHistory, media: mediaFallback
    };
    if (!renderers[renderer]) throw new Error('Unknown renderer: ' + renderer);
    return renderers[renderer]();
  }
};`;

vm.runInContext(`${scriptBlocks.join('\n')}\n${exportBridge}`, context, {
  filename: 'qiyu-v1.1-runtime.js',
});

const base = {
  created: true,
  screen: 'app',
  tab: 'chat',
  checks: [true, true, true],
};

const frames = [
  { group: '01 年龄与 AI 告知', id: 'notice-default', title: '告知｜未确认', renderer: 'notice', patch: { checks: [false, false, false] } },
  { group: '01 年龄与 AI 告知', id: 'notice-ready', title: '告知｜可继续', renderer: 'notice', patch: { checks: [true, true, true] } },

  { group: '02 年龄增强核验', id: 'age-idle', title: '年龄｜待核验', renderer: 'age', patch: { screen: 'age', ageStatus: 'idle', ageScenario: 'pass' } },
  { group: '02 年龄增强核验', id: 'age-reviewing', title: '年龄｜核验中', renderer: 'age', patch: { screen: 'age', ageStatus: 'reviewing', ageScenario: 'pass' } },
  { group: '02 年龄增强核验', id: 'age-pass', title: '年龄｜PASS', renderer: 'age', patch: { screen: 'age', ageStatus: 'pass', ageScenario: 'pass' } },
  { group: '02 年龄增强核验', id: 'age-review', title: '年龄｜REVIEW', renderer: 'age', patch: { screen: 'age', ageStatus: 'review', ageScenario: 'review' } },
  { group: '02 年龄增强核验', id: 'age-denied', title: '年龄｜DENIED', renderer: 'age', patch: { screen: 'age', ageStatus: 'denied', ageScenario: 'denied' } },
  { group: '02 年龄增强核验', id: 'age-appeal', title: '年龄｜申诉弹窗', renderer: 'age', patch: { screen: 'age', ageStatus: 'denied', ageScenario: 'denied', dialog: 'age-appeal' } },

  { group: '03 紧急联系人', id: 'contact-empty', title: '联系人｜未保存', renderer: 'contact', patch: { screen: 'contact', contactSaved: false } },
  { group: '03 紧急联系人', id: 'contact-saved', title: '联系人｜已保存', renderer: 'contact', patch: { screen: 'contact', contactSaved: true, contactConsent: true } },

  { group: '04 创建角色', id: 'create-default', title: '创建角色｜默认', renderer: 'create', patch: { screen: 'create' } },

  { group: '05 对话与世界状态', id: 'chat-day', title: '对话｜日间', renderer: 'chat', patch: { ...base, night: false, memory: 'pending' } },
  { group: '05 对话与世界状态', id: 'chat-night', title: '对话｜暮色私语', renderer: 'chat', patch: { ...base, night: true, memory: 'confirmed' } },
  { group: '05 对话与世界状态', id: 'chat-image', title: '对话｜情境图已交付', renderer: 'chat', patch: { ...base, night: true, memory: 'confirmed', imageReady: true, imageMode: 'ready' } },
  { group: '05 对话与世界状态', id: 'voice-confirm', title: '语音输入｜确认转写', renderer: 'chat', patch: { ...base, sheet: 'voice', recording: false, voiceError: false } },

  { group: '06 关系记忆', id: 'memory-pending', title: '记忆｜候选确认', renderer: 'chat', patch: { ...base, sheet: 'memory', memory: 'pending' } },
  { group: '06 关系记忆', id: 'memory-confirmed', title: '记忆｜已确认', renderer: 'chat', patch: { ...base, sheet: 'memory', memory: 'confirmed' } },
  { group: '06 关系记忆', id: 'memory-dismissed', title: '记忆｜已忽略可撤销', renderer: 'chat', patch: { ...base, memory: 'dismissed' } },

  { group: '07 关系资产', id: 'timeline-all', title: '时间线｜全部', renderer: 'timeline', patch: { ...base, tab: 'timeline', memory: 'confirmed', timelineFilter: 'all' } },
  { group: '07 关系资产', id: 'timeline-memory-empty', title: '时间线｜记忆空态', renderer: 'timeline', patch: { ...base, tab: 'timeline', memory: 'dismissed', timelineFilter: 'memory' } },
  { group: '07 关系资产', id: 'relation-world', title: '关系｜世界状态', renderer: 'relation', patch: { ...base, tab: 'relation', memory: 'confirmed' } },

  { group: '08 试用与订阅', id: 'trial-active', title: '试用｜进行中', renderer: 'trial', patch: { screen: 'trial', trialState: 'active' } },
  { group: '08 试用与订阅', id: 'trial-ending', title: '试用｜即将到期', renderer: 'trial', patch: { screen: 'trial', trialState: 'ending' } },
  { group: '08 试用与订阅', id: 'trial-expired', title: '试用｜到期降级', renderer: 'trial', patch: { screen: 'trial', trialState: 'expired' } },
  { group: '08 试用与订阅', id: 'subscribe-default', title: '订阅｜¥39 月度方案', renderer: 'subscribe', patch: { screen: 'subscribe', renew: false } },
  { group: '08 试用与订阅', id: 'subscribe-renew', title: '订阅｜明确开启续费', renderer: 'subscribe', patch: { screen: 'subscribe', renew: true } },

  { group: '09 安全与帮助', id: 'safety-center', title: '安全与帮助｜稳定入口', renderer: 'safety', patch: { screen: 'safety' } },
  { group: '09 安全与帮助', id: 'safety-2h', title: '安全｜连续 2 小时提醒', renderer: 'chat', patch: { ...base, dialog: 'safety' } },
  { group: '09 安全与帮助', id: 'safety-r2', title: '安全｜R2 固定响应', renderer: 'safety', patch: { screen: 'safety', dialog: 'r2' } },
  { group: '09 安全与帮助', id: 'safety-report', title: '安全｜举报内容', renderer: 'safety', patch: { screen: 'safety', dialog: 'report' } },
  { group: '09 安全与帮助', id: 'safety-complaint', title: '安全｜服务投诉', renderer: 'safety', patch: { screen: 'safety', dialog: 'complaint' } },

  { group: '10 数据中心', id: 'data-default', title: '数据中心｜默认', renderer: 'data', patch: { screen: 'data', retention: '90' } },
  { group: '10 数据中心', id: 'data-delete-confirm', title: '数据中心｜删除确认', renderer: 'data', patch: { screen: 'data', dialog: 'delete' } },
  { group: '10 数据中心', id: 'delete-processing', title: '删除回执｜处理中', renderer: 'receipt', patch: { screen: 'receipt', deletionJob: { id: 'DEL-0831-019', production: 'processing', created: '2026-08-31 22:18' } } },
  { group: '10 数据中心', id: 'delete-done', title: '删除回执｜已完成', renderer: 'receipt', patch: { screen: 'receipt', deletionJob: { id: 'DEL-0831-019', production: 'done', created: '2026-08-31 22:18' } } },

  { group: '11 人格连续性', id: 'version-history', title: '人格版本｜变更记录', renderer: 'version', patch: { screen: 'version', personaVersion: '1.1' } },
  { group: '11 人格连续性', id: 'version-feedback', title: '人格版本｜异常反馈', renderer: 'version', patch: { screen: 'version', personaVersion: '1.1', dialog: 'version-feedback' } },

  { group: '12 媒体状态', id: 'media-normal', title: '媒体｜正常', renderer: 'media', patch: { screen: 'media', imageMode: 'idle' } },
  { group: '12 媒体状态', id: 'media-image-failed', title: '媒体｜图片失败返额', renderer: 'media', patch: { screen: 'media', imageMode: 'failed' } },
  { group: '12 媒体状态', id: 'media-quota', title: '媒体｜图片额度耗尽', renderer: 'media', patch: { screen: 'media', imageMode: 'quota' } },
  { group: '12 媒体状态', id: 'media-tts-failed', title: '媒体｜TTS 失败降级', renderer: 'media', patch: { screen: 'media', ttsFailed: true } },
  { group: '12 媒体状态', id: 'media-asr-failed', title: '媒体｜ASR 失败降级', renderer: 'media', patch: { screen: 'media', voiceError: true } },
];

const navigationFor = (frame) => {
  if (frame.renderer === 'chat') return 'chat';
  if (frame.renderer === 'timeline') return 'timeline';
  if (frame.renderer === 'relation' || frame.renderer === 'version') return 'relation';
  if (['trial', 'subscribe', 'safety', 'data', 'receipt'].includes(frame.renderer)) return 'profile';
  if (frame.renderer === 'media') return 'chat';
  return null;
};

const navigationLabels = {
  chat: '对话',
  timeline: '时间线',
  relation: '关系',
  profile: '我的',
};

const navMatch = context.__qiyuStatic
  .render('chat', { ...base, night: false, memory: 'pending' })
  .match(/<nav class="bottom-nav"[^>]*>[\s\S]*?<\/nav>/);

if (!navMatch) {
  throw new Error('Unable to extract bottom navigation from the interactive prototype.');
}

const bottomNavigation = (frame) => {
  const active = navigationFor(frame);
  if (!active) return '';
  const componentName = `底部导航｜${navigationLabels[active]}｜激活`;
  return navMatch[0]
    .replace(/class="nav-item(?: on)?\s*"/g, 'class="nav-item"')
    .replace(`class="nav-item" data-tab="${active}"`, `class="nav-item on" data-tab="${active}"`)
    .replace(
      /<nav class="bottom-nav"[^>]*>/,
      `<nav id="Component--bottom-nav-${frame.id}" class="bottom-nav figma-component" data-component-id="bottom-nav-${frame.id}" data-component-name-zh="${componentName}" data-figma-name="${componentName}" aria-label="${componentName}">`,
    );
};

const attachNavigation = (html, frame) => {
  const expected = bottomNavigation(frame);
  const existingPattern = /<nav class="bottom-nav"[^>]*>[\s\S]*?<\/nav>/;
  if (!expected) return html.replace(existingPattern, '');
  if (existingPattern.test(html)) return html.replace(existingPattern, expected);
  return html.replace(/<\/section>\s*$/, `${expected}</section>`);
};

const renderFrame = (frame, nested = false) => attachNavigation(
  staticize(context.__qiyuStatic.render(frame.renderer, frame.patch), nested),
  frame,
);

const groupCounts = new Map();
for (const frame of frames) groupCounts.set(frame.group, (groupCounts.get(frame.group) || 0) + 1);
const staticize = (html, nested = false) => html
  .replace(/\sid="[^"]*"/g, '')
  .replaceAll('src="imgs/', nested ? 'src="../imgs/' : 'src="imgs/');

let lastGroup = '';
const cards = frames.map((frame, index) => {
  const groupHeader = frame.group !== lastGroup
    ? `<header class="board-section" id="group-${frame.group.slice(0, 2)}"><div><span>SECTION ${frame.group.slice(0, 2)}</span><h2>${frame.group.slice(3)}</h2></div><b>${groupCounts.get(frame.group)} STATES</b></header>`
    : '';
  lastGroup = frame.group;
  const html = renderFrame(frame);
  return `${groupHeader}<article class="static-frame" data-screen-id="${frame.id}">
    <div class="frame-label"><div><span>${String(index + 1).padStart(2, '0')}</span><h3>${frame.title}</h3></div><code>?screen=${frame.id}</code></div>
    <div class="phone">${html}</div>
  </article>`;
}).join('\n');

const figmaFrames = frames.map((frame, index) => {
  const html = renderFrame(frame);
  const groupName = frame.group.slice(3);
  const navigation = navigationFor(frame) || 'none';
  return `<section id="Screen--${frame.id}" class="figma-frame" aria-label="${frame.title}" data-screen-name-zh="${frame.title}" data-figma-name="${frame.title}" data-screen-label="${String(index + 1).padStart(2, '0')} · ${frame.title}" data-screen-id="${frame.id}" data-group-id="group-${frame.group.slice(0, 2)}" data-group-name-zh="${groupName}" data-group="${frame.group}" data-navigation="${navigation}" data-viewport="393x852" data-safe-area-top="59" data-safe-area-bottom="34">${html}</section>`;
}).join('\n');

const figmaImportCss = `
  *{animation:none!important;transition:none!important;scroll-behavior:auto!important}
  html,body{margin:0!important;background:#bdb6b1!important;overflow:auto!important;min-width:2838px!important}
  body{padding:80px!important;display:grid!important;grid-template-columns:repeat(6,393px)!important;grid-auto-rows:852px!important;gap:96px 64px!important;align-items:start!important}
  .figma-frame{display:block!important;width:393px!important;height:852px!important;min-width:393px!important;min-height:852px!important;overflow:hidden!important;position:relative!important;background:var(--paper)!important;border:0!important;border-radius:0!important;box-shadow:none!important;isolation:isolate!important}
  .figma-frame>.screen{width:393px!important;height:852px!important;min-height:852px!important;padding-top:59px!important}
  .figma-frame>.screen.app-screen{padding-top:59px!important}
  .figma-frame .content{padding-bottom:136px!important}
  .figma-frame .page-content{padding-bottom:119px!important}
  .figma-frame .bottom-action{padding-bottom:52px!important}
  .figma-frame .bottom-nav{height:98px!important;padding-bottom:34px!important}
  .figma-frame .composer-wrap{bottom:98px!important}
  .figma-frame .sheet{max-height:88%!important;padding-bottom:58px!important}
  .figma-frame button,.figma-frame input,.figma-frame textarea,.figma-frame select{pointer-events:none!important}
`;

const figmaImportOutput = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="design_doc_mode" content="canvas"><title>栖语 V1.2｜Figma 导入 · 42 Frames · 393×852</title><style>${styleMatch[1]}\n${figmaImportCss}</style></head><body>${figmaFrames}</body></html>`;

const boardCss = `
  *{animation:none!important;transition:none!important;scroll-behavior:auto!important}
  html,body{background:#d8d1cb!important;overflow:auto!important;min-width:1320px}
  body{padding:0 0 80px}
  .handoff-head{padding:56px 64px 36px;background:#272128;color:#f8f1eb;display:grid;grid-template-columns:1fr auto;gap:48px;align-items:end}
  .handoff-head .kicker{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#bd8f94}
  .handoff-head h1{font:500 42px/1.18 var(--serif);margin:10px 0 12px;letter-spacing:.04em}
  .handoff-head p{max-width:720px;font-size:13px;line-height:1.75;color:#cbbfc6}
  .handoff-meta{display:grid;grid-template-columns:repeat(3,110px);gap:8px}
  .handoff-meta div{border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:12px}
  .handoff-meta b{font:500 24px var(--serif);display:block}.handoff-meta small{font-size:9px;color:#b5a9b0}
  .board{padding:0 64px;display:grid;grid-template-columns:repeat(3,390px);gap:34px 40px;align-items:start}
  .board-section{grid-column:1/-1;margin:58px 0 0;padding:0 0 16px;border-bottom:1px solid rgba(44,32,40,.18);display:flex;align-items:end;justify-content:space-between}
  .board-section span{font-size:9px;letter-spacing:.16em;color:var(--plum)}
  .board-section h2{font:500 26px/1.2 var(--serif);margin:6px 0 0}
  .board-section b{font-size:10px;letter-spacing:.12em;color:var(--muted)}
  .static-frame{width:390px;display:grid;gap:12px;break-inside:avoid}
  .frame-label{height:48px;display:flex;align-items:end;justify-content:space-between;color:#4c4148}
  .frame-label>div{display:flex;align-items:baseline;gap:9px}.frame-label span{font:500 12px var(--serif);color:var(--rose)}
  .frame-label h3{font:500 15px var(--serif);margin:0}.frame-label code{font:9px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;color:#766a72}
  .static-frame .phone{width:390px!important;height:844px!important;border-radius:44px!important;box-shadow:0 0 0 8px #1e1b1e,0 0 0 10px #595158,0 20px 54px rgba(35,20,30,.2)!important;overflow:hidden!important;position:relative!important}
  .static-frame .screen{height:844px!important;min-height:0!important}
  .static-frame button,.static-frame input,.static-frame textarea,.static-frame select{pointer-events:none}
  @media(max-width:760px){html,body{min-width:1320px!important;background:#d8d1cb!important;overflow:auto!important}.static-frame .phone{width:390px!important;height:844px!important;border-radius:44px!important}.static-frame .screen{height:844px!important;min-height:0!important}}
`;

const output = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>栖语 V1.2｜全部页面与关键状态静态展开版</title>
  <style>${styleMatch[1]}\n${boardCss}</style>
</head>
<body>
  <header class="handoff-head">
    <div><div class="kicker">QIYU V1.2 · UI & DEVELOPMENT HANDOFF</div><h1>全部页面与关键状态</h1><p>以“关系手记”为日间主体，以“暮色私语”为夜间对话与情境图层。每个状态均为独立、无脚本、可被 Figma 捕获的静态 DOM；交互 Demo 由 V1.2 交付版单独保留。</p></div>
    <div class="handoff-meta"><div><b>${frames.length}</b><small>独立状态</small></div><div><b>${groupCounts.size}</b><small>页面分组</small></div><div><b>390</b><small>iPhone 宽度</small></div></div>
  </header>
  <main class="board">${cards}</main>
</body>
</html>`;

await fs.mkdir(path.join(outputDir, 'imgs'), { recursive: true });
await fs.writeFile(outputFile, output, 'utf8');
await fs.writeFile(figmaImportFile, figmaImportOutput, 'utf8');
await fs.mkdir(path.join(outputDir, 'groups'), { recursive: true });

const groupedFrames = new Map();
for (const frame of frames) {
  if (!groupedFrames.has(frame.group)) groupedFrames.set(frame.group, []);
  groupedFrames.get(frame.group).push(frame);
}

for (const [group, entries] of groupedFrames) {
  const sectionNumber = group.slice(0, 2);
  const sectionTitle = group.slice(3);
  const groupCards = entries.map((frame, index) => {
    const html = renderFrame(frame, true);
    return `<article class="static-frame" data-screen-id="${frame.id}">
      <div class="frame-label"><div><span>${String(index + 1).padStart(2, '0')}</span><h3>${frame.title}</h3></div><code>?screen=${frame.id}</code></div>
      <div class="phone">${html}</div>
    </article>`;
  }).join('\n');
  const groupCss = styleMatch[1]
    .replaceAll("url('imgs/", "url('../imgs/")
    .replaceAll("url('icon.png')", "url('../icon.png')");
  const groupOutput = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>栖语 V1.2｜${sectionTitle}</title><style>${groupCss}\n${boardCss}\n.board{grid-template-columns:repeat(${Math.min(entries.length, 3)},390px);justify-content:start}.handoff-head{grid-template-columns:1fr auto}</style></head><body><header class="handoff-head"><div><div class="kicker">QIYU V1.2 · SECTION ${sectionNumber}</div><h1>${sectionTitle}</h1><p>本页仅包含该业务分组的独立静态状态，可直接用于 Figma 捕获、UI 对照与开发状态评审。</p></div><div class="handoff-meta"><div><b>${entries.length}</b><small>独立状态</small></div></div></header><main class="board"><header class="board-section"><div><span>SECTION ${sectionNumber}</span><h2>${sectionTitle}</h2></div><b>${entries.length} STATES</b></header>${groupCards}</main></body></html>`;
  await fs.writeFile(path.join(outputDir, 'groups', `${sectionNumber}-${sectionTitle}.html`), groupOutput, 'utf8');
}

await Promise.all([
  fs.copyFile(path.join(sourceRoot, 'icon.png'), path.join(outputDir, 'icon.png')),
  fs.copyFile(path.join(sourceRoot, 'imgs', 'qiyu-character.png'), path.join(outputDir, 'imgs', 'qiyu-character.png')),
  fs.copyFile(path.join(sourceRoot, 'imgs', 'qiyu-night-scene.png'), path.join(outputDir, 'imgs', 'qiyu-night-scene.png')),
]);

await fs.writeFile(
  path.join(outputDir, 'screen-manifest.json'),
  JSON.stringify(frames.map(({ group, id, title, renderer, patch }) => ({
    group,
    id,
    title,
    renderer,
    navigation: navigationFor({ renderer }),
    patch,
  })), null, 2),
  'utf8'
);

console.log(JSON.stringify({ outputFile, figmaImportFile, frameCount: frames.length, groupCount: groupCounts.size, groupPages: groupedFrames.size }, null, 2));
