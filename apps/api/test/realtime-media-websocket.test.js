'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { attachRealtimeMediaWebSocket } = require('../src/domain/realtime-media-websocket');

async function fixture(t, options = {}) {
  const calls = [], closes = []; const sessions = new Map();
  let resolveSettled; const settled = new Promise(resolve => { resolveSettled = resolve; });
  const registry = { own(account, id) { const session = sessions.get(id); if (!session || session.accountId !== account) throw new Error('not owned'); return session; },
    async audio(session, sequence, bytes) {
      if (options.wait) await options.wait();
      if (session.closed) throw Object.assign(new Error('closed'), { code: 'CLOSED' });
      if (options.revoke) throw Object.assign(new Error('revoked'), { code: 'ACCESS_REVOKED' });
      assert.equal(sequence, session.sequence); session.sequence++; calls.push({ sequence, bytes: Buffer.from(bytes) });
    }, async close(session, reason) { if (session.closed) return; session.closed = true; closes.push(reason); resolveSettled(); } };
  const server = http.createServer(); const transport = attachRealtimeMediaWebSocket(server, { registry, ...(options.transport || {}) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await transport.close(); await new Promise(resolve => server.close(resolve)); });
  const session = { id: 'rt_local-test', accountId: 'alice', closed: false, sequence: 0 }; sessions.set(session.id, session);
  const issue = () => transport.issue(session);
  const socket = (ticket, overrides = {}) => {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + ticket.audio_socket_url, [ticket.audio_socket_protocol, `ticket.${ticket.audio_socket_ticket}`], { headers: { Origin: origin, ...(overrides.headers || {}) } });
    ws.on('error', () => {}); return ws;
  };
  return { registry, session, calls, closes, transport, server, origin, issue, socket, settled };
}
function frame(sequence, bytes = Buffer.alloc(3200)) { const header = Buffer.alloc(4); header.writeUInt32BE(sequence); return Buffer.concat([header, bytes]); }
async function opened(ws) { await once(ws, 'open'); return ws; }
async function denied(ws) { const [error] = await once(ws, 'error'); assert.match(error.message, /403|404/); }
async function closed(ws) { if (ws.readyState === WebSocket.CLOSED) return; await once(ws, 'close'); }

test('localhost socket consumes short-lived ticket and uploads sequenced PCM without per-frame HTTP roundtrip', async t => {
  const f = await fixture(t); const ticket = f.issue(); assert.equal(ticket.audio_socket_url.includes(ticket.audio_socket_ticket), false);
  const ws = await opened(f.socket(ticket)); assert.equal(ws.protocol, 'qiyu-realtime-v1');
  const ack = once(ws, 'message'); ws.send(frame(0)); assert.equal(JSON.parse((await ack)[0]).next_sequence, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].bytes.length, 3200);
  await denied(f.socket(ticket)); // replay does not steal or close the real connection
  assert.equal(f.session.closed, false);
  const end = closed(ws); ws.close(); await end; await f.settled; assert.equal(f.closes[0], 'REALTIME_MEDIA_DISCONNECTED');
});
test('cross-origin, wrong session and expired tickets never open or send PCM', async t => {
  const f = await fixture(t, { transport: { ticketTtlMs: 20 } }); let ticket = f.issue();
  await denied(f.socket(ticket, { headers: { Origin: 'https://elsewhere.invalid' } }));
  await denied(f.socket({ ...ticket, audio_socket_url: ticket.audio_socket_url.replace('rt_local-test', 'rt_other-user') }));
  await new Promise(resolve => setTimeout(resolve, 30)); await denied(f.socket(ticket));
  assert.equal(f.calls.length, 0); assert.equal(f.session.closed, false);
});
test('invalid sequence and nonbinary frames close and settle the controlled session', async t => {
  for (const value of [frame(1), 'not audio']) {
    const f = await fixture(t); const ws = await opened(f.socket(f.issue())); const end = closed(ws); ws.send(value); await end;
    assert.equal(f.calls.length, 0); assert.equal(f.closes.length, 1);
  }
});
test('bounded inflight queue closes on overload and never forwards queued PCM after close', async t => {
  let release; const wait = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { wait: () => wait, transport: { maxInflight: 2 } });
  const ws = await opened(f.socket(f.issue())); const end = closed(ws);
  ws.send(frame(0)); ws.send(frame(1)); ws.send(frame(2)); await end; release();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 0); assert.equal(f.closes.length, 1);
});
test('per-frame authorization rejection closes socket without provider delivery', async t => {
  const f = await fixture(t, { revoke: true }); const ws = await opened(f.socket(f.issue())); const end = closed(ws); ws.send(frame(0)); await end;
  assert.equal(f.calls.length, 0); assert.deepEqual(f.closes, ['ACCESS_REVOKED']);
});
test('server transport stop closes live socket and settles once', async t => {
  const f = await fixture(t); const ws = await opened(f.socket(f.issue())); const end = closed(ws); await f.transport.close(); await end;
  assert.deepEqual(f.closes, ['REALTIME_MEDIA_SERVER_STOPPED']);
});

test('multiple PCM frames can be sent without awaiting an acknowledgement and remain ordered', async t => {
  const f = await fixture(t, { wait: () => new Promise(resolve => setTimeout(resolve, 15)) });
  const ws = await opened(f.socket(f.issue()));
  const acknowledgements = [];
  const all = new Promise(resolve => ws.on('message', data => {
    acknowledgements.push(JSON.parse(data).next_sequence);
    if (acknowledgements.length === 3) resolve();
  }));
  ws.send(frame(0)); ws.send(frame(1)); ws.send(frame(2)); await all;
  assert.deepEqual(acknowledgements, [1, 2, 3]); assert.deepEqual(f.calls.map(call => call.sequence), [0, 1, 2]);
});

test('HTTP server close event also closes media socket and settles its reservation', async t => {
  const f = await fixture(t); const ws = await opened(f.socket(f.issue())); const end = closed(ws);
  await new Promise(resolve => f.server.close(resolve)); await end; await f.settled;
  assert.deepEqual(f.closes, ['REALTIME_MEDIA_SERVER_STOPPED']);
});


test('two seconds of queued PCM survives a slow authorization/provider send without the former ten-frame disconnect', async t => {
  let release; const blocked = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { wait: () => blocked });
  const ws = await opened(f.socket(f.issue()));
  const acks = []; const all = new Promise(resolve => ws.on('message', data => { acks.push(JSON.parse(data).next_sequence); if (acks.length === 20) resolve(); }));
  for (let index = 0; index < 20; index++) ws.send(frame(index));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.session.closed, false); assert.equal(f.calls.length, 0);
  release(); await all;
  assert.deepEqual(acks, Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(f.closes.length, 0);
});
