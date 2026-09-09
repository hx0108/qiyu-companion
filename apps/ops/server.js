'use strict';

const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const port = Number(process.env.QIYU_OPS_PORT || 4311);
const apiBase = new URL(process.env.QIYU_OPS_API_BASE_URL || 'http://127.0.0.1:4310');
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://ops.local');
    if (url.pathname.startsWith('/_api/internal/')) return proxy(req, res, url);
    const asset = assets.get(url.pathname);
    if (!asset || req.method !== 'GET') return reply(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const bytes = await readFile(path.join(__dirname, asset[0]));
    res.writeHead(200, securityHeaders(asset[1]));
    res.end(bytes);
  } catch (error) {
    reply(res, 502, 'Ops console unavailable', 'text/plain; charset=utf-8');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`[ops] development console http://127.0.0.1:${port}; api=${apiBase.origin}`);
});

function proxy(req, res, incoming) {
  const target = new URL(incoming.pathname.replace('/_api', '') + incoming.search, apiBase);
  const headers = { accept: req.headers.accept || 'application/json' };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers['idempotency-key']) headers['idempotency-key'] = req.headers['idempotency-key'];
  const upstream = http.request(target, { method: req.method, headers }, (upstreamResponse) => {
    res.writeHead(upstreamResponse.statusCode || 502, securityHeaders(upstreamResponse.headers['content-type'] || 'application/json; charset=utf-8'));
    upstreamResponse.pipe(res);
  });
  upstream.on('error', () => reply(res, 502, 'API unavailable', 'text/plain; charset=utf-8'));
  req.pipe(upstream);
}

function securityHeaders(contentType) {
  return {
    'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'"
  };
}

function reply(res, status, body, contentType) { res.writeHead(status, securityHeaders(contentType)); res.end(body); }
