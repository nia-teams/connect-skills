# Nia Teams Connect Skills

Official Agent skills for connecting [Nia Teams](https://nia-teams.com) Agents to external cloud infrastructure, cluster authorization, and developer tools.

English | [简体中文](./README_CN.md)

## Quick Install

Run the install command **in the environment that already holds cloud or cluster administrator permissions** (such as a workstation or ops environment authenticated with administrator `aliyun` CLI / `kubectl`—**not inside the target Agent being authorized**):

```sh
npx skills add nia-teams/connect-skills --skill "$SKILL_NAME"
```

## Available Skills

| Skill | Description | Install Command | Documentation |
| --- | --- | --- | --- |
| [`cloud-oidc`](./skills/cloud-oidc/) | Connect a Nia Teams Agent to Alibaba Cloud RAM or Kubernetes RBAC following Zero Trust Architecture ([NIST SP 800-207](https://csrc.nist.gov/pubs/sp/800/207/final)) and the open OIDC standard, with two-tier privilege separation (**ordinary permissions** and **elevated permissions**). | `npx skills add nia-teams/connect-skills --skill cloud-oidc` | [English](./skills/cloud-oidc/README.md) · [简体中文](./skills/cloud-oidc/README_CN.md) · [`SKILL.md`](./skills/cloud-oidc/SKILL.md) |

## Repository Layout

Each skill under [`skills/<skill-name>/`](./skills/) includes its own human documentation and self-contained AI instruction tree:

- `skills/<skill-name>/README.md` & `README_CN.md` — Human architecture, setup walkthrough, and permission boundary guide (shareable directly as the skill entry URL).
- `skills/<skill-name>/SKILL.md` & `references/` — Self-contained instructions loaded by the provisioning Agent via `npx skills add`.
- [`docs/SPECIFICATION.md`](./docs/SPECIFICATION.md) — Shared HTTP API, Agent Connect pairing, and Workload OIDC JWT specification.

[MIT](./LICENSE) © Nia Teams
