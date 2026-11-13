import { verifyRoutineCallback } from '@nia-teams/routine-webhook';
import { readFile } from 'node:fs/promises';

const rawBody = await readFile(process.argv[2] ?? 'callback.json');
const secret = process.env.NIA_ROUTINE_WEBHOOK_SECRET;
if (!secret) throw new Error('Set NIA_ROUTINE_WEBHOOK_SECRET.');
const reply = verifyRoutineCallback({
  rawBody,
  signatureHeader: process.env.CALLBACK_SIGNATURE,
  secret,
});
console.log(reply);
