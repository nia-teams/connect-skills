import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { LocalMcpContext, LocalMcpServerDeclaration } from './types.js';

export interface LocalMcpStdioConfig {
  type?: 'stdio'; command: string; args?: readonly string[];
  env?: Readonly<Record<string, string>>; cwd?: string; instructions?: string;
}
export interface LocalMcpHttpConfig {
  type: 'http'; url: string | URL; headers?: HeadersInit; instructions?: string;
}
/** Structural subset of MCP Transport. Message schema types belong to the caller's MCP SDK. */
export interface LocalMcpTransport {
  start(): Promise<void>; close(): Promise<void>;
  send(message: any): Promise<void>;
  onmessage?: (message: any) => void; onerror?: (error: Error) => void; onclose?: () => void;
}
export interface LocalMcpConnectable { connect(transport: LocalMcpTransport): Promise<void> }
export type LocalMcpTarget = LocalMcpStdioConfig | LocalMcpHttpConfig | LocalMcpTransport | LocalMcpConnectable;
export type LocalMcpServers = Readonly<Record<string, LocalMcpTarget>>;
export type LocalMcpResolver = (context: LocalMcpContext) => LocalMcpTarget | undefined | Promise<LocalMcpTarget | undefined>;
export interface LocalMcpOptions {
  clientId?: string; mcpServers?: LocalMcpServers; resolveMcp?: LocalMcpResolver;
  /** Time to wait for delivery or a response from an open local MCP session. Default: 600,000 ms. */
  mcpRequestTimeoutMs?: number;
  /** Idle lifetime of config-backed sessions. Default: 600,000 ms; 0 disables reclamation. */
  mcpSessionIdleTimeoutMs?: number;
}

