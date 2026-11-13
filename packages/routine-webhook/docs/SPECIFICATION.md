# Nia Teams Connect specification

This contract covers cloud and cluster OIDC access, shared Agent pairing, authorization roles, and Webhook Routine invocation and replies.
Base URL: `https://nia-teams.com`. JSON requests use
`Content-Type: application/json`. Success schemas below apply to 2xx responses.

## Discovery and token validation

- Issuer: `https://nia-teams.com` (exact string, no trailing slash).
- Discovery: `GET /.well-known/openid-configuration`.
- JWKS: `GET /oauth2/jwks`, also advertised by `jwks_uri` in discovery.
- JWT signature algorithm: RS256; select the public key by protected-header `kid`.
- Workload audience: `nia-teams-workload`.
- Validate signature, issuer, audience, expiry and any applicable time claims before authorization.
  Refresh cached JWKS when an unknown `kid` appears.
- Authorization matches exact subjects/groups. Human membership is checked independently.

### Role-bound claims

For suffix `name` and the returned `agentSlug`, derive `roleKey = agent.<agentSlug>.<name>`.
`name` matches `/^[a-z0-9][a-z0-9-]{0,31}$/`. Cloud role names are independent objects.
The following are relevant payload fields; standard `iat` and `exp` are NumericDate seconds.

Ordinary token:

```json
{
  "iss": "https://nia-teams.com",
  "aud": "nia-teams-workload",
  "sub": "role:agent.<agentSlug>.<name>",
  "principal_type": "workload",
  "groups": ["role:agent.<agentSlug>.<name>"],
  "iat": 1804377600,
  "exp": 1804381200
}
```

Human-confirmed elevated token:

```json
{
  "iss": "https://nia-teams.com",
  "aud": "nia-teams-workload",
  "sub": "role:agent.<agentSlug>.<name>:elevated",
  "principal_type": "workload",
  "groups": [
    "role:agent.<agentSlug>.<name>",
    "nia:elevated:role:agent.<agentSlug>.<name>"
  ],
  "human_confirmed": true,
  "confirmed_by": "<approving human user ID>",
  "team_id": "<selected teamId>",
  "elevation_kind": "human-confirmed-workload",
  "iat": 1804377600,
  "exp": 1804381200
}
```

The ordinary group remains present in elevated tokens. Resident trust matches both exact subjects;
elevated trust matches only `role:<roleKey>:elevated`. Kubernetes Group bindings instead match
`role:<roleKey>` and `nia:elevated:role:<roleKey>` respectively. Match configured username/group
prefixes to effective API-server claim mappings.

The Agent's default workload identity uses its Agent slug as `sub`, not a `role:` subject; its groups
may include `team:<agentSlug>`, applicable `org:<orgSlug>`, and bound `role:<roleKey>` memberships.
That identity is distinct from a role-bound token. The browser-approved setup token is a
human-confirmed workload token scoped to the selected Agent with `aud: "nia-teams-workload"`,
`elevation_kind: "agent-connect"`, `human_confirmed: true`, `confirmed_by: "<uid>"`, and
`team_id: "<teamId>"`; it authorizes the role REST API below.
The setup bearer authorizes configuration; role-bound tokens authorize external resource access.

## Connection handshake

### URL and authentication boundary

`serverUrl`, `--server`, and `NIA_TEAMS_URL` select the origin. The SDK accepts HTTPS;
HTTP is permitted only for loopback development (`localhost`, `127.0.0.1`, `[::1]`).
Origins cannot contain a path other than `/`, credentials, query, or fragment.
Webhook URLs must match `/api/webhook/routine/:routineId` on that origin.
HTTP and WebSocket redirects are rejected. Callback URLs use HTTPS without credentials,
query, or fragment. Deployment is responsible for validating callback destinations.

There are two independent credentials:

- The agent-connect setup bearer authorizes Routine administration for one selected Agent.
- A Routine secret authorizes invocation and its reply stream. A cloud Workload OIDC bearer
  can authorize invocation through the Routine's configured workload trust.

