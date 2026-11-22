import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebSocketServer } from 'ws';
import { RoutineWebhookClient, RoutineReplyStream, RoutineClientSupersededError, CredentialStore } from '../dist/index.js';
import { LocalMcpDispatch } from '../dist/local-mcp.js';

const routineId = '65f000000000000000000003';
const groupChatId = '65f000000000000000000004';
const webhookSecret = 'whsec_test_mcp';
const stdioFixture = fileURLToPath(new URL('fixtures/stdio-mcp.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../bin/nia-routine-webhook.mjs', import.meta.url));
const clientOptions = { routineId, webhookSecret };
const accepted = { accepted: true, teamId: 'team', groupChatId, messageId: 'message' };
const version = '2025-11-25';
const supported = { supported: true };
const rpc = (method, id, params) => ({ jsonrpc: '2.0', method, id, params });
const init = rpc('initialize', 1, { protocolVersion: version, capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
const initialized = rpc('notifications/initialized');
const call = (name = 'read') => rpc('tools/call', 2, { name });
const send = (ws, value) => ws.send(JSON.stringify(value));
const json = (res, value, headers = {}) => { res.writeHead(200, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
async function body(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks).toString(); }

async function fixture(t, listener) {
  const server = http.createServer(listener);
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const wss = new WebSocketServer({ server, path: '/ws' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise(resolve => wss.close(resolve)), new Promise(resolve => server.close(resolve))]);
  });
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const auths = [], inbound = new EventEmitter();
  return { serverUrl, auths, inbound,
    handshake(assertAuth = () => {}, accept = true) {
      wss.on('connection', ws => ws.on('message', raw => {
        const frame = JSON.parse(raw);
        if (frame.type === 'routine_auth') {
          auths.push(frame); assertAuth(frame, ws);
          if (accept) send(ws, { type: 'routine_auth_ok', routineId, clientId: frame.clientId, mcp: frame.mcp });
          inbound.emit('auth', ws);
        } else inbound.emit(frame.requestId ?? frame.type, frame);
      }));
    },
    request(ws, message, fields = {}) {
      const requestId = `rmcp_${randomUUID()}`;
      const response = once(inbound, requestId, { signal: AbortSignal.timeout(3500) }).then(([frame]) => {
        assert.equal(frame.type, 'routine_mcp_response'); assert.equal(frame.requestId, requestId); return frame;
      });
      send(ws, { type: 'routine_mcp_request', requestId, routineId, groupChatId,
        topicKey: 'order:1', serverName: 'tools', boundContext: {}, message, ...fields });
      return response;
    },
  };
}
function serve(t, client, options = {}) {
  const stream = client.listen({ onReply() {}, reconnectMinMs: 5, ...options });
  const running = stream.run();
  void running.catch(() => {});
  t.after(() => client.close());
  return { stream, running };
}
function tools(read) {
  const server = new McpServer({ name: 'echo', version: '1' });
  server.registerTool('read', { inputSchema: {} }, async (_args, extra) => ({ content: [{ type: 'text', text: await read(extra) }] }));
  return server;
}

test('legacy and per-invocation declarations; only names and instructions go over signed HTTP', { timeout: 5000 }, async t => {
  const bodies = [];
  const f = await fixture(t, async (req, res) => {
    assert.equal(req.url, `/api/webhook/routine/${routineId}`);
    const raw = await body(req);
    assert.equal(req.headers['x-hub-signature-256'], `sha256=${createHmac('sha256', webhookSecret).update(raw).digest('hex')}`);
    bodies.push(JSON.parse(raw)); json(res, accepted);
  });
  // A client ID alone does not opt the stream or HTTP invocation into MCP.
  const legacy = new RoutineWebhookClient({ ...clientOptions, serverUrl: f.serverUrl, clientId: 'legacy' });
  f.handshake();
  const connected = once(f.inbound, 'auth');
  serve(t, legacy); await connected;
  assert.deepEqual(f.auths[0], { type: 'routine_auth', routineId, secret: webhookSecret, cursor: null });
  const input = { topicKey: 'order:1', message: 'Check inventory' };
  await legacy.send(input);
  const client = new RoutineWebhookClient({ ...clientOptions, serverUrl: f.serverUrl,
    mcpServers: { 'local-tools': { command: 'not-started-by-send', args: ['private'], env: { DEMO: 'private' }, instructions: 'Inventory' } } });
  assert.match(client.clientId, /^[a-f0-9-]{36}$/);
  assert.notEqual(client.clientId, new RoutineWebhookClient({ ...clientOptions, serverUrl: f.serverUrl }).clientId);
  await client.send(input);
  await client.send({ ...input, mcpServers: [{ name: 'other', instructions: 'A local server' }] });
  await client.send({ ...input, mcpServers: [] });
  assert.deepEqual(bodies.map(b => b.source.mcp), [undefined,
    { clientId: client.clientId, servers: [{ name: 'local-tools', instructions: 'Inventory' }] },
    { clientId: client.clientId, servers: [{ name: 'other', instructions: 'A local server' }] }, undefined]);
  assert.ok(!JSON.stringify(bodies).includes('private'));
  for (const declarations of [[{ name: 'bad_name' }], [{ name: 'x'.repeat(65) }], [{ name: 'X', instructions: 'x'.repeat(501) }],
    [{ name: 'X' }, { name: 'X' }], Array.from({ length: 17 }, (_, i) => ({ name: `s-${i}` }))]) {
    await assert.rejects(client.send({ ...input, mcpServers: declarations }), /local MCP/);
  }
  assert.throws(() => new RoutineWebhookClient({ ...clientOptions, clientId: 'bad id' }), /clientId/);
  assert.throws(() => new RoutineWebhookClient({ ...clientOptions, mcpServers: { tools: { type: 'http', url: 'file:///dev/null' } } }), /HTTP URL/);
  assert.equal(bodies.length, 4);
});

test('static in-process McpServer: initialize, notify, list, call, JSON-RPC error, and exclusive mount', { timeout: 6000 }, async t => {
  const f = await fixture(t, async (req, res) => {
    assert.deepEqual(JSON.parse(await body(req)).source.mcp, { clientId: client.clientId, servers: [{ name: 'tools' }] }); json(res, accepted);
  });
  const server = tools(async () => 'stock:3');
  const client = new RoutineWebhookClient({ ...clientOptions, serverUrl: f.serverUrl, mcpServers: { tools: server } });
  f.handshake(frame => assert.deepEqual(frame, { type: 'routine_auth', routineId, secret: webhookSecret, clientId: client.clientId, mcp: supported }));
  const conn = once(f.inbound, 'auth');
  const { running } = serve(t, client);
  const [ws] = await conn;
  await client.send({ topicKey: 'order:1', message: 'Read stock' });
  const { message: initReply } = await f.request(ws, init);
  assert.deepEqual(initReply.result.serverInfo, { name: 'echo', version: '1' });
  assert.equal(initReply.id, 1);
  assert.deepEqual(Object.keys(await f.request(ws, initialized)), ['type', 'requestId']);
  const { message: list } = await f.request(ws, rpc('tools/list', 'list-1'));
  assert.equal(list.result.tools[0].name, 'read');
  const { message: result } = await f.request(ws, call());
  assert.deepEqual(result, { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'stock:3' }] } });
  assert.equal((await f.request(ws, rpc('example/no-such-method', 'x'))).message.error.code, -32601);
  assert.equal((await f.request(ws, init, { topicKey: 'order:2' })).error.code, 'handler_error');
  assert.equal((await f.request(ws, init, { serverName: 'missing' })).error.code, 'server_not_found');
  assert.equal(server.isConnected(), true);
  await client.close(); await running;
  assert.equal(server.isConnected(), false);
  await assert.rejects(client.send({ topicKey: 'order:1', message: 'Read' }), /closed/);
});

