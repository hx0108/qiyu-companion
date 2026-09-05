import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const handoffRoot = path.resolve(here, '..');
const sourceRoot = path.resolve(handoffRoot, '..', 'qiyu-v1-prototype');
const sourceFile = path.join(sourceRoot, '栖语_V1_高保真原型_v1.2.html');
const manifestFile = path.join(handoffRoot, 'static', 'screen-manifest.json');
const outputDir = path.join(handoffRoot, 'prototype');
const outputFile = path.join(outputDir, '栖语_V1_高保真原型_v1.2_交付版.html');
const catalogFile = path.join(outputDir, '独立状态链接目录.html');

const [source, manifestText] = await Promise.all([
  fs.readFile(sourceFile, 'utf8'),
  fs.readFile(manifestFile, 'utf8'),
]);
const manifest = JSON.parse(manifestText);

const annotationCss = `
  body.qiyu-annotate [data-action],body.qiyu-annotate [data-jump],body.qiyu-annotate [data-tab],body.qiyu-annotate [data-open]{outline:1px dashed rgba(189,143,148,.78);outline-offset:2px}
  .qiyu-handoff-badge{position:fixed;z-index:9999;right:18px;top:18px;width:244px;padding:13px 14px;border-radius:16px;background:rgba(31,24,31,.94);color:#f7eef2;box-shadow:0 16px 44px rgba(15,8,14,.28);font:11px/1.55 var(--sans);backdrop-filter:blur(16px)}
  .qiyu-handoff-badge b{display:block;font:500 14px/1.35 var(--serif);margin:4px 0}.qiyu-handoff-badge code{display:block;color:#d5b2bd;font-size:9px;word-break:break-all}.qiyu-handoff-badge button{margin-top:9px;border:1px solid rgba(255,255,255,.2);background:transparent;color:#fff;border-radius:10px;min-height:32px;padding:0 10px;font-size:10px}
  @media(max-width:760px){.qiyu-handoff-badge{right:10px;top:10px;width:190px;padding:10px;font-size:9px;opacity:.9}}
`;

const runtime = `
<script>
(() => {
  const manifest = ${JSON.stringify(manifest)};
  const screenMap = new Map(manifest.map(item => [item.id, item]));
  const params = new URLSearchParams(location.search);
  const requested = params.get('screen');
  const annotate = params.get('annotate') === '1';
  const item = screenMap.get(requested) || screenMap.get('chat-day');

  function applyEntry(entry) {
    state = Object.assign(initial(), entry.patch || {});
    if (!entry.id.startsWith('notice-') && !entry.id.startsWith('age-')) {
      state.ageStatus = 'pass';
    }
    if (entry.navigation) {
      state.created = true;
    }
    if (entry.id === 'contact-saved') state.contactConsent = true;
    render();
    document.title = '栖语 V1.2｜' + entry.title;
  }

  function mountAnnotation(entry, enabled = annotate) {
    document.body.classList.toggle('qiyu-annotate', enabled);
    document.querySelector('.qiyu-handoff-badge')?.remove();
    if (!enabled) return;
    const panel = document.createElement('aside');
    panel.className = 'qiyu-handoff-badge';
    panel.innerHTML = '<span>HANDOFF · ' + entry.group + '</span><b>' + entry.title + '</b><code>?screen=' + entry.id + '&annotate=1</code><button type="button">复制当前链接</button>';
    panel.querySelector('button').addEventListener('click', async () => {
      await navigator.clipboard?.writeText(location.href);
      panel.querySelector('button').textContent = '已复制';
    });
    document.body.appendChild(panel);
  }

  applyEntry(item);
  mountAnnotation(item);
  window.qiyuHandoff = {
    version: '1.2',
    manifest,
    open(id, annotation = annotate) {
      const target = screenMap.get(id);
      if (!target) throw new Error('Unknown screen id: ' + id);
      const url = new URL(location.href);
      url.searchParams.set('screen', id);
      if (annotation) url.searchParams.set('annotate', '1'); else url.searchParams.delete('annotate');
      history.pushState({ screen: id }, '', url);
      applyEntry(target);
      mountAnnotation(target, annotation);
    }
  };
  addEventListener('popstate', () => {
    const target = screenMap.get(new URLSearchParams(location.search).get('screen')) || screenMap.get('chat-day');
    applyEntry(target); mountAnnotation(target);
  });
})();
</script>`;

const output = source
  .replaceAll('公平使用的文字互动', '每天最多100轮文字对话，次日恢复')
  .replace('</style>', `${annotationCss}</style>`)
  .replace('</body>', `${runtime}</body>`)
  .replace('<title>栖语 · 高保真可点击原型</title>', '<title>栖语 V1.2 · UI 与开发交付版</title>');

const grouped = new Map();
for (const item of manifest) {
  if (!grouped.has(item.group)) grouped.set(item.group, []);
  grouped.get(item.group).push(item);
}
const catalog = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>栖语 V1.2 独立状态链接目录</title><style>body{margin:0;background:#eee8e1;color:#2c2028;font:14px/1.6 system-ui;padding:48px}main{max-width:1080px;margin:auto}h1{font-family:Georgia,serif;font-size:36px}section{margin:36px 0}h2{font-size:20px;border-bottom:1px solid #d4c7c2;padding-bottom:10px}.links{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}a{display:flex;justify-content:space-between;gap:18px;text-decoration:none;color:#5b3653;background:#fffaf6;border:1px solid #dfd4cf;border-radius:14px;padding:13px 15px}code{font-size:10px;color:#796d74}@media(max-width:720px){body{padding:24px}.links{grid-template-columns:1fr}}</style></head><body><main><h1>栖语 V1.2 · 独立状态链接</h1><p>每个链接可单独评审。追加 <code>&annotate=1</code> 开启标注模式。</p>${[...grouped].map(([group, items]) => `<section><h2>${group}</h2><div class="links">${items.map(item => `<a href="栖语_V1_高保真原型_v1.2_交付版.html?screen=${item.id}&annotate=1"><span>${item.title}</span><code>${item.id}</code></a>`).join('')}</div></section>`).join('')}</main></body></html>`;

await fs.mkdir(path.join(outputDir, 'imgs'), { recursive: true });
await Promise.all([
  fs.writeFile(outputFile, output, 'utf8'),
  fs.writeFile(catalogFile, catalog, 'utf8'),
  fs.copyFile(path.join(sourceRoot, 'icon.png'), path.join(outputDir, 'icon.png')),
  fs.copyFile(path.join(sourceRoot, 'imgs', 'qiyu-character.png'), path.join(outputDir, 'imgs', 'qiyu-character.png')),
  fs.copyFile(path.join(sourceRoot, 'imgs', 'qiyu-night-scene.png'), path.join(outputDir, 'imgs', 'qiyu-night-scene.png')),
]);

console.log(JSON.stringify({ outputFile, catalogFile, states: manifest.length }, null, 2));