An invocation acceptance is not an Agent reply or evidence that a task completed.

### POST /api/agent-connect/start

No Nia Teams login credential is required to start. Body:

```json
{ "clientLabel": "Claude Code" }
```

`clientLabel` is optional (default `Coding Agent`); when supplied it must be a string, trimmed to
1–120 characters. The label identifies a client visually; it is not authenticated client identity.
Success response:

```json
{
  "connectId": "<opaque request reference>",
  "connectCode": "<8 hexadecimal characters>",
  "pollSecret": "<opaque polling secret>",
  "clientLabel": "Claude Code",
  "expiresInSeconds": 600,
  "verificationUrl": "https://nia-teams.com/connect/<connectCode>"
}
```

`verificationUrl` has origin `https://nia-teams.com`; `pollSecret` authenticates status retrieval.
The human opens the page, authenticates in the browser, selects an active native Agent, and clicks
**Confirm authorization**. Only that Agent's human `owner` or `admin` can approve; external-host, inactive or
unsupported default Agents cannot be connected. Ordinary `member` status or workload group
membership is insufficient. Browser consent uses signed-in human authentication.

### GET /api/agent-connect/status

Query parameters: `reference=<connectId>&pollSecret=<pollSecret>` (URL-encoded).
Polling interval: two seconds; one in-flight request per pairing.

Pending:

```json
{ "status": "pending", "connectId": "<reference>", "connectCode": "<code>", "clientLabel": "Claude Code" }
```

Approved:

```json
{
  "status": "approved",
  "teamId": "<selected Agent team ID>",
  "agentSlug": "<canonical Agent slug>",
  "agentName": "<display name>",
  "issuer": "https://nia-teams.com",
  "audience": "nia-teams-workload",
  "expiresInSeconds": 3600,
  "workloadToken": "<human-confirmed workload JWT>"
}
```

Expired or already consumed:

```json
{ "status": "expired" }
```

The setup bearer has a one-hour lifetime. Keep it and `pollSecret` in memory, never in saved profiles.
The SDK checks that `verificationUrl` matches the selected origin and returned connect code.
`withProvisioning` and `initializeRoutine` clear bearer references after administration; callers of
`agentConnect` and `RoutineProvisioner` own disposal. JavaScript cannot guarantee physical memory erasure.

The approved result is delivered once and consumes the request. Subsequent retrieval returns
`expired`. The server rechecks the approver's active owner/admin membership before delivery.
Approval is bound to one Agent and human; inconsistent concurrent approvals return 409.
Request lifetime is 600 seconds; approval may extend a nearly expired request for retrieval.

## Authorization-role REST contract

Collection: `/api/teams/:teamId/authorization-roles`.
Item: `/api/teams/:teamId/authorization-roles/:name`.

All methods require `Authorization: Bearer <workloadToken>` from the approved handshake, valid for
`nia-teams-workload`, carrying `elevation_kind: "agent-connect"`, `human_confirmed: true`,
the selected `team_id`, and a valid
`confirmed_by`. The approver must still be an owner/admin of the active native Agent. An ordinary
Agent token, an unrelated team's token, or an external cloud role token does not authorize setup.
An in-sandbox `NIA_ELEVATED_WORKLOAD_TOKEN` carries
`elevation_kind: "human-confirmed-workload"`, not `"agent-connect"`, so it cannot call this role
configuration API or self-mint role tokens. Both token kinds use the single OIDC audience
`nia-teams-workload`; the setup gate distinguishes their `elevation_kind`.
An already-bound role cannot be taken over from a different subject.

### GET collection

Returns the selected Agent's role configuration:

```json
{
  "teamId": "<teamId>",
  "agentSlug": "<agentSlug>",
  "issuer": "https://nia-teams.com",
  "audience": "nia-teams-workload",
  "roles": [{
    "key": "agent.<agentSlug>.<name>",
    "systemPrompt": "<resident instructions>",
    "elevationPrompt": "<post-approval instructions>",
    "sessionElevationEnabled": true,
    "updatedAt": "<ISO 8601 timestamp>"
  }]
}
```