type RpcMessage = Record<string, unknown>;
type RpcId = string | number | null;
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function rpcId(value: unknown): value is RpcId {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}
export function rpcRequest(value: unknown): value is RpcMessage {
  return record(value) && value.jsonrpc === '2.0' && typeof value.method === 'string' &&
    (value.id === undefined || rpcId(value.id));
}
function rpcResponse(value: unknown): value is RpcMessage & { id: RpcId } {
  return record(value) && value.jsonrpc === '2.0' && !Object.hasOwn(value, 'method') && rpcId(value.id) &&
    (Object.hasOwn(value, 'result') !== Object.hasOwn(value, 'error'));
}
export function localMcpClientId(value: string = randomUUID()): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error('Invalid MCP clientId');
  return value;
}
export function mcpServerName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value);
}
export function mcpDeclarations(input: readonly LocalMcpServerDeclaration[]): LocalMcpServerDeclaration[] {
  if (!Array.isArray(input) || input.length > 16) throw new Error('Declare at most 16 local MCP servers');
  const names = new Set<string>();
  return Array.from(input, value => {
    if (!record(value) || !mcpServerName(value.name) || names.has(value.name)) throw new Error('Invalid or duplicate local MCP server name');
    const { name, instructions } = value;
    if (instructions !== undefined && (typeof instructions !== 'string' || instructions.length > 500)) throw new Error('Invalid local MCP instructions');
    names.add(name);
    return { name, ...(instructions !== undefined ? { instructions } : {}) };
  });
}
export function staticDeclarations(servers?: LocalMcpServers): LocalMcpServerDeclaration[] {
  if (servers === undefined) return [];
  if (!record(servers)) throw new Error('Invalid local MCP server map');
  return mcpDeclarations(Object.entries(servers).map(([name, target]) => {
    const kind = targetKind(target);
    if (kind === 'http') httpSettings(target as LocalMcpHttpConfig);
    if (kind === 'stdio') stdioSettings(target as LocalMcpStdioConfig);
    return { name, instructions: kind === 'http' || kind === 'stdio' ? (target as LocalMcpHttpConfig | LocalMcpStdioConfig).instructions : undefined };
  }));
}
function targetKind(target: LocalMcpTarget): 'connect' | 'transport' | 'http' | 'stdio' {
  if (!record(target)) throw new Error('Invalid local MCP target');
  if ('connect' in target && typeof target.connect === 'function') return 'connect';
  if ('start' in target && typeof target.start === 'function' && 'send' in target && typeof target.send === 'function' && 'close' in target && typeof target.close === 'function') return 'transport';
  if ('type' in target && target.type === 'http') return 'http';
  if ((!('type' in target) || target.type === 'stdio' || target.type === undefined) && 'command' in target) return 'stdio';
  throw new Error('Invalid local MCP target');
}
function stdioSettings(config: LocalMcpStdioConfig): void {
  if (typeof config.command !== 'string' || !config.command.trim() || config.command.includes('\0') ||
    (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) ||
    (config.cwd !== undefined && (typeof config.cwd !== 'string' || config.cwd.includes('\0'))) ||
    (config.env !== undefined && (!record(config.env) || Object.entries(config.env).some(([k, v]) => !k || /[=\0]/.test(k) || typeof v !== 'string' || v.includes('\0'))))) {
    throw new Error('Invalid local MCP stdio configuration');
  }
}
function httpSettings(config: LocalMcpHttpConfig): URL {
  let url: URL;
  try { url = new URL(config.url); new Headers(config.headers); }
  catch { throw new Error('Invalid local MCP HTTP configuration'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid local MCP HTTP URL');
  return url;
}

class BridgeTransport implements LocalMcpTransport {
  onmessage?: LocalMcpTransport['onmessage']; onerror?: LocalMcpTransport['onerror']; onclose?: LocalMcpTransport['onclose'];
  private closed = false;
  constructor(private readonly receive: (message: unknown) => void, private readonly onEnd: () => void) {}
  async start(): Promise<void> {
    if (this.closed) {
      this.onclose?.();
      throw new Error('Local MCP bridge is closed');
    }
  }
  async send(message: unknown): Promise<void> { if (!this.closed) this.receive(message); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.onclose?.(); } finally { this.onEnd(); }
  }
}

const stderrLimit = 4096;
class LocalMcpStdioError extends Error {}

class StdioTransport implements LocalMcpTransport {
  onmessage?: LocalMcpTransport['onmessage']; onerror?: LocalMcpTransport['onerror']; onclose?: LocalMcpTransport['onclose'];
  private child?: ChildProcessWithoutNullStreams;
  private exited?: Promise<void>;
  private stderr = Buffer.alloc(0);
  private stopping = false;
  private failure(description: string): Error {
    // Keep the end of stderr, including the final error, under the wire error length.
    const detail = this.stderr.toString('utf8').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
    return new LocalMcpStdioError(detail ? `${description}: ${detail.slice(-(498 - description.length))}` : description);
  }
  constructor(private readonly config: LocalMcpStdioConfig) {}
  async start(): Promise<void> {
    stdioSettings(this.config);
    // Do not inherit Routine credentials or unrelated tokens from the listener.
    const names = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT'];
    const env = Object.fromEntries(names.map(k => [k, process.env[k]]));
    const child = this.child = spawn(this.config.command, [...(this.config.args ?? [])], {
      cwd: this.config.cwd, env: { ...env, ...this.config.env }, shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const tail = chunk.subarray(-stderrLimit);
      const keep = stderrLimit - tail.length;
      this.stderr = Buffer.concat([this.stderr.subarray(Math.max(0, this.stderr.length - keep)), tail]);
    });
    child.stdin.on('error', () => { if (!this.stopping) this.onerror?.(this.failure('Local MCP stdin failed')); });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (!line.trim()) return;
      let message: unknown;
      try { message = JSON.parse(line); }
      catch { this.onerror?.(this.failure('Invalid JSON from local MCP stdout')); return; }
      this.onmessage?.(message);
    });
    lines.on('error', () => this.onerror?.(this.failure('Local MCP stdout failed')));
    this.exited = new Promise(resolve => child.once('close', (code, signal) => {
      lines.close();
      if (!this.stopping && (code !== 0 || signal)) {
        this.onerror?.(this.failure(`Local MCP child process exited (${signal ?? code})`));
      }
      this.onclose?.(); resolve();
    }));
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.on('error', (cause: NodeJS.ErrnoException) => {
        const error = this.failure(`Local MCP child process failed${cause.code ? ` (${cause.code})` : ''}`);
        reject(error); this.onerror?.(error);
      });
    });
  }
  async send(message: unknown): Promise<void> {
    const child = this.child;
    if (!child?.stdin.writable) throw this.failure('Local MCP stdin is closed');
    await new Promise<void>((resolve, reject) => child.stdin.write(JSON.stringify(message) + '\n', error => {
      if (error) reject(this.failure('Local MCP stdin failed')); else resolve();
    }));
  }
  async close(): Promise<void> {
    const child = this.child;
    if (!child || !this.exited) return;
    this.stopping = true;
    child.stdin.end();
    if (await Promise.race([this.exited.then(() => true), delay(250, false, { ref: false })])) return;
    child.kill('SIGTERM');
    if (await Promise.race([this.exited.then(() => true), delay(250, false, { ref: false })])) return;
    child.kill('SIGKILL');
    // Descendants may still hold copies of the stdio pipes.
    child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
    await this.exited;
  }
}

