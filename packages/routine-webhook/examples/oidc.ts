import { RoutineWebhookClient } from '@nia-teams/routine-webhook';

const client = new RoutineWebhookClient({
  routineId: process.env.NIA_ROUTINE_ID,
  getBearerToken: () => {
    const token = process.env.WORKLOAD_OIDC_TOKEN;
    if (!token) throw new Error('Set WORKLOAD_OIDC_TOKEN to a current workload token.');
    return token;
  },
});
console.log(await client.send({ topicKey: 'order:1042', message: 'Check dispatch readiness.' }));