`updatedAt` is present when supplied by the stored record.

### PUT item

Upserts the deterministic role key and binds it to the selected Agent. Request fields:

```json
{
  "systemPrompt": "<resident instructions>",
  "elevationPrompt": "<instructions delivered only after elevation approval>",
  "sessionElevationEnabled": true
}
```

Each field is optional at the wire level: omitted fields retain stored values. Prompt values must be
strings, trimmed, at most 32,000 characters each; an empty/whitespace string clears that prompt.
`sessionElevationEnabled` must be boolean when supplied. Newly unset prompt/flag values are
represented as empty strings / false in responses. IAM/RBAC provisioning is separate from this API.

Success:

```json
{
  "ok": true,
  "role": {
    "key": "agent.<agentSlug>.<name>",
    "ordinarySub": "role:agent.<agentSlug>.<name>",
    "elevatedSub": "role:agent.<agentSlug>.<name>:elevated",
    "systemPrompt": "<resident instructions>",
    "elevationPrompt": "<post-approval instructions>",
    "sessionElevationEnabled": true,
    "updatedAt": "<ISO 8601 timestamp>"
  },
  "tokens": {
    "roleToken": "<ordinary role JWT>",
    "elevatedRoleToken": "<human-confirmed elevated role JWT>",
    "expiresInSeconds": 3600
  }
}
```

The response supplies both verification tokens independently of `sessionElevationEnabled`.
They are issued under the human-confirmed setup authorization. `tokens.elevatedRoleToken` carries
`sub: "role:agent.<agentSlug>.<name>:elevated"` and
`elevation_kind: "human-confirmed-workload"`, as in the elevated payload above.
IAM/RBAC determines external access.
Runtime Sessions require their own elevation approval. PUT merges supplied fields and can issue fresh tokens.

### DELETE item

Deletes the Nia Teams role and its binding to the Agent:

```json
{ "ok": true, "key": "agent.<agentSlug>.<name>" }
```

Conflicting bindings are forbidden. References from active grants or routines can block deletion with
409. Running sandboxes sweep standing role token files on the next lifecycle reconciliation (observed ~15–20 seconds in live tests; deployment-configurable, with a 60-second server default). Deletion does not remove external IAM/RBAC objects or revoke already-issued cloud sessions. For emergency cutoff, remove cloud trust / Kubernetes RoleBindings immediately and separately revoke or deny outstanding STS sessions.
Existing sandboxes may require a role refresh to observe binding changes.

### Failures and credential transport

- 400: invalid fields.
- 401/403: invalid or insufficient authentication/authorization, including conflicting role bindings.
- 404: unavailable resources or approval requests where applicable.
- 409: approval conflicts or referenced-role deletion.

