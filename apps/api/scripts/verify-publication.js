'use strict';

// Read-only release check. Reports paths/rule names, never matched secret values.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
function git(args, encoding = 'utf8', input) {
  const r = spawnSync('git', args, { cwd: root, encoding, input, maxBuffer: 160 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error('Cannot read Git index');
  return r.stdout;
}
const files = git(['-c','core.quotepath=false','diff','--cached','--name-only','--diff-filter=ACMR','-z']).split('\0').filter(Boolean);
assert.ok(files.length, 'No staged files to verify');
// One batch avoids hundreds of expensive Git process launches on Windows.
const batch = git(['cat-file','--batch'], null, files.map(file => ':' + file).join('\n') + '\n');
const blobs = new Map();
let cursor = 0;
for (const file of files) {
  const end = batch.indexOf(10, cursor);
  const header = batch.subarray(cursor, end).toString('utf8').split(' ');
  assert.equal(header[1], 'blob', 'Missing staged blob: ' + file);
  const length = Number(header[2]);
  blobs.set(file, batch.subarray(end + 1, end + 1 + length));
  cursor = end + 2 + length;
}
const indexBytes = file => blobs.get(file) || git(['show', ':' + file], null);
const indexed = new Set(git(['ls-files','-z']).split('\0').filter(Boolean));
const errors = [];
const secrets = [];
for (const file of ['.env', 'deploy/.env', 'infra/postgres/.env']) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) continue;
  for (const line of fs.readFileSync(absolute, 'utf8').split(/\r?\n/)) {
    const item = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!item || !/(?:SECRET|KEY|TOKENS?|PASSWORD|DATABASE_URL)/.test(item[1])) continue;
    const value = item[2].replace(/^['"]|['"]$/g, '');
    if (value.length >= 16 && !/replace|example|your[-_ ]|placeholder/i.test(value)) secrets.push({ name: item[1], value });
  }
}
const currentDocs = new Set(['README.md','DESIGN.md','apps/api/README.md','apps/web/README.md','apps/ops/README.md','deploy/README.md','infra/postgres/README.md','development/CURRENT_PRODUCT_STATUS.md','development/OPERATIONS_RUNBOOK.md','development/eval/github-sync-2026-10-22.md','docs/README.md','docs/qa-state-coverage.md','docs/screenshots/README.md','栖语PRD_v1.3.md','栖语技术设计文档_v1.md','栖语可行性分析_v1.md','栖语陪伴_六项能力实施方案_v1.0.md']);
let links = 0;
for (const file of files) {
  if (/(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.example')) errors.push({ file, rule: 'private-env-file' });
  if (/^(output|tmp|node_modules)\//.test(file) || /\.(zip|dump|bak|log)$/.test(file)) errors.push({ file, rule: 'private-runtime-or-backup' });
  const bytes = indexBytes(file);
  if (bytes.length > 95 * 1024 * 1024) errors.push({ file, rule: 'oversize-git-blob' });
  if (!/\.(?:md|js|cjs|mjs|json|css|html|ya?ml|sql|example)$/.test(file)) continue;
  const text = bytes.toString('utf8');
  for (const secret of secrets) if (text.includes(secret.value)) errors.push({ file, rule: 'local-secret-value', key_name: secret.name });
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) || /\bAKID[A-Za-z0-9]{28,}\b/.test(text) || /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}/.test(text)) errors.push({ file, rule: 'credential-pattern' });
  if (currentDocs.has(file)) {
    // Inline local Markdown links and HTML images; ignore anchors/remote URLs.
    const targets = [...text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map(item => item[1]).concat([...text.matchAll(/<img[^>]+src="([^"]+)"/g)].map(item => item[1]));
    for (let target of targets) {
      if (/^(?:https?:|mailto:|#)/.test(target)) continue;
      target = decodeURIComponent(target.split('#')[0]);
      const relative = path.relative(root, path.resolve(root, path.dirname(file), target)).replace(/\\/g, '/');
      links++;
      if (!indexed.has(relative)) errors.push({ file, rule: 'missing-published-link', target: relative });
    }
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(root,'docs/screenshots/manifest.json'), 'utf8'));
assert.equal(manifest.images.length, 15);
for (const item of manifest.images) {
  const file = 'docs/screenshots/' + item.file;
  if (createHash('sha256').update(indexBytes(file)).digest('hex') !== item.sha256) errors.push({ file, rule: 'screenshot-hash-mismatch' });
}
for (const [file, expected] of Object.entries(manifest.sources)) {
  // Git normalizes CRLF to LF for text; screenshot sources record saved bytes.
  const disk = fs.readFileSync(path.join(root, file));
  if (createHash('sha256').update(disk).digest('hex') !== expected) errors.push({ file, rule: 'screenshot-source-changed' });
}
console.log(JSON.stringify({ staged_files: files.length, local_links_checked: links, screenshots: 15, findings: errors }, null, 2));
if (errors.length) process.exitCode = 1;
