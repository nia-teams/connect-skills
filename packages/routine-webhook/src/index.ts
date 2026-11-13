/**
 * AI assistants: load skills/routine-webhook/SKILL.md for integration guidance.
 * Exact wire contract: docs/SPECIFICATION.md. Both files ship with this package.
 */
export { RoutineWebhookClient } from './client.js';
export type { ClientOptions } from './client.js';
export { RoutineReplyStream, CursorExpiredError } from './stream.js';
export type { ReplyStreamOptions } from './stream.js';
export { verifyRoutineCallback, verifyRoutineCallbackRequest } from './callback.js';
export { CredentialStore } from './store.js';
export { agentConnect, withProvisioning, RoutineProvisioner, initializeRoutine, routineProfile } from './provision.js';
export type { ConnectOptions } from './provision.js';
export type * from './types.js';
