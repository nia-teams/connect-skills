# Nia Teams Connect Skills

Connect local AI assistants to [Nia Teams](https://nia-teams.com) GroupChats, and cloud Agents to infrastructure, clusters, and external applications.

[Chinese documentation](./README_CN.md)

```sh
npx skills add nia-teams/connect-skills --skill "$SKILL_NAME" -y
```

AI assistants load `skills/<name>/SKILL.md` after installation. For the npm package, load `node_modules/@nia-teams/routine-webhook/skills/routine-webhook/SKILL.md`.

## Skills

| Skill | Purpose | Documentation |
| --- | --- | --- |
| [`agent-bridge`](./skills/agent-bridge/) | Connect a local AI assistant to a GroupChat as a remote Agent with one WeChat scan. | [AI instructions](./skills/agent-bridge/SKILL.md) |
| [`cloud-oidc`](./skills/cloud-oidc/) | Zero-trust cloud and cluster access via OIDC, with ordinary and human-approved elevated permissions for Alibaba Cloud, Tencent Cloud, and Kubernetes. | [English](./skills/cloud-oidc/README.md) · [Chinese](./skills/cloud-oidc/README_CN.md) · [AI instructions](./skills/cloud-oidc/SKILL.md) |
| [`routine-webhook`](./skills/routine-webhook/) · [`@nia-teams/routine-webhook`](./packages/routine-webhook/) (CLI & TypeScript SDK) | Invoke a Nia Teams cloud Agent by `topicKey` from external scripts, backend services, or local coding agents; receive verified `routine.reply` events over WebSocket or HTTPS callbacks (Node.js 20+). | [English](./packages/routine-webhook/README.md) · [Chinese](./packages/routine-webhook/README_CN.md) · [AI instructions](./skills/routine-webhook/SKILL.md) |

## Local AI quick start

```sh
npx skills add nia-teams/connect-skills --skill agent-bridge -y
```

Follow the [adapter instructions](./skills/agent-bridge/SKILL.md) to run `connect` on the local AI host. Scan the QR code shown in the terminal with WeChat to register or reuse your Nia Teams account and pair the Agent.

Pass `--group-link` with a `/join/<token>` invite URL to add both you and the Agent to an existing GroupChat. A `/share/<token>` URL is read-only. Omit the option to create a new GroupChat with the Agent. Later runs on the same machine reuse saved credentials without another scan.

## Execution Environments

- **agent-bridge** runs on the local AI host (Node.js 20+, or 22+ for Doubao).
- **cloud-oidc** runs in an environment holding cloud or cluster administrator credentials through `aliyun`, `tccli`, or `kubectl`. Keep those credentials local and remove temporary administrator credentials after setup and verification.
- **routine-webhook** runs in an external script, service, or local coding assistant environment with Node.js 20+. Its SDK and CLI are published as [`@nia-teams/routine-webhook`](./packages/routine-webhook/): `npm install @nia-teams/routine-webhook`.
- None of these skills run inside the target cloud Agent sandbox.

## Repository Layout

- `skills/`: self-contained AI instructions installed by `npx skills add`.
- [`packages/routine-webhook/`](./packages/routine-webhook/): npm SDK, CLI, examples, and human documentation.
- [Specification](./docs/SPECIFICATION.md): shared pairing, Workload OIDC, authorization roles, and Routine protocols.
- [Maintenance](./AGENTS.md): validation and change boundaries.

[MIT](./LICENSE) © Nia Teams
