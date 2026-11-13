import { setTimeout as delay } from 'node:timers/promises';
import { serverOrigin, requestJson, jsonRequest, validateUrl } from './http.js';
import { CredentialStore } from './store.js';
import type { ConnectStart, ApprovedConnection, Routine, RoutineCreate, RoutinePatch, CredentialProfile } from './types.js';
export interface ConnectOptions {
  serverUrl?: string; clientLabel?: string; timeoutMs?: number;
  onVerification: (request: ConnectStart) => void | Promise<void>;
  signal?: AbortSignal;
}
/** Single-use retrieved setup bearer. Keep the result in memory only. */
export async function agentConnect(options: ConnectOptions): Promise<ApprovedConnection> {
  const origin = serverOrigin(options.serverUrl);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 600_000)]) : AbortSignal.timeout(options.timeoutMs ?? 600_000);
  const start = await requestJson<ConnectStart>(`${origin}/api/agent-connect/start`, { ...jsonRequest({ clientLabel: options.clientLabel ?? 'Routine Webhook CLI' }), signal });
  const verification = validateUrl(start.verificationUrl);
  if (verification.origin !== origin || verification.pathname !== `/connect/${encodeURIComponent(start.connectCode)}`) throw new Error('Untrusted verification URL');
  await options.onVerification(start);
  const statusUrl = new URL('/api/agent-connect/status', origin);
  statusUrl.searchParams.set('reference', start.connectId); statusUrl.searchParams.set('pollSecret', start.pollSecret);
  for (;;) {
    const result = await requestJson<ApprovedConnection | { status: 'pending' | 'expired' }>(statusUrl.href, { signal });
    if (result.status === 'approved') {
      if (!result.teamId || !result.workloadToken) throw new Error('Invalid approval response');
      return result;
    }
    if (result.status === 'expired') throw new Error('Connection request expired');
    await delay(2_000, undefined, { signal });
  }
}
/** Scope the setup token to an operation and clear our reference on completion. */
export async function withProvisioning<T>(options: ConnectOptions, operation: (api: RoutineProvisioner) => Promise<T>): Promise<T> {
  const approved = await agentConnect(options);
  const api = new RoutineProvisioner(serverOrigin(options.serverUrl), approved.teamId, approved.workloadToken);
  approved.workloadToken = '';
  try { return await operation(api); } finally { api.dispose(); }
}
export class RoutineProvisioner {
  private token: string;
  readonly serverUrl: string;
  constructor(serverUrl: string, readonly teamId: string, workloadToken: string) {
    this.serverUrl = serverOrigin(serverUrl); this.token = workloadToken;
  }
  dispose(): void { this.token = ''; }
  private async call<T>(method: string, suffix = '', body?: unknown): Promise<T> {
    if (!this.token) throw new Error('Setup token has been discarded');
    return requestJson<T>(`${this.serverUrl}/api/teams/${encodeURIComponent(this.teamId)}/webhook-routines${suffix}`, { ...jsonRequest(body, this.token), method });
  }
  list(): Promise<{ teamId: string; agentSlug: string; agentName: string; routines: Routine[] }> { return this.call('GET'); }
  async create(input: RoutineCreate): Promise<Routine> { return (await this.call<{ ok: true; routine: Routine }>('POST', '', input)).routine; }
  async update(id: string, patch: RoutinePatch): Promise<Routine> { return (await this.call<{ ok: true; routine: Routine }>('PATCH', `/${encodeURIComponent(id)}`, patch)).routine; }
  delete(id: string): Promise<{ ok: true; routineId: string }> { return this.call('DELETE', `/${encodeURIComponent(id)}`); }
}
export function routineProfile(routine: Routine, serverUrl: string): CredentialProfile {
  const origin = serverOrigin(serverUrl); const webhook = validateUrl(routine.webhookUrl);
  if (webhook.origin !== origin || webhook.pathname !== `/api/webhook/routine/${encodeURIComponent(routine.routineId)}`) throw new Error('Unexpected Routine webhook URL');
  return { serverUrl: origin, routineId: routine.routineId, teamId: routine.teamId, agentSlug: routine.agentSlug,
    agentName: routine.agentName, routineName: routine.name, webhookUrl: webhook.href, webhookSecret: routine.webhookSecret,
    autoApproveReply: routine.autoApproveReply, connectMac: routine.connectMac === true, cursor: null, createdAt: routine.createdAt };
}
export async function initializeRoutine(options: ConnectOptions & RoutineCreate & { configDir?: string; profile?: string }): Promise<CredentialProfile> {
  return withProvisioning(options, async api => {
    const profile = routineProfile(await api.create({ name: options.name, task: options.task, autoApproveReply: options.autoApproveReply, connectMac: options.connectMac ?? true }), api.serverUrl);
    await new CredentialStore(options.configDir).save(profile, options.profile); return profile;
  });
}
