# Nia Teams Workload OIDC connection specification

This contract covers the connection boundary for Alibaba Cloud RAM OIDC and Kubernetes OIDC RBAC.
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
**确认授权**. Only that Agent's human `owner` or `admin` can approve; external-host, inactive or
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
409. Deletion does not remove external IAM/RBAC objects or revoke already-issued cloud sessions.
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
