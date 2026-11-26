import { RoutineWebhookClient } from '@nia-teams/routine-webhook';

const client = await RoutineWebhookClient.fromProfile();
const topicKey = 'order:1042';
await client.send({
  topicKey,
  title: 'Order #1042 · Inventory Sync',
  message: 'Order #1042 is ready for inventory review.',
  wake: false,
});
const result = await client.send({
  topicKey,
  message: 'Check inventory and reserve 3 units of SKU ACME-42.',
  payload: { orderId: '1042', sku: 'ACME-42', quantity: 3 },
  contextKeys: ['orderId'],
});
console.log(result);
