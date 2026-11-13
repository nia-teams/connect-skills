export interface RoutineReplyPayload {
  type: 'routine.reply'; eventId: string; routineId: string; topicKey: string;
  content: string; createdAt: string; cursor?: string;
}
export interface RoutineReply extends RoutineReplyPayload { cursor: string }
export type ReturnDelivery = { type: 'wss' } | { type: 'none' } | { type: 'callback'; url: string };
export interface SendOptions {
  topicKey: string; message: string; title?: string; payload?: Record<string, unknown>;
  contextKeys?: string[]; return?: ReturnDelivery; idempotencyKey?: string;
}
export interface AcceptedReply { accepted: true; teamId: string; groupChatId: string; messageId: string }
export interface Routine {
  routineId: string; teamId: string; agentSlug: string; agentName: string;
  name: string; task: string; enabled: boolean; autoApproveReply: boolean; connectMac: boolean;
  webhookUrl: string; webhookSecret: string; createdAt: string; updatedAt: string;
}
export interface CredentialProfile {
  serverUrl: string; routineId: string; teamId: string; agentSlug: string; agentName: string;
  routineName: string; webhookUrl: string; webhookSecret: string; autoApproveReply: boolean; connectMac?: boolean;
  cursor: string | null; createdAt: string;
}
export interface Credentials { defaultProfile: string; profiles: Record<string, CredentialProfile> }
export interface ConnectStart {
  connectId: string; connectCode: string; pollSecret: string; clientLabel: string;
  expiresInSeconds: number; verificationUrl: string;
}
export interface ApprovedConnection {
  status: 'approved'; teamId: string; agentSlug: string; agentName: string;
  issuer: string; audience: string; expiresInSeconds: number; workloadToken: string;
}
export interface RoutineCreate { name: string; task: string; autoApproveReply?: boolean; connectMac?: boolean }
export interface RoutinePatch extends Partial<RoutineCreate> {
  enabled?: boolean; rotateSecret?: boolean; ensureFollowing?: boolean;
}
