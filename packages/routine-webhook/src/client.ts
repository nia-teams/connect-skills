import { randomUUID } from 'node:crypto';
import { requestJson, serverOrigin, validateUrl, topicKey } from './http.js';
import { signature } from './callback.js';
import { RoutineReplyStream, type ReplyStreamOptions } from './stream.js';
import type { AcceptedReply, SendOptions } from './types.js';
import { CredentialStore } from './store.js';
export interface ClientOptions {
  serverUrl?: string; webhookUrl?: string; routineId?: string; webhookSecret?: string;
  getBearerToken?: () => string | Promise<string>; retries?: number;
}
export class RoutineWebhookClient {
  readonly serverUrl: string; readonly webhookUrl: string; readonly routineId: string;
  private readonly secret?: string;
  private readonly options: ClientOptions;
  constructor(options: ClientOptions = {}) {
    this.options = options;
    const webhook = options.webhookUrl ? validateUrl(options.webhookUrl) : undefined;
    this.serverUrl = serverOrigin(options.serverUrl ?? webhook?.origin);
    this.routineId = options.routineId ?? (webhook ? decodeURIComponent(webhook.pathname.split('/').pop()!) : process.env.NIA_ROUTINE_ID) ?? '';
    if (!this.routineId || !/^[A-Za-z0-9_-]+$/.test(this.routineId)) throw new Error('A valid routineId is required');
    this.webhookUrl = `${this.serverUrl}/api/webhook/routine/${encodeURIComponent(this.routineId)}`;
    if (webhook && webhook.href !== this.webhookUrl) throw new Error('Webhook URL must match the Routine endpoint and server');
    this.secret = options.webhookSecret ?? (options.getBearerToken ? undefined : process.env.NIA_ROUTINE_WEBHOOK_SECRET);
    if (!!this.secret === !!options.getBearerToken) throw new Error('Choose exactly one auth mode: Routine secret or getBearerToken');
    if (options.retries !== undefined && (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 5)) throw new Error('retries must be 0..5');
  }
  static async fromProfile(options: { configDir?: string; profile?: string } = {}): Promise<RoutineWebhookClient> {
    return new RoutineWebhookClient(await new CredentialStore(options.configDir).get(options.profile));
  }
  async send(input: SendOptions): Promise<AcceptedReply> {
    topicKey(input.topicKey);
    if (typeof input.message !== 'string' || !input.message.trim()) throw new Error('message is required');
    const key = input.idempotencyKey ?? randomUUID();
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new Error('Invalid Idempotency-Key');
    const delivery = input.return ?? { type: this.secret ? 'wss' : 'none' };
    if (!['wss', 'none', 'callback'].includes(delivery.type)) throw new Error('Invalid return type');
    if (delivery.type === 'wss' && !this.secret) throw new Error('WSS requires a Routine secret');
    if (delivery.type === 'callback') {
      if (validateUrl(delivery.url).protocol !== 'https:') throw new Error('Callback URL must use HTTPS');
    }
    const payload = input.payload ?? {};
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be an object');
    if (input.contextKeys?.some(k => !/^[A-Za-z0-9_.:-]+$/.test(k) || !Object.hasOwn(payload, k))) throw new Error('contextKeys must name top-level payload keys');
    const body = JSON.stringify({ protocol: 'nia-routine-source-v1', message: input.message,
      ...(input.title !== undefined ? { title: input.title } : {}), source: { type: 'external-agent', topicKey: input.topicKey, return: delivery }, payload });
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Idempotency-Key': key };
    if (input.contextKeys?.length) headers['X-Nia-Context-Keys'] = input.contextKeys.join(',');
    if (this.secret) headers['X-Hub-Signature-256'] = signature(body, this.secret);
    else {
      const token = await this.options.getBearerToken!();
      if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('getBearerToken returned an invalid token');
      headers.Authorization = `Bearer ${token}`;
    }
    const result = await requestJson<AcceptedReply>(this.webhookUrl, { method: 'POST', headers, body }, this.options.retries ?? 2);
    if (result.accepted !== true || ['teamId', 'groupChatId', 'messageId'].some(k => typeof result[k as keyof AcceptedReply] !== 'string')) throw new Error('Invalid invocation response');
    return result;
  }
  listen(options: Omit<ReplyStreamOptions, 'serverUrl' | 'routineId' | 'webhookSecret'>): RoutineReplyStream {
    if (!this.secret) throw new Error('WSS requires a Routine secret');
    return new RoutineReplyStream({ ...options, serverUrl: this.serverUrl, routineId: this.routineId, webhookSecret: this.secret });
  }
}