Connection responses include `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
The role API accepts role configuration and the setup bearer; cloud administrator credentials are local.

## Runtime prompt delivery

`systemPrompt` is resident on every turn. With `sessionElevationEnabled: false`, the identity has no
runtime elevation tool. With true, `request_session_elevation({ reason })` emits a TaskBar card.
Only owner/admin approval injects the elevated role token and delivers `elevationPrompt` for the
approved window. `nia role-token <roleKey>` in newly launched shells selects the currently active
ordinary/elevated identity. External STS credentials can have a distinct expiry; token expiry is not
an assertion that every previously issued credential has been revoked.

## Webhook Routine administration

All administration routes below require the same selected-Agent setup bearer and active owner/admin
authorization as the authorization-role API: `Authorization: Bearer <workloadToken>`.
Path IDs are URL-encoded. The selected `teamId` must match the Routine's Agent.

### List

`GET /api/teams/:teamId/webhook-routines`

```json
{ "teamId": "65f000000000000000000002", "agentSlug": "ops-agent", "agentName": "ops-agent", "routines": [] }
```

### Create

`POST /api/teams/:teamId/webhook-routines`

```json
{ "name": "Order Dispatch", "task": "Check inventory and report the result.", "autoApproveReply": true, "connectMac": true }
```

`name` and `task` are required strings. `autoApproveReply` is optional; omitting it leaves
the server default in effect. `true` permits reply delivery without a TaskBar approval click.
`connectMac` is optional; the server defaults it to `true`. `init` and
`initializeRoutine` explicitly send `true` unless disabled (`--no-connect-mac` or
`connectMac: false`). `init` creates a sole-follower Webhook Routine
(`followers = [yourself]`). Automatic Mac connection is on by default (`connectMac: true`): newly created
chats connect your paired Mac. `init` JSON output includes `connectMac: boolean`.
Success: HTTP `201`.

```json
{
  "ok": true,
  "routine": {
    "routineId": "65f000000000000000000003",
    "teamId": "65f000000000000000000002",
    "agentSlug": "ops-agent",
    "agentName": "ops-agent",
    "name": "Order Dispatch",
    "task": "Check inventory and report the result.",
    "enabled": true,
    "autoApproveReply": true,
    "connectMac": true,
    "webhookUrl": "https://nia-teams.com/api/webhook/routine/65f000000000000000000003",
    "webhookSecret": "whsec_fictional_example",
    "createdAt": "2026-11-13T00:00:00.000Z",
    "updatedAt": "2026-11-13T00:00:00.000Z"
  }
}
```

### Update and rotate

`PATCH /api/teams/:teamId/webhook-routines/:routineId`

All fields are optional: `name: string`, `task: string`, `enabled: boolean`,
`autoApproveReply: boolean`, `connectMac: boolean`, `rotateSecret: boolean`, `ensureFollowing: boolean`.
`{ "connectMac": false }` disables automatic Mac connection for newly created chats.
List, create, and update responses include `connectMac: boolean` on each Routine.
`{ "rotateSecret": true }` rotates the Routine secret. Success: HTTP `200`,
`{ "ok": true, "routine": <Routine as above> }`. Replace the local secret and restart listeners.

### Delete

`DELETE /api/teams/:teamId/webhook-routines/:routineId`

Success: HTTP `200`, `{ "ok": true, "routineId": "65f000000000000000000003" }`.
The CLI removes the local profile only after remote deletion succeeds.

## Webhook Routine invocation (`nia-routine-source-v1`)

`POST /api/webhook/routine/:routineId`

### Headers

| Header | Contract |
| --- | --- |
| `Content-Type` | `application/json` |
| `Idempotency-Key` | 8–128 characters matching `^[A-Za-z0-9._:-]{8,128}$` |
| `X-Hub-Signature-256` | `sha256=` plus HMAC-SHA256 hex over the exact raw UTF-8 JSON body, keyed by the Routine secret |
| `X-Webhook-Secret` | Alternative plaintext Routine secret for a trusted HTTPS caller |
| `Authorization` | Alternative `Bearer <Workload OIDC token>` |
| `X-Nia-Context-Keys` | Optional comma-separated top-level keys in `payload`, bound into `_meta.boundContext` |

Choose a single auth mode. The SDK defaults to HMAC for a Routine secret and never sends
`X-Webhook-Secret`. The server checks the hub signature before legacy secret headers.
OIDC callers supply `getBearerToken`; authorization remains subject to configured Routine trust.
A setup bearer is not a saved invocation credential.

The SDK generates a UUIDv4 idempotency key if absent. Its network and HTTP 5xx retries retain
the same key and serialized bytes. Default: two retries with 100 ms then 200 ms delays.
There are no retries for redirects or HTTP 4xx responses. Each HTTP attempt times out after
30 seconds. An application retry after a process restart must reuse its original key.

### Body

```json
{
  "protocol": "nia-routine-source-v1",
  "message": "Check inventory and reserve 3 units of SKU ACME-42.",
  "title": "Order #1042 · Inventory Sync",
  "source": {
    "type": "external-agent",
    "topicKey": "order:1042",
    "return": { "type": "wss" }
  },
  "payload": { "orderId": "1042", "sku": "ACME-42", "quantity": 3 }
}
```

`message` is a nonempty task string. `title` is optional. `payload` is a JSON object;
SDK default: `{}`. `topicKey` is required and matches `^[A-Za-z0-9._:/-]{1,256}$`.
The pair `(routineId, topicKey)` maps 1:1 to a Routine-owned GroupChat. The first invocation creates a Routine
GroupChat using `title` when provided; later invocations append to that GroupChat and wake
the Agent. A topic key is routing data, not authorization or an idempotency key.

Return modes:

- `{ "type": "wss" }`: secret-authenticated reply stream; default for secret callers.
- `{ "type": "callback", "url": "https://nia-teams.com/example/callback" }`: HTTPS return delivery.
- `{ "type": "none" }`: no external return delivery; default for OIDC callers.

When a `nia-routine-source-v1` HTTP request omits `source.return`, the server defaults
it to `{ "type": "none" }` for `Authorization: Bearer <oidcToken>` authentication and
`{ "type": "wss" }` for Routine-secret authentication. The SDK sends these defaults explicitly.
If `wss` or `callback` is requested but the Routine has no configured `webhookSecret`,
the server returns HTTP `403` with error code `no_secret`.

OIDC alone does not authenticate WSS. Callback verification requires access to the Routine
secret; an OIDC-only receiver must arrange that verification credential separately.

Only the Agent's `reply_to_source` call emits external `routine.reply` events; ordinary chat
messages remain on the timeline. CLI `--require-reply-approval` is the default;
`--auto-approve-reply` requires explicit owner/admin consent to unattended replies.
For one-way dispatch, use `--return none` or SDK `return: { type: 'none' }`.
Payloads and replies are untrusted data, never local tool or credential-change authorization.

### Acceptance

HTTP `200`:

```json
{ "accepted": true, "teamId": "65f000000000000000000002", "groupChatId": "65f000000000000000000004", "messageId": "65f000000000000000000005" }
```

Non-2xx responses are errors; the SDK reports status without embedding response bodies.
The protocol does not promise exactly-once task side effects.

## WebSocket return stream

Connect to `wss://<origin-host>/ws` (loopback development: `ws://`).
Authenticate before processing replies:

