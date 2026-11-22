import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RoutineWebhookClient } from '@nia-teams/routine-webhook';

const topicKey = 'order:1042';
function inventory(stock: number) {
  const server = new McpServer({ name: 'inventory', version: '1.0.0' });
  server.registerTool('get_stock', { description: 'Read the stock count' }, async () => ({
    content: [{ type: 'text', text: String(stock) }],
  }));
  return server;
}

const useStaticMount = process.argv.includes('--static');
const client = await RoutineWebhookClient.fromProfile(useStaticMount ? {
  mcpServers: { inventory: inventory(3) },
} : {
  resolveMcp: ({ topicKey, serverName }) => {
    if (serverName !== 'inventory') return;
    if (topicKey === 'order:1042') return inventory(3);
    if (topicKey === 'order:1043') return inventory(7);
  },
});

let ready!: () => void;
const authenticated = new Promise<void>(resolve => { ready = resolve; });
const stream = client.listen({ onReady: ready, onReply: reply => { console.log(reply.content); } });
const running = stream.run();
process.once('SIGINT', () => stream.stop());
process.once('SIGTERM', () => stream.stop());
try {
  const connected = await Promise.race([authenticated.then(() => true), running.then(() => false)]);
  if (connected) {
    await client.send({
      topicKey,
      message: 'Use the inventory MCP server to read local stock and reply with the count.',
      mcpServers: useStaticMount ? undefined : [{ name: 'inventory' }],
    });
    await running;
  }
} finally {
  await client.close();
}