async function readSse(body: ReadableStream<Uint8Array>, match: (value: unknown) => boolean): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', skipLf = false;
  let data: string[] = [];
  try {
    for (;;) {
      const { value: chunk, done } = await reader.read();
      const value = decoder.decode(chunk, { stream: !done });
      if (done && !value.length) return;
      if (skipLf && !value.length) continue;
      buffer += skipLf && value.startsWith('\n') ? value.slice(1) : value;
      skipLf = false;
      let pos = 0;
      for (const delimiter of buffer.matchAll(/\r\n|\r|\n/g)) {
        const line = buffer.slice(pos, delimiter.index);
        pos = delimiter.index + delimiter[0].length;
        if (delimiter[0] === '\r' && pos === buffer.length) skipLf = true;
        if (!line) {
          const event = data.join('\n');
          if (event.trim() && match(JSON.parse(event))) return;
          data = [];
        } else if (line === 'data') data.push('');
        else if (line.startsWith('data:')) data.push(line.slice(line[5] === ' ' ? 6 : 5));
      }
      buffer = buffer.slice(pos);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

class HttpTransport implements LocalMcpTransport {
  onmessage?: LocalMcpTransport['onmessage']; onclose?: LocalMcpTransport['onclose'];
  private readonly abort = new AbortController();
  private readonly endpoint: URL;
  private sessionId?: string;
  private version?: string;
  constructor(private readonly config: LocalMcpHttpConfig) { this.endpoint = httpSettings(config); }
  async start(): Promise<void> {}
  private headers(): Headers {
    const headers = new Headers(this.config.headers);
    headers.delete('Mcp-Session-Id'); headers.delete('MCP-Protocol-Version');
    if (this.sessionId) headers.set('Mcp-Session-Id', this.sessionId);
    if (this.version) headers.set('MCP-Protocol-Version', this.version);
    return headers;
  }
  async send(message: RpcMessage, requestSignal?: AbortSignal): Promise<void> {
    const headers = this.headers();
    headers.set('Content-Type', 'application/json'); headers.set('Accept', 'application/json, text/event-stream');
    const signal = requestSignal ? AbortSignal.any([this.abort.signal, requestSignal]) : this.abort.signal;
    const response = await fetch(this.endpoint, { method: 'POST', headers, body: JSON.stringify(message), redirect: 'error', signal });
    this.sessionId = response.headers.get('Mcp-Session-Id') ?? this.sessionId;
    let found = false;
    const match = (value: unknown): boolean => {
      if (!rpcResponse(value) || value.id !== message.id) return false;
      if (message.method === 'initialize' && record(value.result) && typeof value.result.protocolVersion === 'string') {
        this.version = value.result.protocolVersion;
      }
      found = true;
      this.onmessage?.(value);
      return true;
    };
    try {
      if (!response.ok) throw new Error(`Local MCP HTTP request failed (${response.status})`);
      if (message.id === undefined) return;
      const type = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
      if (type === 'application/json') match(await response.json());
      else if (type === 'text/event-stream' && response.body) await readSse(response.body, match);
      if (!found) throw new Error('Local MCP HTTP response did not contain the requested JSON-RPC response');
    } finally { if (response.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  }
  async close(): Promise<void> {
    this.abort.abort(); this.onclose?.();
    if (!this.sessionId) return;
    try {
      const response = await fetch(this.endpoint, { method: 'DELETE', headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
    } catch { /* Session deletion is best effort. */ }
  }
}

const activeTargets = new WeakSet<object>();
class LocalMcpTimeoutError extends Error {
  constructor(timeoutMs: number) { super(`Local MCP request timed out after ${timeoutMs} ms`); }
}
class LocalMcpSession {
  private readonly pending = new Map<RpcId | symbol, { resolve: (message: RpcMessage) => void; reject: (error: Error) => void }>();
  private readonly transport: LocalMcpTransport;
  private readonly bridge?: BridgeTransport;
  private readonly exclusive: boolean;
  private closing?: Promise<void>;
  private initialization?: { result: unknown };
  private initialized = false;
  readonly reclaimable: boolean;
  closed = false;
  constructor(private readonly target: LocalMcpTarget) {
    const kind = targetKind(target);
    this.exclusive = kind === 'transport' || kind === 'connect';
    this.reclaimable = !this.exclusive;
    if (this.exclusive && activeTargets.has(target)) throw new Error('MCP target already in use; provide a separate instance per topic');
    if (kind === 'connect') this.transport = this.bridge = new BridgeTransport(message => this.receive(message), () => this.end());
    else if (kind === 'stdio') this.transport = new StdioTransport(target as LocalMcpStdioConfig);
    else if (kind === 'http') this.transport = new HttpTransport(target as LocalMcpHttpConfig);
    else this.transport = target as LocalMcpTransport;
    if (this.exclusive) activeTargets.add(target);
  }
  async start(): Promise<void> {
    try {
      if (this.bridge) {
        await (this.target as LocalMcpConnectable).connect(this.bridge);
      } else {
        this.transport.onmessage = message => this.receive(message);
        this.transport.onerror = error => { this.end(error); void this.close().catch(() => {}); };
        this.transport.onclose = () => this.end();
        await this.transport.start();
      }
      if (this.closed) throw new Error('Local MCP target closed during startup');
    } catch (error) { await this.close().catch(() => {}); throw error; }
  }
  private receive(message: unknown): void {
    if (rpcResponse(message)) this.pending.get(message.id)?.resolve(message);
  }
  private end(error = new Error('Local MCP session closed')): void {
    this.closed = true;
    this.initialization = undefined;
    this.initialized = false;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  /** Called under the route's handshake gate; the local peer has one MCP lifecycle. */
  async handshake(message: RpcMessage, timeoutMs: number): Promise<{ response?: RpcMessage; forwarded: boolean }> {
    if (this.closed) throw new Error('Local MCP session is closed');
    const initializing = message.method === 'initialize';
    if (initializing && this.initialization) {
      return { response: { jsonrpc: '2.0', id: message.id, result: this.initialization.result }, forwarded: false };
    }
    if (!initializing && this.initialized) return { forwarded: false };
    const response = await this.dispatch(message, timeoutMs);
    if (initializing && response && Object.hasOwn(response, 'result')) {
      this.initialization = { result: response.result };
      this.initialized = false;
    } else if (!initializing && this.initialization) {
      this.initialized = true;
    }
    return { response, forwarded: true };
  }
  async dispatch(message: RpcMessage, timeoutMs: number): Promise<RpcMessage | undefined> {
    if (this.closed) throw new Error('Local MCP session is closed');
    const id = message.id;
    if (id !== undefined && (!rpcId(id) || this.pending.has(id))) throw new Error('Invalid or duplicate JSON-RPC id');
    const pendingKey = id === undefined ? Symbol() : id;
    const abort = new AbortController();
    const send = async () => {
      if (this.bridge) {
        if (!this.bridge.onmessage) throw new Error('MCP target did not register a message handler');
        this.bridge.onmessage(message);
      } else if (this.transport instanceof HttpTransport) await this.transport.send(message, abort.signal);
      else await this.transport.send(message);
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<RpcMessage | undefined>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new LocalMcpTimeoutError(timeoutMs));
          abort.abort();
        }, timeoutMs);
        this.pending.set(pendingKey, { resolve, reject });
        void send().then(() => { if (id === undefined) resolve(undefined); }, reject);
      });
    } finally {
      clearTimeout(timer);
      this.pending.delete(pendingKey);
    }
  }
  close(): Promise<void> {
    return this.closing ??= Promise.resolve().then(async () => {
      this.end();
      try { await this.transport.close(); }
      finally { if (this.exclusive) activeTargets.delete(this.target); }
    });
  }
}

interface Route {
  session?: LocalMcpSession;
  opening?: Promise<LocalMcpSession | undefined>;
  reclaiming?: Promise<void>;
  idleTimer?: NodeJS.Timeout;
  inFlight: number;
  initialize?: RpcMessage;
  initialized?: RpcMessage;
}

export class LocalMcpDispatch {
  private readonly routes = new Map<string, Route>();
  private readonly requestTimeout: number;
  private readonly idleTimeout: number;
  private closed = false;
  constructor(private readonly options: LocalMcpOptions) {
    this.requestTimeout = options.mcpRequestTimeoutMs ?? 600_000;
    this.idleTimeout = options.mcpSessionIdleTimeoutMs ?? 10 * 60_000;
  }
  async dispatch(context: LocalMcpContext, message: RpcMessage): Promise<{ message?: RpcMessage; error?: { code: 'server_not_found' | 'handler_error'; message: string } }> {
    if (this.closed) return { error: { code: 'handler_error', message: 'Local MCP connection closed' } };
    const key = JSON.stringify([context.topicKey, context.serverName]);
    const route = this.routes.get(key) ?? { inFlight: 0 };
    this.routes.set(key, route);
    clearTimeout(route.idleTimer);
    route.idleTimer = undefined;
    route.inFlight++;
    try {
      const initializing = message.method === 'initialize' && message.id !== undefined;
      const initialized = message.method === 'notifications/initialized' && message.id === undefined;
      let session = route.session;
      let response: RpcMessage | undefined;
      if (initializing || initialized) {
        const ready = route.opening ?? (session && !session.closed
          ? Promise.resolve(session) : this.open(route, context, initializing));
        // Install the gate before awaiting anything so later frames cannot overtake the handshake.
        session = await this.gate(route, ready.then(async target => {
          if (!target) return;
          const result = await target.handshake(message, this.requestTimeout);
          response = result.response;
          if (!result.forwarded || !target.reclaimable) return target;
          if (initializing && response && Object.hasOwn(response, 'result')) {
            route.initialize = message;
            route.initialized = undefined;
          } else if (initialized && route.initialize) {
            route.initialized = message;
          }
          return target;
        }));
      } else {
        if (!route.opening && (!session || session.closed)) this.gate(route, this.open(route, context, false));
        // Another handshake can join the gate while this request is awaiting an opening.
        while (route.opening) session = await route.opening;
        if (session) response = await session.dispatch(message, this.requestTimeout);
      }
      if (!session) return { error: { code: 'server_not_found', message: 'No local MCP server is configured for this topic and name' } };
      return response === undefined ? {} : { message: response };
    } catch (error) {
      const message = error instanceof LocalMcpTimeoutError || error instanceof LocalMcpStdioError ? error.message : 'Local MCP dispatch failed';
      return { error: { code: 'handler_error', message } };
    } finally {
      if (--route.inFlight === 0 && !this.closed) {
        this.deleteEmptyRoute(key, route);
        if (this.idleTimeout && route.session?.reclaimable && !route.session.closed) {
          route.idleTimer = setTimeout(() => this.reclaim(key, route), this.idleTimeout).unref();
        }
      }
    }
  }
  private gate(route: Route, operation: Promise<LocalMcpSession | undefined>): Promise<LocalMcpSession | undefined> {
    const gate = operation.finally(() => { if (route.opening === gate) route.opening = undefined; });
    route.opening = gate;
    return gate;
  }
  private deleteEmptyRoute(key: string, route: Route): void {
    if (!route.inFlight && !route.opening && !route.session && !route.initialize && !route.reclaiming &&
      this.routes.get(key) === route) this.routes.delete(key);
  }
  private reclaim(key: string, route: Route): void {
    route.idleTimer = undefined;
    const session = route.session;
    if (this.closed || route.inFlight || !session) return;
    route.session = undefined;
    route.reclaiming = session.close().catch(() => {}).finally(() => {
      route.reclaiming = undefined;
      this.deleteEmptyRoute(key, route);
    });
  }
  private async open(route: Route, context: LocalMcpContext, initializing: boolean): Promise<LocalMcpSession | undefined> {
    const servers = this.options.mcpServers;
    const target = this.options.resolveMcp ? await this.options.resolveMcp(context) :
      servers && Object.hasOwn(servers, context.serverName) ? servers[context.serverName] : undefined;
    if (!target || this.closed) return;
    await route.reclaiming;
    if (route.session) await route.session.close();
    if (this.closed) return;
    const session = new LocalMcpSession(target);
    route.session = session;
    try {
      await session.start();
      if (this.closed) throw new Error('Local MCP connection closed');
      if (session.reclaimable && !initializing && route.initialize) {
        const { response } = await session.handshake({ ...route.initialize, id: randomUUID() }, this.requestTimeout);
        if (!response || !Object.hasOwn(response, 'result')) throw new Error('Local MCP re-initialization failed');
        if (route.initialized) await session.handshake(route.initialized, this.requestTimeout);
      }
      return session;
    } catch (error) {
      await session.close().catch(() => {});
      if (route.session === session) route.session = undefined;
      throw error;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.routes.values()].map(route => {
      clearTimeout(route.idleTimer);
      return route.session?.close() ?? route.reclaiming;
    }));
    this.routes.clear();
  }
}
