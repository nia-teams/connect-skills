import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { serverOrigin } from './http.js';
import { validateReply } from './callback.js';
import type { RoutineReply } from './types.js';
export interface ReplyStreamOptions {
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
}
/** At-least-once delivery. Handler side effects should be idempotent by eventId. */
export class RoutineReplyStream {
  private socket?: WebSocket;
  private closeTimer?: NodeJS.Timeout;
  private readonly abort = new AbortController();
  private started = false;
  private cursor: string | null;
  private readonly seen: Set<string>;
  constructor(private readonly options: ReplyStreamOptions) {
    serverOrigin(options.serverUrl);
    if (!options.webhookSecret) throw new Error('WSS requires a Routine secret');
    for (const key of ['maxSeenEvents', 'reconnectMinMs', 'reconnectMaxMs', 'heartbeatMs', 'authTimeoutMs'] as const) {
      const value = options[key];
      if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 2_147_483_647)) throw new Error(`Invalid ${key}`);
    }
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
  async run(): Promise<void> {
    if (this.started) throw new Error('Stream already started'); this.started = true;
    let attempt = 0;
    while (!this.abort.signal.aborted) {
      const startedAt = Date.now();
      try { await this.session(); }
      catch (error) {
        if (error instanceof CursorExpiredError) throw error;
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
      let alive = true;
      const authTimer = setTimeout(() => { fatal = new Error('Routine authentication timed out'); ws.terminate(); }, this.options.authTimeoutMs ?? 15_000);
      const heartbeat = setInterval(() => {
        if (!alive) { ws.terminate(); return; } alive = false;
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, this.options.heartbeatMs ?? 30_000);
      ws.on('pong', () => { alive = true; });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'routine_auth', routineId: this.options.routineId, secret: this.options.webhookSecret, cursor: this.cursor })));
      ws.on('message', bytes => {
        queue = queue.then(async () => {
          if (failed || this.abort.signal.aborted) return;
          const frame = JSON.parse(bytes.toString()); alive = true;
          if (frame.type === 'ping') { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong', ...(typeof frame.id === 'string' ? { id: frame.id } : {}) })); return; }
          if (frame.type === 'pong') return;
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
          if (frame.type === 'routine_auth_ok') {
            if (frame.routineId !== this.options.routineId) throw new Error('Routine authentication mismatch');
            authenticated = true; clearTimeout(authTimer); return;
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
        }).catch(error => { failed = true; fatal = error; this.closeSocket(ws); });
      });
      ws.on('error', () => { fatal ??= new Error('Routine WebSocket failed'); });
      ws.on('close', () => {
        clearTimeout(authTimer); clearInterval(heartbeat); clearTimeout(this.closeTimer);
        this.closeTimer = undefined;
        if (this.socket === ws) this.socket = undefined;
        void queue.then(() => fatal ? reject(fatal) : resolve());
      });
      if (this.abort.signal.aborted) this.closeSocket(ws);
    });
  }
}
export class CursorExpiredError extends Error {}
