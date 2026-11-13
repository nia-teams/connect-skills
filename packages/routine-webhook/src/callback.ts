import { createHmac, timingSafeEqual } from 'node:crypto';
import { topicKey } from './http.js';
import type { RoutineReplyPayload } from './types.js';
export function signature(rawBody: string | Uint8Array, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}
export function validateReply(value: unknown): RoutineReplyPayload {
  if (!value || typeof value !== 'object') throw new Error('Invalid Routine reply');
  const p = value as Record<string, unknown>;
  if (p.type !== 'routine.reply' || ['eventId', 'routineId', 'createdAt'].some(k => typeof p[k] !== 'string' || !p[k]) ||
      typeof p.content !== 'string' || !Number.isFinite(Date.parse(p.createdAt as string))) throw new Error('Invalid Routine reply');
  topicKey(p.topicKey);
  return p as unknown as RoutineReplyPayload;
}
/** Verify the untouched request bytes before JSON parsing. Throws on invalid signature or payload. */
export function verifyRoutineCallback({ rawBody, signatureHeader, secret }: {
  rawBody: string | Uint8Array; signatureHeader: string | undefined; secret: string;
}): RoutineReplyPayload {
  if (!secret || !signatureHeader || !/^sha256=[a-fA-F0-9]{64}$/.test(signatureHeader)) throw new Error('Invalid callback signature');
  const received = Buffer.from(signatureHeader.slice(7), 'hex');
  const expected = Buffer.from(signature(rawBody, secret).slice(7), 'hex');
  if (!timingSafeEqual(received, expected)) throw new Error('Invalid callback signature');
  return validateReply(JSON.parse(Buffer.from(rawBody).toString('utf8')));
}
export const verifyRoutineCallbackRequest = verifyRoutineCallback;
