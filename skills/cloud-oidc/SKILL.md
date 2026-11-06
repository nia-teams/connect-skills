---
name: cloud-oidc
description: Use when connecting a Nia Teams Agent to Alibaba Cloud RAM OIDC or Kubernetes OIDC RBAC via standard Workload OIDC, configuring ordinary permissions, human-confirmed elevated permissions, role prompts, and live token verification from an environment holding cloud administrator credentials.
---

# Zero-Trust Cloud Access for Agents (`cloud-oidc`)

A Nia Teams Agent’s cloud identity is an AuthorizationRole (`agent.<agentSlug>.<name>`).
External cloud IAM or Kubernetes RBAC trusts its standard OIDC subjects `role:<key>` (ordinary tier) and `role:<key>:elevated` (elevated tier).
Run this skill in the environment holding cloud/cluster administrator CLI credentials—never inside the target Agent being authorized.

## Scope & References

Execute from an authenticated administrator `aliyun` CLI or `kubectl` environment.
Administrator credentials stay in the provisioning environment; Nia Teams stores AuthorizationRole instructions.
Installed resources resolve relative to this file:
- Alibaba Cloud RAM: [references/aliyun.md](references/aliyun.md).
- Kubernetes OIDC RBAC: [references/kubernetes.md](references/kubernetes.md).
Confirm account/cluster, region/namespace, ordinary permission scope, elevated permission scope, and role name.
The suffix `name` matches `/^[a-z0-9][a-z0-9-]{0,31}$/`; cloud role names are separate objects.

## Agent Pairing & Authorization-Role API

Start pairing using the provisioning client's actual label:
```bash
curl -fsS -X POST https://nia-teams.com/api/agent-connect/start \
  -H 'Content-Type: application/json' -d '{"clientLabel":"Claude Code"}'
```
Present `verificationUrl` (`https://nia-teams.com/connect/:code`) to the human.
The browser selects the target native Agent; its owner/admin clicks **确认授权**.
Retain `connectId` and `pollSecret` privately; poll serially every two seconds:
```bash
curl -fsS --get https://nia-teams.com/api/agent-connect/status \
  --data-urlencode "reference=${connectId}" --data-urlencode "pollSecret=${pollSecret}"
```
The single-use approved result supplies `teamId`, canonical `agentSlug`, and `workloadToken`.
Save that result before another poll; `expired` requires a fresh pairing.
Use its `elevation_kind: "agent-connect"` setup bearer for the selected Agent's role API:
`GET /api/teams/:teamId/authorization-roles` reads existing configuration;
`PUT /api/teams/:teamId/authorization-roles/:name` upserts the role and binding.
Send all three fields: `systemPrompt`, `elevationPrompt`, `sessionElevationEnabled`.
PUT returns `role` and `tokens`; GET the collection again to verify stored values.

## Identity Matrix & Two-Tier Permissions

Derive `ROLE_KEY = agent.<agentSlug>.<name>` from the pairing result.
Standard OIDC Issuer: `https://nia-teams.com`; audience: `nia-teams-workload`; RS256 JWKS: `/oauth2/jwks`.
- **Tier 1 (Ordinary permissions)**: IAM trust accepts `role:<ROLE_KEY>` and `role:<ROLE_KEY>:elevated`; Kubernetes Group binding uses `role:<ROLE_KEY>`.
- **Tier 2 (Elevated permissions)**: IAM trust accepts only `role:<ROLE_KEY>:elevated`; Kubernetes Group binding uses `nia:elevated:role:<ROLE_KEY>` (elevated tokens retain the ordinary group).
Enable Tier 1 alone (`sessionElevationEnabled: false`, `elevationPrompt: ""`), Tier 2 alone (`sessionElevationEnabled: true`, zero standing cloud access), or both tiers together (`sessionElevationEnabled: true`).
Human owner/admin membership gates pairing, role configuration and TaskBar elevation approval;
cloud IAM / Kubernetes RBAC enforces workload access independently.

## Two-Phase Role Prompt Authoring

Write in the target Agent's working language, matching the reference templates' concise factual style.
Substitute approved account IDs, ARNs, regions, endpoint/CA paths and the exact role key.
`systemPrompt` states identity, ordinary scope, and executable commands using `nia role-token <ROLE_KEY>` when Tier 1 is enabled; when only Tier 2 is enabled, state the gated scope and zero standing access.
Whenever Tier 2 is enabled (`sessionElevationEnabled: true`), require stating target object, action and side effects in `systemPrompt` before calling `request_session_elevation`.
`elevationPrompt` (empty when Tier 2 is disabled) contains the elevated ARN or RBAC scope and executable elevated commands;
elevated ARNs belong exclusively here. Owner/admin approval delivers this prompt with the elevated identity.

## Provisioning & Live Verification

Inspect CLI identity, providers, trust, policies and bindings before writes.
Confirm target objects, policy changes and side effects with the human, then provision the reviewed plan.
Read back changed objects and attached policies; reconcile existing grants when updating tiers.
Use `tokens.roleToken` and `tokens.elevatedRoleToken` from PUT for live checks, isolated from admin CLI auth.
Alibaba: exchange via OIDC role assumption (`aliyun sts GetCallerIdentity --mode OIDC`);
Kubernetes: `kubectl auth can-i` with explicit server, CA and token.
Verify enabled tiers: ordinary token succeeds on Tier 1 and is denied on Tier 2;
elevated token succeeds on Tier 2 (and retains Tier 1 when both are enabled).
Use non-mutating permission probes and check an out-of-scope resource as well as allowed resources.
Report actual test results, provisioned objects and any unavailable live checks.
Keep tokens and STS credentials in memory or private temporary files.
Revocation reconciles external trust/bindings and outstanding STS sessions as well as the Nia Teams role.
