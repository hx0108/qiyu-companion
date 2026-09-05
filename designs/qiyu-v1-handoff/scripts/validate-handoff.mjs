import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importHtml = fs.readFileSync(path.join(root, 'static', '栖语_V1.2_Figma导入_42Frames_393x852.html'), 'utf8');
const boundaryHtml = fs.readFileSync(path.join(root, 'static', '栖语_V1.2_移动端实现边界.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'static', 'screen-manifest.json'), 'utf8'));
const ids = [...importHtml.matchAll(/data-screen-id="([^"]+)"/g)].map((match) => match[1]);
const missing = manifest.map((item) => item.id).filter((id) => !ids.includes(id));
const extra = ids.filter((id) => !manifest.some((item) => item.id === id));
const frameLines = importHtml.split(/\r?\n/).filter((line) => line.includes('class="figma-frame"'));
const navigationMismatches = manifest.flatMap((item) => {
  const line = frameLines.find((candidate) => candidate.includes(`data-screen-id="${item.id}"`)) || '';
  const navCount = (line.match(/class="bottom-nav figma-component"/g) || []).length;
  const active = line.match(/class="nav-item on" data-tab="([^"]+)"/)?.[1] || null;
  const expected = item.navigation || null;
  if (expected === active && navCount === (expected ? 1 : 0)) return [];
  return [{ id: item.id, expected, active, navCount }];
});

const result = {
  frames: ids.length,
  uniqueIds: new Set(ids).size,
  manifest: manifest.length,
  missing,
  extra,
  scripts: (importHtml.match(/<script/gi) || []).length,
  viewport393x852: (importHtml.match(/data-viewport="393x852"/g) || []).length,
  safeTop59: (importHtml.match(/data-safe-area-top="59"/g) || []).length,
  safeBottom34: (importHtml.match(/data-safe-area-bottom="34"/g) || []).length,
  remoteReferences: (importHtml.match(/https?:\/\//g) || []).length,
  bottomNavigation: (importHtml.match(/class="bottom-nav figma-component"/g) || []).length,
  activeNavigationItems: (importHtml.match(/class="nav-item on" data-tab=/g) || []).length,
  chineseNavigationNames: (importHtml.match(/data-component-name-zh="底部导航｜[^"]+｜激活"/g) || []).length,
  navigationMismatches,
  boundaryCards: (boundaryHtml.match(/<article class="card/g) || []).length,
};

console.log(JSON.stringify(result, null, 2));
if (
  result.frames !== 42 ||
  result.uniqueIds !== 42 ||
  result.manifest !== 42 ||
  result.missing.length ||
  result.extra.length ||
  result.scripts !== 0 ||
  result.viewport393x852 !== 42 ||
  result.safeTop59 !== 42 ||
  result.safeBottom34 !== 42 ||
  result.remoteReferences !== 0 ||
  result.bottomNavigation !== 31 ||
  result.activeNavigationItems !== 31 ||
  result.chineseNavigationNames !== 31 ||
  result.navigationMismatches.length
) process.exitCode = 1;
