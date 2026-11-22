import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
let initialized = false, settings;
input.on('line', async line => {
  const message = JSON.parse(line);
  if (message.method === 'fixture/exit') {
    await new Promise(resolve => process.stderr.write('OLD-DIAGNOSTIC' + 'x'.repeat(9000), resolve));
    await new Promise(resolve => process.stderr.write('\n  fixture: missing inventory database \n', resolve));
    process.exit(2);
  }
  if (message.method === 'initialize') { settings = message.params; initialized = false; }
  if (message.method === 'notifications/initialized') initialized = !!settings;
  if (message.method === 'tools/call' && !initialized) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Not initialized' } }) + '\n');
    return;
  }
  if (message.method === 'tools/call') await new Promise(resolve => setTimeout(resolve, message.params?.args?.delay ?? 0));
  if (message.method === 'fixture/hang') return;
  if (message.id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
    pid: process.pid, cwd: process.cwd(), marker: process.env.ROUTINE_TEST_MARKER,
    leakedSecret: !!process.env.NIA_ROUTINE_WEBHOOK_SECRET, clientName: settings?.clientInfo?.name,
  } }) + '\n');
});
// Refuse EOF and TERM on demand to test the listener's shutdown escalation.
if (process.env.ROUTINE_TEST_STUBBORN) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