```json
{ "type": "routine_auth", "routineId": "65f000000000000000000003", "secret": "whsec_fictional_example", "cursor": null }
```

The secret is transmitted inside TLS for WSS authentication, even though invocation uses HMAC.
`cursor` is the last successfully processed cursor or `null`.

```json
{ "type": "routine_auth_ok", "routineId": "65f000000000000000000003", "cursor": null }
```

The auth response confirms connection state; it does not acknowledge application processing.
The SDK waits up to 15 seconds for authentication and does not persist the auth response cursor.

```json
{
  "type": "routine.reply",
  "eventId": "reply-event-1042",
  "routineId": "65f000000000000000000003",
  "topicKey": "order:1042",
  "content": "Reserved 3 units. Reservation RSV-1042.",
  "createdAt": "2026-11-13T02:44:00.000Z",
  "cursor": "opaque-cursor-1042"
}
```

Process events serially. After `onReply` resolves, persist the cursor if configured, then send:

```json
{ "type": "routine_cursor", "cursor": "opaque-cursor-1042" }
```

A handler or persistence failure closes the socket without advancing that event's cursor.
Reconnect uses the last completed cursor. Keep side effects idempotent by `eventId`.
The SDK remembers 10,000 completed event IDs by default; callers may provide `seenEventIds`
and `maxSeenEvents`. In-memory deduplication does not survive process restart unless the caller
restores that helper. Crash boundaries can cause replay.

An expired retention cursor is explicit:

