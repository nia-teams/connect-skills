import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { serverOrigin, topicKey } from './http.js';
import { validateReply } from './callback.js';
import type { RoutineReply } from './types.js';
import { LocalMcpDispatch, localMcpClientId, mcpServerName, record, rpcRequest, staticDeclarations, type LocalMcpOptions } from './local-mcp.js';
export interface ReplyStreamOptions extends LocalMcpOptions {
  serverUrl: string; routineId: string; webhookSecret: string; initialCursor?: string | null;
  onReply: (reply: RoutineReply) => void | Promise<void>;
  persistCursor?: (cursor: string) => void | Promise<void>;
  seenEventIds?: Set<string>; maxSeenEvents?: number;
  /** Called after local cursor commit and best-effort live-socket acknowledgment. */
  onProcessed?: (reply: RoutineReply) => void;
  /** Explicit recovery choice: return a cursor (or null to restart); omission stops the stream. */
  onCursorExpired?: (earliestCursor: string) => string | null | Promise<string | null>;
  onError?: (error: Error) => void; reconnectMinMs?: number; reconnectMaxMs?: number;
  heartbeatMs?: number; authTimeoutMs?: number;
  /** Called after authentication (again after each successful reconnect). */
  onReady?: () => void;
}
/** At-least-once delivery. Handler side effects should be idempotent by eventId. */
export class RoutineReplyStream {
  private socket?: WebSocket;
  private closeTimer?: NodeJS.Timeout;
  private readonly abort = new AbortController();
  private done?: Promise<void>;
  private readonly mcpClientId?: string;
  private cursor: string | null;
  private readonly seen: Set<string>;
  constructor(private readonly options: ReplyStreamOptions, private readonly onDone?: () => void) {
    serverOrigin(options.serverUrl);
    if (!options.webhookSecret) throw new Error('WSS requires a Routine secret');
    for (const key of ['maxSeenEvents', 'reconnectMinMs', 'reconnectMaxMs', 'heartbeatMs', 'authTimeoutMs', 'mcpRequestTimeoutMs', 'mcpSessionIdleTimeoutMs'] as const) {
      const value = options[key];
      if (value !== undefined && (!Number.isInteger(value) || value < (key === 'mcpSessionIdleTimeoutMs' ? 0 : 1) || value > 2_147_483_647)) throw new Error(`Invalid ${key}`);
    }
    const id = localMcpClientId(options.clientId);
    if (options.resolveMcp !== undefined && typeof options.resolveMcp !== 'function') throw new Error('Invalid resolveMcp');
    if (staticDeclarations(options.mcpServers).length || options.resolveMcp) this.mcpClientId = id;
    this.cursor = options.initialCursor ?? null; this.seen = options.seenEventIds ?? new Set();
  }
  stop(): void {
    this.abort.abort();
    if (this.socket) this.closeSocket(this.socket);
  }
  private closeSocket(ws: WebSocket): void {
    if (ws.readyState === WebSocket.CLOSED) return;
    if (ws.readyState === WebSocket.CONNECTING) { ws.terminate(); return; }
    ws.close();
    // A peer may never answer the close frame. Bound graceful shutdown locally.
    this.closeTimer ??= setTimeout(() => ws.terminate(), 500).unref();
  }
  async close(): Promise<void> {
    this.stop();
    await this.done;
  }
  async run(): Promise<void> {
    if (this.done) throw new Error('Stream already started');
    this.done = this.runLoop().finally(this.onDone);
    await this.done;
  }
  private async runLoop(): Promise<void> {
    let attempt = 0;
    while (!this.abort.signal.aborted) {
      const startedAt = Date.now();
      try { await this.session(); }
      catch (error) {
        if (error instanceof CursorExpiredError || error instanceof RoutineClientSupersededError) throw error;
        if (!this.abort.signal.aborted) this.options.onError?.(error instanceof Error ? error : new Error('Reply stream failed'));
      }
      if (this.abort.signal.aborted) break;
      if (Date.now() - startedAt >= 30_000) attempt = 0;
      const min = this.options.reconnectMinMs ?? 500;
      const ms = Math.min(this.options.reconnectMaxMs ?? 30_000, min * 2 ** Math.min(attempt++, 16));
      try { await delay(ms, undefined, { signal: this.abort.signal }); } catch { break; }
    }
  }
  private session(): Promise<void> {
    const url = new URL('/ws', this.options.serverUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { followRedirects: false }); this.socket = ws;
      let authenticated = false, failed = false, fatal: Error | undefined;
      let queue = Promise.resolve();
      const mcp = this.mcpClientId ? new LocalMcpDispatch(this.options) : undefined;
      const fail = (error: unknown) => {
        failed = true;
        fatal = error instanceof Error ? error : new Error('Routine stream failed');
        this.closeSocket(ws);
      };
      let alive = true;
      const authTimer = setTimeout(() => { fatal = new Error('Routine authentication timed out'); ws.terminate(); }, this.options.authTimeoutMs ?? 15_000);
      const heartbeat = setInterval(() => {
        if (!alive) { ws.terminate(); return; } alive = false;
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, this.options.heartbeatMs ?? 30_000);
      ws.on('pong', () => { alive = true; });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'routine_auth', routineId: this.options.routineId,
        secret: this.options.webhookSecret, ...(!mcp || this.cursor !== null ? { cursor: this.cursor } : {}),
        ...(mcp ? { clientId: this.mcpClientId, mcp: { supported: true } } : {}) })));
      ws.on('message', bytes => {
        if (failed || this.abort.signal.aborted) return;
        let frame: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(bytes.toString()); alive = true;
          if (!record(parsed)) throw new Error('Invalid Routine stream frame');
          frame = parsed;
          if (frame.type === 'ping') { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong', ...(typeof frame.id === 'string' ? { id: frame.id } : {}) })); return; }
          if (frame.type === 'pong') return;
          if (frame.type === 'routine_auth_ok') {
            if (authenticated || frame.routineId !== this.options.routineId ||
              (mcp && (frame.clientId !== this.mcpClientId || !record(frame.mcp) || frame.mcp.supported !== true))) {
              throw new Error('Routine authentication mismatch');
            }
            authenticated = true; clearTimeout(authTimer); this.options.onReady?.(); return;
          }
          if (frame.type === 'routine_mcp_request') {
            if (!authenticated || !mcp || frame.routineId !== this.options.routineId ||
              typeof frame.requestId !== 'string' || !/^rmcp_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(frame.requestId) ||
              typeof frame.groupChatId !== 'string' || !/^[a-f0-9]{24}$/i.test(frame.groupChatId) ||
              !mcpServerName(frame.serverName) || !rpcRequest(frame.message) ||
              (frame.boundContext !== undefined && !record(frame.boundContext))) throw new Error('Invalid Routine MCP request');
            topicKey(frame.topicKey);
            const { requestId, topicKey: key, groupChatId, serverName, boundContext, message } = frame;
            // Tool execution is independent of the ordered reply/cursor queue.
            void mcp.dispatch({ routineId: this.options.routineId, topicKey: key, groupChatId, serverName, boundContext }, message)
              .then(result => {
                if (!failed && !this.abort.signal.aborted && ws.readyState === WebSocket.OPEN) {
                  const envelope = { type: 'routine_mcp_response', requestId };
                  let encoded: string;
                  try { encoded = JSON.stringify({ ...envelope, ...result }); }
                  catch { encoded = JSON.stringify({ ...envelope, error: { code: 'handler_error', message: 'Local MCP response is not serializable' } }); }
                  ws.send(encoded);
                }
              }).catch(() => fail(new Error('Could not send Routine MCP response')));
            return;
          }
          if (frame.type === 'routine.reply' && !authenticated) throw new Error('Invalid Routine stream reply');
        } catch (error) { fail(error); return; }
        queue = queue.then(async () => {
          if (failed || this.abort.signal.aborted) return;
          if (frame.type === 'routine_cursor_expired') {
            if (typeof frame.earliestCursor !== 'string' || !this.options.onCursorExpired) throw new CursorExpiredError('Routine cursor expired; explicit recovery is required');
            let nextCursor: string | null;
            try {
              nextCursor = await this.options.onCursorExpired(frame.earliestCursor);
              if (nextCursor !== null && (typeof nextCursor !== 'string' || !nextCursor.trim())) {
                throw new Error('Recovery cursor must be a nonempty string or null');
              }
              if (nextCursor !== null) await this.options.persistCursor?.(nextCursor);
            } catch (error) {
              throw new CursorExpiredError('Routine cursor recovery declined; reconcile before resuming', { cause: error });
            }
            this.cursor = nextCursor;
            failed = true; this.closeSocket(ws); return;
          }
          if (frame.type !== 'routine.reply') throw new Error('Unexpected Routine stream frame');
          const reply = validateReply(frame) as RoutineReply;
          if (!authenticated || reply.routineId !== this.options.routineId || typeof reply.cursor !== 'string' || !reply.cursor) throw new Error('Invalid Routine stream reply');
          if (!this.seen.has(reply.eventId)) {
            await this.options.onReply(reply);
          }
          // Persistence also advances replayed events supplied through seenEventIds.
          await this.options.persistCursor?.(reply.cursor);
          if (!this.seen.has(reply.eventId)) {
            this.seen.add(reply.eventId);
            while (this.seen.size > (this.options.maxSeenEvents ?? 10_000)) this.seen.delete(this.seen.values().next().value!);
          }
          this.cursor = reply.cursor;
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'routine_cursor', cursor: reply.cursor }));
          this.options.onProcessed?.(reply);
        }).catch(fail);
      });
      ws.on('error', () => { fatal ??= new Error('Routine WebSocket failed'); });
      ws.on('close', code => {
        if (mcp && code === 4409 && !this.abort.signal.aborted) fatal = new RoutineClientSupersededError('Another listener took over this MCP clientId');
        clearTimeout(authTimer); clearInterval(heartbeat); clearTimeout(this.closeTimer);
        this.closeTimer = undefined;
        if (this.socket === ws) this.socket = undefined;
        void Promise.all([queue, mcp?.close()]).then(() => fatal ? reject(fatal) : resolve(), reject);
      });
      if (this.abort.signal.aborted) this.closeSocket(ws);
    });
  }
}
export class CursorExpiredError extends Error {}
export class RoutineClientSupersededError extends Error {}
