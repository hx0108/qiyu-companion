'use strict';

const { randomBytes, createHash } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PROTOCOL = 'qiyu-realtime-v1';
const PATH = /^\/api\/v1\/realtime-calls\/(rt_[a-zA-Z0-9-]+)\/audio-socket$/;
const digest = value => createHash('sha256').update(value).digest('hex');

// Audio uploads share one same-origin socket; no per-frame browser RTT and no
// Bearer token or one-use ticket in URLs/access logs. Registry owns authorization.
function attachRealtimeMediaWebSocket(server, { registry, ticketTtlMs = 30_000, maxInflight = 30,
  maxQueuedBytes = 96_000, allowedOrigins = null } = {}) {
  if (!server?.on || !registry?.audio || !registry?.own || !registry?.close) throw new TypeError('Realtime media server and registry required');
  if (!Number.isInteger(ticketTtlMs) || ticketTtlMs < 1 || ticketTtlMs > 30_000 || !Number.isInteger(maxInflight) || maxInflight < 1 || maxInflight > 30 || !Number.isInteger(maxQueuedBytes) || maxQueuedBytes < 6400 || maxQueuedBytes > 96_000) throw new TypeError('Invalid realtime transport limits');
  const tickets = new Map(); const connections = new Set(); let stopped = false;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 6404, perMessageDeflate: false,
    handleProtocols: protocols => protocols.has(PROTOCOL) ? PROTOCOL : false });
  function issue(session) {
    if (stopped || !session || session.closed || registry.own(session.accountId, session.id) !== session) throw new Error('Realtime session unavailable');
    // Reissuing for the same session invalidates the previous ticket.
    for (const [key, value] of tickets) if (value.session === session || value.expiresAt <= Date.now()) { clearTimeout(value.timer); tickets.delete(key); }
    const token = randomBytes(32).toString('base64url'); const key = digest(token);
    const entry = { session, expiresAt: Date.now() + ticketTtlMs };
    entry.timer = setTimeout(() => tickets.delete(key), ticketTtlMs); entry.timer.unref?.(); tickets.set(key, entry);
    return { audio_socket_url: `/api/v1/realtime-calls/${session.id}/audio-socket`, audio_socket_ticket: token,
      audio_socket_protocol: PROTOCOL, audio_socket_ticket_expires_at: new Date(entry.expiresAt).toISOString() };
  }
  function reject(socket, status = 403) {
    socket.end(`HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  function sameOrigin(request) {
    try {
      const origin = new URL(request.headers.origin);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== request.headers.origin || origin.host !== request.headers.host) return false;
      return !allowedOrigins || allowedOrigins.includes(origin.origin);
    } catch { return false; }
  }
  function upgrade(request, socket, head) {
    let url; try { url = new URL(request.url, 'http://internal.invalid'); } catch { return reject(socket); }
    const match = PATH.exec(url.pathname); if (!match) return;
    if (stopped || url.search || !sameOrigin(request)) return reject(socket);
    const protocols = String(request.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim());
    const tokens = protocols.filter(value => /^ticket\.[A-Za-z0-9_-]{43}$/.test(value));
    if (!protocols.includes(PROTOCOL) || tokens.length !== 1 || protocols.length !== 2) return reject(socket);
    const key = digest(tokens[0].slice(7)); const entry = tickets.get(key);
    if (!entry || entry.expiresAt <= Date.now() || entry.session.id !== match[1] || entry.session.closed) return reject(socket);
    try { if (registry.own(entry.session.accountId, match[1]) !== entry.session) return reject(socket, 404); } catch { return reject(socket, 404); }
    // Consume before upgrade. A failed/replayed handshake never opens another stream.
    tickets.delete(key); clearTimeout(entry.timer);
    socket.setNoDelay(true);
    try { wss.handleUpgrade(request, socket, head, ws => accepted(ws, entry.session)); }
    catch { socket.destroy(); registry.close(entry.session, 'REALTIME_MEDIA_HANDSHAKE_FAILED').catch(() => {}); }
  }
  function accepted(ws, session) {
    const connection = { ws, session }; connections.add(connection);
    let closed = false, receiving = session.sequence, inflight = 0, queuedBytes = 0;
    let chain = Promise.resolve();
    const finish = reason => {
      if (closed) return; closed = true; clearInterval(watchdog); connections.delete(connection);
      // Terminate instead of flushing queued media after failure/closure.
      ws.terminate();
      return registry.close(session, reason).catch(() => {});
    };
    const watchdog = setInterval(() => { if (session.closed) finish('REALTIME_MEDIA_SESSION_ENDED'); }, 500); watchdog.unref?.();
    connection.finish = finish;
    ws.on('error', () => finish('REALTIME_MEDIA_SOCKET_FAILED'));
    ws.on('close', () => finish('REALTIME_MEDIA_DISCONNECTED'));
    ws.on('message', (data, isBinary) => {
      if (closed) return;
      if (session.closed || !isBinary || data.length < 6 || data.length > 6404 || data.length % 2 || inflight >= maxInflight || queuedBytes + data.length - 4 > maxQueuedBytes) return finish('REALTIME_MEDIA_FRAME_INVALID');
      const sequence = data.readUInt32BE(0);
      if (sequence !== receiving) return finish('REALTIME_AUDIO_SEQUENCE_INVALID');
      receiving += 1; inflight += 1; queuedBytes += data.length - 4;
      const bytes = Buffer.from(data.subarray(4));
      chain = chain.then(async () => {
        if (closed) return;
        await registry.audio(session, sequence, bytes);
        if (closed) return;
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > maxQueuedBytes) return finish('REALTIME_MEDIA_BACKPRESSURE');
        ws.send(JSON.stringify({ type: 'audio.ack', next_sequence: session.sequence }));
      }).catch(error => finish(error.code || 'REALTIME_MEDIA_PROCESSING_FAILED')).finally(() => { inflight -= 1; queuedBytes -= bytes.length; });
    });
  }
  server.on('upgrade', upgrade);
  // HTTP server.close waits for upgraded sockets on some Node versions; waiting
  // for its 'close' event before terminating media would deadlock shutdown.
  const originalClose = server.close;
  const closeServer = function (...args) { close(); return originalClose.apply(this, args); };
  server.close = closeServer;
  async function close() {
    if (stopped) return; stopped = true; server.off('upgrade', upgrade);
    if (server.close === closeServer) server.close = originalClose;
    for (const entry of tickets.values()) clearTimeout(entry.timer); tickets.clear();
    await Promise.all([...connections].map(connection => connection.finish('REALTIME_MEDIA_SERVER_STOPPED')));
    await new Promise(resolve => wss.close(resolve));
  }
  server.once('close', close);
  return { issue, close };
}

module.exports = { attachRealtimeMediaWebSocket };