test('per-topic resolver isolates in-flight IDs, receives boundContext, and reconnect resets sessions', { timeout: 7500 }, async t => {
  const contexts = [], servers = [], errors = [];
  const f = await fixture(t);
  const clientId = 'workspace:listener.1';
  const client = new RoutineWebhookClient({ ...clientOptions, serverUrl: f.serverUrl, clientId,
    async resolveMcp(ctx) {
      contexts.push(ctx);
      if (ctx.serverName === 'broken') throw Error('do not forward local secrets');
      if (ctx.serverName !== 'tools') return undefined;
      await delay(10);
      const name = ctx.boundContext?.stock;
      const server = tools(async extra => `${ctx.topicKey}:${name}:${extra._meta?.boundContext?.current}`);
      servers.push(server); return server;
    },
  });
  f.handshake(frame => { assert.equal(frame.clientId, clientId); assert.deepEqual(frame.mcp, supported); });
  const conn = once(f.inbound, 'auth');
  serve(t, client, { onError: e => errors.push(e) });
  const [ws] = await conn;
  const first = { topicKey: 'order:1', boundContext: { stock: 'A' } }, second = { topicKey: 'order:2', boundContext: { stock: 'B' } };
  await Promise.all([f.request(ws, init, first), f.request(ws, init, second)]);
  await Promise.all([f.request(ws, initialized, first), f.request(ws, initialized, second)]);
  const message = rpc('tools/call', 2, { name: 'read', _meta: { boundContext: { current: 'new' } } });
  assert.deepEqual(await Promise.all([first, second].map(async fields => (await f.request(ws, message, fields)).message.result.content[0].text)),
    ['order:1:A:new', 'order:2:B:new']);
  assert.deepEqual(contexts, [first, second].map(fields => ({ ...fields, routineId, groupChatId, serverName: 'tools' })));
  const bad = await f.request(ws, init, { serverName: 'broken' });
  assert.equal(bad.error.code, 'handler_error'); assert.doesNotMatch(bad.error.message, /local secrets/);
  const reconnected = once(f.inbound, 'auth');
  ws.terminate();
  const [replacement] = await reconnected;
  assert.ok(servers.every(server => !server.isConnected()));
  assert.equal((await f.request(replacement, init, first)).message.result.serverInfo.name, 'echo');
  assert.equal(servers.length, 3);
  assert.equal(errors.length, 0);
});

