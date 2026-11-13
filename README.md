# Nia Teams Connect Skills

Connect [Nia Teams](https://nia-teams.com) cloud Agents to cloud infrastructure, clusters, and external applications.

[Chinese documentation](./README_CN.md)

```sh
npx skills add nia-teams/connect-skills --skill "$SKILL_NAME"
```

AI assistants load `skills/<name>/SKILL.md` after installation. For the npm package, load `node_modules/@nia-teams/routine-webhook/skills/routine-webhook/SKILL.md`.

## Skills

| Skill | Purpose | Documentation |
| --- | --- | --- |
| [`cloud-oidc`](./skills/cloud-oidc/) | Zero-trust cloud and cluster access via OIDC, with ordinary and human-approved elevated permissions for Alibaba Cloud, Tencent Cloud, and Kubernetes. | [English](./skills/cloud-oidc/README.md) · [Chinese](./skills/cloud-oidc/README_CN.md) · [AI instructions](./skills/cloud-oidc/SKILL.md) |
| [`routine-webhook`](./skills/routine-webhook/) · [`@nia-teams/routine-webhook`](./packages/routine-webhook/) (CLI & TypeScript SDK) | Invoke a Nia Teams cloud Agent by `topicKey` from external scripts, backend services, or local coding agents; receive verified `routine.reply` events over WebSocket or HTTPS callbacks (Node.js 20+). | [English](./packages/routine-webhook/README.md) · [Chinese](./packages/routine-webhook/README_CN.md) · [AI instructions](./skills/routine-webhook/SKILL.md) |

## Execution Environments

- **cloud-oidc** runs in an environment holding cloud or cluster administrator credentials through `aliyun`, `tccli`, or `kubectl`. Keep those credentials local and remove temporary administrator credentials after setup and verification.
- **routine-webhook** runs in an external script, service, or local coding assistant environment with Node.js 20+. Its SDK and CLI are published as [`@nia-teams/routine-webhook`](./packages/routine-webhook/): `npm install @nia-teams/routine-webhook`.
- Neither skill runs inside the target Nia Teams cloud Agent sandbox being connected. Browser pairing requires that Agent's human owner or admin.

## Repository Layout

- `skills/`: self-contained AI instructions installed by `npx skills add`.
- [`packages/routine-webhook/`](./packages/routine-webhook/): npm SDK, CLI, examples, and human documentation.
- [Specification](./docs/SPECIFICATION.md): shared pairing, Workload OIDC, authorization roles, and Routine protocols.
- [Maintenance](./AGENTS.md): validation and change boundaries.

[MIT](./LICENSE) © Nia Teams