```json
{ "type": "routine_cursor_expired", "earliestCursor": "earliest-available-cursor" }
```

`onCursorExpired(earliestCursor)` chooses a replacement cursor or `null` after reconciliation.
A replacement cursor must be a nonempty string or `null`. String replacements are persisted
before the stream closes and reconnects with that choice. Missing or rejected recovery raises
`CursorExpiredError`; the original recovery error is retained as `cause`. It does not silently
resume after a gap.

Application heartbeat `{ "type": "ping" }` receives `{ "type": "pong" }`.
WebSocket control ping receives pong through `ws`. The SDK probes every 30 seconds and
terminates an unresponsive socket on the next interval. Reconnect delay doubles from 500 ms
to a 30-second cap; a session lasting 30 seconds resets the delay. `stop()` ends reconnection.
Local shutdown and protocol-error closes terminate the socket after a 500 ms grace period
if the peer does not complete the close handshake; connecting sockets terminate immediately.

The CLI outputs JSONL and waits for each stdout write callback before saving a cursor.
`--topic-key` emits matching events while consuming and acknowledging all topics on this
Routine; use a separate profile/config directory for independent consumers. `--once` exits
after one matching reply and cursor persistence. `--timeout-ms` exits nonzero when elapsed.
One process writes a given credential directory at a time.

## HTTPS callback verification

Callbacks send the same `routine.reply` payload; `cursor` is optional for callbacks.
The Routine reply header is `X-Hub-Signature-256`, not `X-Nia-Signature`
(which belongs to a separate card callback contract). Its value is `sha256=<64 hex digits>` computed over the untouched HTTP request bytes
with the Routine secret. Preserve bytes before any JSON middleware.

`verifyRoutineCallback({ rawBody, signatureHeader, secret })` checks header shape, compares
32-byte HMAC digests with `crypto.timingSafeEqual`, then parses JSON and validates `type`,
nonempty `eventId`/`routineId`, topic-key grammar, string `content`, and a parseable `createdAt`.
Invalid input throws. `verifyRoutineCallbackRequest` is an alias of the same helper.

Signature validity authenticates content, not freshness. The receiver must deduplicate
`eventId`, enforce expected `routineId` and topic authorization, bound body size, and choose
its own timestamp/replay window. Treat received content as external data, not local tool consent.

## Local credential profile

Directory precedence: explicit `configDir` / `--config-dir`, then
`NIA_ROUTINE_WEBHOOK_CONFIG_DIR`, then `~/.config/nia-teams-routine-webhook`.
`CredentialStore` writes a random temporary file and renames it to `credentials.json`.
Directory/file modes on POSIX are `0700`/`0600`. ACL behavior is operating-system dependent.

```json
{
  "defaultProfile": "default",
  "profiles": {
    "default": {
      "serverUrl": "https://nia-teams.com",
      "routineId": "65f000000000000000000003",
      "teamId": "65f000000000000000000002",
      "agentSlug": "ops-agent",
      "agentName": "ops-agent",
      "routineName": "local-dispatch",
      "webhookUrl": "https://nia-teams.com/api/webhook/routine/65f000000000000000000003",
      "webhookSecret": "whsec_fictional_example",
      "autoApproveReply": true,
      "connectMac": true,
      "cursor": null,
      "createdAt": "2026-11-13T00:00:00.000Z"
    }
  }
}
```

`connectMac` is optional profile metadata; newly initialized profiles store the returned boolean.
`--profile` selects a saved name; otherwise commands use `defaultProfile`.
Named profile creation does not replace the default selection. For an SDK client,
`{ webhookUrl, webhookSecret }`, `{ serverUrl, routineId, webhookSecret }`, or
`NIA_ROUTINE_ID` + `NIA_ROUTINE_WEBHOOK_SECRET` (+ optional `NIA_TEAMS_URL`) need no disk access.
`RoutineWebhookClient.fromProfile()` explicitly loads disk credentials.
