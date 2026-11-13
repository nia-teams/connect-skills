#!/usr/bin/env node
import { serverOrigin } from '../dist/http.js';
import { parseArgs } from 'node:util';
import { RoutineWebhookClient, CredentialStore, initializeRoutine, withProvisioning, routineProfile } from '../dist/index.js';

const help = `nia-routine-webhook <init|send|listen|profiles|rotate-secret|delete>
  init --name NAME --task TEXT [--auto-approve-reply|--require-reply-approval] [--connect-mac|--no-connect-mac]
  send --topic-key KEY [--message TEXT | stdin] [--title TEXT] [--payload JSON]
       [--context-keys k1,k2] [--return wss|none|https://...] [--idempotency-key KEY]
  listen [--topic-key KEY] [--once] [--timeout-ms 600000]
  Shared: --profile NAME --config-dir DIR --server https://nia-teams.com
  Setup: --label TEXT --timeout-ms 600000
  profiles displays redacted local profiles. rotate-secret and delete require browser approval.
`;
const strings = ['name','task','profile','config-dir','server','label','timeout-ms','topic-key','message','title','payload','context-keys','return','idempotency-key'];
async function output(value) {
  await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve()));
}
async function main() {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: {
    ...Object.fromEntries(strings.map(name => [name, { type: 'string' }])),
    ...Object.fromEntries(['auto-approve-reply','require-reply-approval','connect-mac','no-connect-mac','once','help'].map(name => [name, { type: 'boolean' }]))
  } });
  const [command] = positionals;
  if (v.help || !command) { process.stdout.write(help); return; }
  if (positionals.length > 1) throw new Error('Unexpected positional arguments');
  const timeoutMs = Number(v['timeout-ms'] ?? 600000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error('Invalid timeout-ms');
  if (!['init','send','listen','profiles','rotate-secret','delete'].includes(command)) throw new Error('Unknown command; use --help');
  if (v.server) serverOrigin(v.server);
  const store = new CredentialStore(v['config-dir']);
  const setup = (serverUrl = v.server) => ({ serverUrl, clientLabel: v.label, timeoutMs,
    onVerification: ({ verificationUrl }) => { process.stderr.write(`Open this URL and confirm authorization:\n${verificationUrl}\n`); } });
  if (command === 'init') {
    if (!v.name || !v.task) throw new Error('init requires --name and --task');
    if (v['auto-approve-reply'] && v['require-reply-approval']) throw new Error('Choose one reply approval mode');
    if (v['connect-mac'] && v['no-connect-mac']) throw new Error('Choose one Mac connection mode');
    const p = await initializeRoutine({ ...setup(), name: v.name, task: v.task,
      autoApproveReply: v['auto-approve-reply'] ? true : v['require-reply-approval'] ? false : undefined,
      connectMac: v['no-connect-mac'] ? false : true,
      profile: v.profile, configDir: v['config-dir'] });
    await output({ profile: v.profile ?? 'default', routineId: p.routineId, agentSlug: p.agentSlug, webhookUrl: p.webhookUrl, connectMac: p.connectMac === true }); return;
  }
  if (command === 'profiles') {
    const data = await store.read();
    await output({ defaultProfile: data.defaultProfile, profiles: Object.fromEntries(Object.entries(data.profiles).map(([name, p]) => [name, { ...p, webhookSecret: '[REDACTED]' }])) }); return;
  }
  if (command === 'rotate-secret' || command === 'delete') {
    const p = await store.get(v.profile);
    if (v.server && new URL(v.server).origin !== p.serverUrl) throw new Error('Server must match the saved profile');
    await withProvisioning(setup(p.serverUrl), async api => {
      if (api.teamId !== p.teamId) throw new Error('Authorize the same Agent as the saved profile');
      if (command === 'delete') { await api.delete(p.routineId); await store.remove(v.profile); }
      else {
        const updated = routineProfile(await api.update(p.routineId, { rotateSecret: true }), p.serverUrl);
        await store.save({ ...updated, cursor: p.cursor }, v.profile ?? (await store.read()).defaultProfile);
      }
    });
    await output({ ok: true, routineId: p.routineId }); return;
  }
  // Direct environment configuration does not open or create a credential file.
  const direct = !!process.env.NIA_ROUTINE_ID && !!process.env.NIA_ROUTINE_WEBHOOK_SECRET && !v.profile;
  const p = direct ? undefined : await store.get(v.profile);
  if (p && v.server && new URL(v.server).origin !== p.serverUrl) throw new Error('Server must match the saved profile');
  const client = new RoutineWebhookClient(p ?? { serverUrl: v.server });
  if (command === 'send') {
    if (!v['topic-key']) throw new Error('send requires --topic-key');
    let message = v.message;
    if (message === undefined) {
      if (process.stdin.isTTY) throw new Error('Provide --message or pipe stdin');
      const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
      message = Buffer.concat(chunks).toString('utf8');
    }
    const delivery = !v.return ? undefined : ['wss','none'].includes(v.return) ? { type: v.return } : { type: 'callback', url: v.return };
    await output(await client.send({ topicKey: v['topic-key'], message, title: v.title,
      payload: v.payload ? JSON.parse(v.payload) : undefined, contextKeys: v['context-keys']?.split(','),
      return: delivery, idempotencyKey: v['idempotency-key'] })); return;
  }
  if (command === 'listen') {
    let matched = false, timedOut = false;
    const stream = client.listen({ initialCursor: p?.cursor,
      onReply: async reply => {
        if (v['topic-key'] && reply.topicKey !== v['topic-key']) return;
        await output(reply); matched = true;
      },
      persistCursor: async cursor => {
        if (p) await store.setCursor(cursor, v.profile);
      },
      onProcessed: () => { if (v.once && matched) stream.stop(); },
      onError: () => process.stderr.write('Reply stream interrupted; reconnecting.\n')
    });
    const timer = setTimeout(() => { timedOut = true; stream.stop(); }, timeoutMs);
    const stop = () => stream.stop(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { await stream.run(); } finally { clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    if (timedOut) throw new Error('Listen timed out'); return;
  }
  throw new Error('Unknown command; use --help');
}
main().catch(error => { process.stderr.write(`Error: ${error.message}\n`); process.exitCode = 1; });