test('raw Transport and low-level Server targets', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.handshake();
  const observed = [], states = [];
  const transport = { async start() { states.push('start'); }, async close() { states.push('close'); this.onclose?.(); },
    async send(message) { observed.push(message); if (message.id !== undefined) this.onmessage({ jsonrpc: '2.0', id: message.id, result: { ok: true } }); } };
  const server = new Server({ name: 'low-level', version: '1' });
  const client = new RoutineWebhookClient({ ...clientOptions, serverUrl: f.serverUrl, mcpServers: { tools: transport, 'low-level': server } });
  const conn = once(f.inbound, 'auth'); serve(t, client);
  const [ws] = await conn;
  assert.equal((await f.request(ws, rpc('ping', 'x'))).message.result.ok, true);
  assert.deepEqual(Object.keys(await f.request(ws, initialized)), ['type', 'requestId']);
  assert.equal(observed.length, 2);
  assert.equal((await f.request(ws, init, { serverName: 'low-level' })).message.result.serverInfo.name, 'low-level');
  await client.close(); assert.deepEqual(states, ['start', 'close']);
});

test('stdio process per topic, pending failure, clean close and no implicit secret inheritance', { timeout: 6500 }, async t => {
  const f = await fixture(t); f.handshake();
  const dir = await mkdtemp(join(tmpdir(), 'routine-stdio-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const saved = process.env.NIA_ROUTINE_WEBHOOK_SECRET;
  process.env.NIA_ROUTINE_WEBHOOK_SECRET = webhookSecret;
  t.after(() => { if (saved === undefined) delete process.env.NIA_ROUTINE_WEBHOOK_SECRET; else process.env.NIA_ROUTINE_WEBHOOK_SECRET = saved; });
  const client = new RoutineWebhookClient({ ...clientOptions, serverUrl: f.serverUrl,
    mcpServers: { tools: { command: process.execPath, args: [stdioFixture], cwd: dir, env: { ROUTINE_TEST_MARKER: 'private' } } } });
  const conn = once(f.inbound, 'auth'); serve(t, client);
  const [ws] = await conn;
  const [a, b] = await Promise.all(['order:1', 'order:2'].map(async topicKey => (await f.request(ws, rpc('ping', 1), { topicKey })).message.result));
  assert.notEqual(a.pid, b.pid); assert.equal(a.cwd, dir); assert.equal(a.marker, 'private'); assert.equal(a.leakedSecret, false);
  assert.deepEqual(Object.keys(await f.request(ws, initialized)), ['type', 'requestId']);
  const { error } = await f.request(ws, rpc('fixture/exit', 2));
  assert.equal(error.code, 'handler_error');
  assert.match(error.message, /exited \(2\).*fixture: missing inventory database$/);
  assert.ok(error.message.length <= 500);
  assert.doesNotMatch(error.message, /OLD-DIAGNOSTIC|\n/);
  await client.close();
  for (const { pid } of [a, b]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('idle stdio is reaped after in-flight calls finish and lazily re-initialized on the same socket', { timeout: 6000 }, async t => {
  const f = await fixture(t); f.handshake();
  const client = new RoutineWebhookClient({ ...clientOptions, serverUrl: f.serverUrl, mcpSessionIdleTimeoutMs: 100,
    mcpServers: { tools: { command: process.execPath, args: [stdioFixture] } } });
  const conn = once(f.inbound, 'auth'); serve(t, client);
  const [ws] = await conn;
  const { message: { result: { pid } } } = await f.request(ws, init);
  await f.request(ws, initialized);
  const other = await f.request(ws, { ...init, id: 'other-worker', params: { ...init.params, clientInfo: { name: 'other', version: '1' } } });
  assert.equal(other.message.result.clientName, 'fixture');
  const slow = rpc('tools/call', 5, { name: 'read', args: { delay: 220 } });
  assert.equal((await f.request(ws, slow)).message.result.pid, pid);
  const waitForExit = async pid => {
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); }
      catch (error) { assert.equal(error.code, 'ESRCH'); return; }
      await delay(15);
    }
    assert.fail('Idle stdio process still alive');
  };
  await waitForExit(pid);
  const [first, second] = await Promise.all([f.request(ws, call()), f.request(ws, rpc('tools/call', 3, { name: 'read' }))]);
  assert.notEqual(first.message.result.pid, pid);
  assert.equal(first.message.result.pid, second.message.result.pid);
  assert.equal(first.message.result.clientName, 'fixture');
  const cached = await f.request(ws, { ...init, id: 'worker-2' });
  assert.equal(cached.message.id, 'worker-2');
  assert.equal(cached.message.result.pid, first.message.result.pid);
  await waitForExit(cached.message.result.pid);
  const fresh = await f.request(ws, { ...init, id: 'worker-3', params: { ...init.params, clientInfo: { name: 'fresh', version: '1' } } });
  assert.notEqual(fresh.message.result.pid, cached.message.result.pid);
  assert.equal(fresh.message.result.clientName, 'fresh');
  assert.equal(f.auths.length, 1);
});

test('incoming initialize and initialized gate concurrent calls on new and open routes', { timeout: 5000 }, async t => {
  const events = new EventEmitter();
  const seen = [];
  let releaseInitialize, releaseInitialized;
  const transport = {
    async start() {}, async close() { this.onclose?.(); },
    async send(message) {
      seen.push(message.method);
      if (message.method === 'initialize') {
        await new Promise(resolve => { releaseInitialize = resolve; events.emit('initialize'); });
      } else if (message.method === 'notifications/initialized') {
        await new Promise(resolve => { releaseInitialized = resolve; events.emit('initialized'); });
      }
      if (message.id !== undefined) this.onmessage({ jsonrpc: '2.0', id: message.id, result: {} });
    },
  };
  const dispatcher = new LocalMcpDispatch({ mcpServers: { tools: transport }, mcpRequestTimeoutMs: 1500 });
  t.after(() => dispatcher.close());
  const context = { routineId, groupChatId, topicKey: 'order:1', serverName: 'tools' };
  for (let attempt = 0; attempt < 2; attempt++) {
    // A live route that has opened, but has not initialized yet.
    if (attempt === 1) {
      transport.onclose();
      await dispatcher.dispatch(context, rpc('ping', 3));
      seen.length = 0;
    }
    const initSeen = once(events, 'initialize');
    const notificationSeen = once(events, 'initialized');
    const handshake = dispatcher.dispatch(context, init);
    const notification = dispatcher.dispatch(context, initialized);
    const tool = dispatcher.dispatch(context, call());
    await initSeen;
    await delay(0);
    assert.deepEqual(seen, ['initialize']);
    releaseInitialize();
    await notificationSeen;
    await delay(0);
    assert.deepEqual(seen, ['initialize', 'notifications/initialized']);
    releaseInitialized();
    assert.equal((await handshake).message.id, init.id);
    assert.deepEqual(await notification, {});
    assert.equal((await tool).message.id, 2);
    assert.deepEqual(seen.splice(0), ['initialize', 'notifications/initialized', 'tools/call']);
  }
});

test('Agent and TaskBar clients share a single strict local MCP handshake', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.handshake();
  const seen = [];
  let ready = false;
  const result = { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'strict', version: '1' } };
  const server = {
    async connect(transport) {
      transport.onmessage = async message => {
        seen.push(message.method);
        if (message.method === 'initialize') {
          if (seen.filter(method => method === 'initialize').length > 1) {
            await transport.send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Server already initialized' } });
            return;
          }
          await transport.send({ jsonrpc: '2.0', id: message.id, result });
        } else if (message.method === 'notifications/initialized') ready = true;
        else if (message.method === 'tools/call') {
          assert.equal(ready, true);
          await transport.send({ jsonrpc: '2.0', id: message.id, result: { meta: message.params._meta } });
        }
      };
      await transport.start();
    },
  };
  const client = new RoutineWebhookClient({ ...clientOptions, serverUrl: f.serverUrl, mcpServers: { tools: server } });
  const conn = once(f.inbound, 'auth');
  serve(t, client);
  const [ws] = await conn;
  for (const [id, name] of [['agent-init', 'agent'], ['taskbar-init', 'taskbar-service']]) {
    const reply = await f.request(ws, { ...init, id, params: { ...init.params, clientInfo: { name, version: '1' } } });
    assert.deepEqual(reply.message, { jsonrpc: '2.0', id, result });
    const ack = await f.request(ws, initialized);
    assert.deepEqual(Object.keys(ack), ['type', 'requestId']);
    const meta = { boundContext: { order: 42 }, niaTopicKey: 'order:1', niaRoutineId: routineId,
      niaGroupChatId: groupChatId, progressToken: 13,
      ...(name === 'taskbar-service' ? { 'nia/confirmation': { confirmed: true } } : {}) };
    const tool = await f.request(ws, rpc('tools/call', name, { name: 'read', _meta: meta }));
    assert.deepEqual(tool.message.result.meta, meta);
  }
  assert.deepEqual(seen, ['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
});

test('premature MCP initialized notifications do not mark the handshake complete', async t => {
  let notifications = 0;
  const transport = {
    async start() {}, async close() { this.onclose?.(); },
    async send(message) {
      if (message.method === 'notifications/initialized') notifications++;
      else this.onmessage({ jsonrpc: '2.0', id: message.id, result: {} });
    },
  };
  const dispatcher = new LocalMcpDispatch({ mcpServers: { tools: transport } });
  t.after(() => dispatcher.close());
  const context = { routineId, groupChatId, topicKey: 'order:1', serverName: 'tools' };
  await dispatcher.dispatch(context, initialized);
  await dispatcher.dispatch(context, initialized);
  assert.equal(notifications, 2);
  await dispatcher.dispatch(context, init);
  await dispatcher.dispatch(context, initialized);
  await dispatcher.dispatch(context, initialized);
  assert.equal(notifications, 3);
});

test('local MCP timeout returns handler_error and removes the pending JSON-RPC ID', { timeout: 5000 }, async t => {
  const transport = {
    async start() {}, async close() { this.onclose?.(); },
    async send(message) {
      if (message.method === 'ping') {
        this.onmessage({ jsonrpc: '2.0', id: message.id, result: { ok: true } });
      }
    },
  };
  const timer = t.mock.method(globalThis, 'setTimeout');
  const defaultDispatcher = new LocalMcpDispatch({ mcpServers: { tools: transport } });
  const defaultContext = { routineId, groupChatId, topicKey: 'order:1', serverName: 'tools' };
  await defaultDispatcher.dispatch(defaultContext, rpc('ping', 7));
  assert.ok(timer.mock.calls.some(({ arguments: [, ms] }) => ms === 600_000));
  await defaultDispatcher.close();
  timer.mock.restore();
  const dispatcher = new LocalMcpDispatch({ mcpServers: { tools: transport }, mcpRequestTimeoutMs: 25 });
  t.after(() => dispatcher.close());
  const context = { routineId, groupChatId, topicKey: 'order:1', serverName: 'tools' };
  assert.deepEqual(await dispatcher.dispatch(context, rpc('fixture/hang', 7)), {
    error: { code: 'handler_error', message: 'Local MCP request timed out after 25 ms' },
  });
  assert.deepEqual(await dispatcher.dispatch(context, rpc('ping', 7)), {
    message: { jsonrpc: '2.0', id: 7, result: { ok: true } },
  });
});

test('Streamable HTTP forwards POST responses, negotiates sessions, parses chunked SSE and closes', { timeout: 6500 }, async t => {
  const observed = [];
  const local = await fixture(t, async (req, res) => {
    const raw = await body(req), msg = raw ? JSON.parse(raw) : undefined;
    observed.push({ method: req.method, msg, headers: req.headers, url: req.url });
    assert.equal(req.headers.authorization, 'Bearer local-token');
    assert.equal(req.url, '/mcp?inventory=true');
    if (req.method === 'DELETE' || msg.id === undefined) {
      res.writeHead(202, req.method === 'POST' ? { 'Mcp-Session-Id': 'rotated-session' } : {});
      res.end(); return;
    }
    assert.equal(req.headers.accept, 'application/json, text/event-stream');
    if (msg.method === 'initialize') return json(res, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: version } }, { 'Mcp-Session-Id': 'topic-session' });
    if (msg.method === 'example/redirect') { res.writeHead(307, { Location: '/secret' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.write(': keepalive\r\nid: 1\r\ndata: \r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\n');
    res.write(`data: {"jsonrpc":"2.0","id":${JSON.stringify(msg.id)},\r`);
    await delay(5);
    res.write('\ndata: "result":{"stock":3}}\r\n\r\n'); // Leave the stream open.
  });
  const f = await fixture(t); f.handshake();
  const client = new RoutineWebhookClient({ ...clientOptions, serverUrl: f.serverUrl,
    mcpServers: { tools: { type: 'http', url: `${local.serverUrl}/mcp?inventory=true`, headers: { Authorization: 'Bearer local-token' } } } });
  const conn = once(f.inbound, 'auth'); serve(t, client);
  const [ws] = await conn;
  assert.equal((await f.request(ws, init)).message.result.protocolVersion, version);
  assert.deepEqual(Object.keys(await f.request(ws, initialized)), ['type', 'requestId']);
  assert.deepEqual((await f.request(ws, call())).message.result, { stock: 3 });
  assert.equal((await f.request(ws, rpc('example/redirect', 9))).error.code, 'handler_error');
  await client.close();
  assert.equal(observed[0].headers['mcp-session-id'], undefined);
  assert.equal(observed.length, 5);
  assert.equal(observed[1].headers['mcp-session-id'], 'topic-session');
  assert.ok(observed.slice(2).every(frame => frame.headers['mcp-session-id'] === 'rotated-session'));
  for (const frame of observed.slice(1)) {
    assert.equal(frame.headers['mcp-protocol-version'], version);
  }
  assert.equal(observed.at(-1).method, 'DELETE');
});

test('unauthenticated MCP frames fail closed, and a superseded client does not take the ID back', { timeout: 5000 }, async t => {
  const invalid = await fixture(t);
  invalid.handshake((_, ws) => send(ws, { type: 'routine_mcp_request', requestId: `rmcp_${randomUUID()}`, routineId,
    groupChatId, topicKey: 'order:1', serverName: 'tools', message: init }), false);
  let error, called = false;
  const stream = new RoutineReplyStream({ ...clientOptions, serverUrl: invalid.serverUrl, resolveMcp() { called = true; },
    onReply() {}, onError(e) { error = e; stream.stop(); } });
  await stream.run();
  assert.match(error.message, /Invalid Routine MCP request/); assert.equal(called, false);
  const superseded = await fixture(t);
  superseded.handshake((_, ws) => ws.close(4409, 'superseded'), false);
  const client = new RoutineWebhookClient({ ...clientOptions, serverUrl: superseded.serverUrl, clientId: 'stable', resolveMcp() {} });
  const { running } = serve(t, client);
  await assert.rejects(running, RoutineClientSupersededError);
  assert.equal(superseded.auths.length, 1);
});

test('CLI merges local MCP flags/config, pairs send with listen, and reaps child on signals', { timeout: 8000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'routine-mcp-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'mcp.json');
  await writeFile(config, JSON.stringify({ mcpServers: {
    tools: { command: process.execPath, args: [stdioFixture], env: { ROUTINE_TEST_STUBBORN: '1' }, instructions: 'Read inventory' },
  } }));
  let invocation;
  const f = await fixture(t, async (req, res) => { invocation = JSON.parse(await body(req)); json(res, accepted); });
  f.handshake(frame => { assert.equal(frame.clientId, 'local:cli'); assert.deepEqual(frame.mcp, supported); });
  const env = { ...process.env, NIA_ROUTINE_ID: routineId, NIA_ROUTINE_WEBHOOK_SECRET: webhookSecret, NIA_TEAMS_URL: f.serverUrl };
  const mcpArgs = ['--mcp-config', config, '--mcp', 'stdio-extra=node', '--mcp-url', 'http-extra=http://127.0.0.1:1/mcp'];
  const common = ['--client-id', 'local:cli', ...mcpArgs];
  const invoke = (command, ...args) => spawn(process.execPath, [cli, command, ...args], { env, stdio: ['ignore','pipe','pipe'] });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const conn = once(f.inbound, 'auth');
    const listen = invoke('listen', ...common);
    t.after(() => { listen.kill('SIGKILL'); });
    const exit = once(listen, 'close');
    let logs = ''; listen.stderr.on('data', chunk => { logs += chunk; });
    const [ws] = await conn;
    const sendProcess = invoke('send', ...common, '--message', 'Read inventory', '--topic-key', 'order:1');
    const [code] = await once(sendProcess, 'close'); assert.equal(code, 0);
    assert.deepEqual(invocation.source.mcp, { clientId: 'local:cli', servers: [
      { name: 'tools', instructions: 'Read inventory' }, { name: 'stdio-extra' }, { name: 'http-extra' },
    ] });
    const { message: { result: { pid, leakedSecret } } } = await f.request(ws, rpc('ping', 1));
    assert.equal(leakedSecret, false);
    listen.kill(signal);
    assert.deepEqual(await exit, [0, null], logs);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
  const bad = invoke('send', ...mcpArgs, '--message', 'Read inventory', '--topic-key', 'order:1');
  const [code] = await once(bad, 'close'); assert.equal(code, 1);
});


test('MCP frames are dispatched while a reply handler is waiting; only replies commit cursors', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.handshake();
  const client = new RoutineWebhookClient({ ...clientOptions, serverUrl: f.serverUrl, mcpServers: { tools: tools(() => '3') } });
  let release, entered;
  const handler = new Promise(resolve => { release = resolve; });
  t.after(release);
  const waitForHandler = new Promise(resolve => { entered = resolve; });
  const persisted = [];
  const conn = once(f.inbound, 'auth');
  serve(t, client, { onReply: () => { entered(); return handler; }, persistCursor: cursor => { persisted.push(cursor); } });
  const [ws] = await conn;
  send(ws, { type: 'routine.reply', routineId, topicKey: 'order:1', eventId: 'event',
    createdAt: new Date().toISOString(), content: 'Done', cursor: 'cursor1' });
  await waitForHandler;
  assert.equal((await f.request(ws, init)).message.result.serverInfo.name, 'echo');
  assert.deepEqual(persisted, []);
  const ack = once(f.inbound, 'routine_cursor'); release();
  assert.deepEqual(await ack, [{ type: 'routine_cursor', cursor: 'cursor1' }]);
  assert.deepEqual(persisted, ['cursor1']);
});

for (const useStatic of [false, true]) {
  test(`bundled local MCP example executes with ${useStatic ? 'static mount' : 'resolver'}`, { timeout: 6000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'routine-mcp-example-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const invocations = new EventEmitter();
    const f = await fixture(t, async (req, res) => {
      const invocation = JSON.parse(await body(req));
      json(res, accepted); invocations.emit('invoke', invocation);
    });
    f.handshake();
    await new CredentialStore(dir).save({ ...clientOptions, serverUrl: f.serverUrl, teamId: 'team',
      webhookUrl: `${f.serverUrl}/api/webhook/routine/${routineId}`, cursor: null });
    const conn = once(f.inbound, 'auth');
    const invoke = once(invocations, 'invoke');
    const child = spawn(process.execPath, ['--import', 'tsx', 'examples/local-mcp.ts', ...(useStatic ? ['--static'] : [])], {
      cwd: new URL('../', import.meta.url), env: { ...process.env, NIA_ROUTINE_WEBHOOK_CONFIG_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => child.kill('SIGKILL'));
    const exit = once(child, 'close');
    const [ws] = await conn;
    const [invocation] = await invoke;
    assert.deepEqual(invocation.source.mcp, { clientId: f.auths[0].clientId, servers: [{ name: 'inventory' }] });
    const fields = { topicKey: invocation.source.topicKey, serverName: 'inventory' };
    assert.ok((await f.request(ws, init, fields)).message.result);
    await f.request(ws, initialized, fields);
    assert.equal((await f.request(ws, call('get_stock'), fields)).message.result.content[0].text, '3');
    child.kill('SIGTERM');
    assert.deepEqual(await exit, [0, null]);
  });
}
