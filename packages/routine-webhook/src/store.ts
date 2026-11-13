import { mkdir, readFile, writeFile, rename, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Credentials, CredentialProfile } from './types.js';

/** One writer per config directory; use separate directories for concurrent processes. */
export class CredentialStore {
  readonly configDir: string;
  constructor(configDir?: string) {
    this.configDir = configDir ?? process.env.NIA_ROUTINE_WEBHOOK_CONFIG_DIR ?? join(homedir(), '.config/nia-teams-routine-webhook');
  }
  async read(): Promise<Credentials> {
    try { return JSON.parse(await readFile(join(this.configDir, 'credentials.json'), 'utf8')) as Credentials; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { defaultProfile: 'default', profiles: {} }; throw error; }
  }
  async write(credentials: Credentials): Promise<void> {
    // Reconstruct allowed fields: setup bearer tokens never enter this serialization path.
    const profiles = Object.fromEntries(Object.entries(credentials.profiles).map(([key, p]) => [key, {
      serverUrl: p.serverUrl, routineId: p.routineId, teamId: p.teamId, agentSlug: p.agentSlug,
      agentName: p.agentName, routineName: p.routineName, webhookUrl: p.webhookUrl,
      webhookSecret: p.webhookSecret, autoApproveReply: p.autoApproveReply, connectMac: p.connectMac,
      cursor: p.cursor ?? null, createdAt: p.createdAt,
    }]));
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    await chmod(this.configDir, 0o700);
    const temporary = join(this.configDir, `.credentials-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ defaultProfile: credentials.defaultProfile, profiles }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(this.configDir, 'credentials.json'));
    } finally { await rm(temporary, { force: true }); }
  }
  async get(name?: string): Promise<CredentialProfile> {
    const data = await this.read();
    const profile = Object.hasOwn(data.profiles, name ?? data.defaultProfile) ? data.profiles[name ?? data.defaultProfile] : undefined;
    if (!profile) throw new Error('Profile not found; run init first');
    return profile;
  }
  async save(profile: CredentialProfile, name = 'default'): Promise<void> {
    const data = await this.read();
    Object.defineProperty(data.profiles, name, { value: profile, enumerable: true, configurable: true, writable: true });
    await this.write(data);
  }
  async remove(name?: string): Promise<void> {
    const data = await this.read(); delete data.profiles[name ?? data.defaultProfile];
    if (!Object.hasOwn(data.profiles, data.defaultProfile)) data.defaultProfile = Object.keys(data.profiles)[0] ?? 'default';
    await this.write(data);
  }
  async setCursor(cursor: string, name?: string): Promise<void> {
    const data = await this.read(); const key = name ?? data.defaultProfile;
    if (!Object.hasOwn(data.profiles, key)) throw new Error('Profile not found');
    data.profiles[key].cursor = cursor; await this.write(data);
  }
}
