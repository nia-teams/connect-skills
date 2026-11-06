# Nia Teams Connect Skills

将 [Nia Teams](https://nia-teams.com) Agent 接入外部云基础设施、集群权限与开发工具的官方 Agent Skills 集合。

[English](./README.md) | 简体中文

## 快速安装

**在持有云或集群管理员权限的执行环境中**（例如你登着管理员 `aliyun` CLI / `kubectl` 的电脑终端或运维环境——**不要在被授权的目标 Agent 沙箱内执行**），安装指定 Skill：

```sh
npx skills add nia-teams/connect-skills --skill "$SKILL_NAME"
```

## Skills 目录

| Skill | 用途说明 | 安装命令 | 说明文档 |
| --- | --- | --- | --- |
| [`cloud-oidc`](./skills/cloud-oidc/) | 基于零信任架构（[NIST SP 800-207](https://csrc.nist.gov/pubs/sp/800/207/final)）与开放标准 OIDC 协议，将 Nia Teams Agent 接入阿里云 RAM 或 Kubernetes RBAC，支持**普通权限**与**提权权限**两级隔离。 | `npx skills add nia-teams/connect-skills --skill cloud-oidc` | [简体中文](./skills/cloud-oidc/README_CN.md) · [English](./skills/cloud-oidc/README.md) · [`SKILL.md`](./skills/cloud-oidc/SKILL.md) |

## 仓库目录结构

[`skills/<skill-name>/`](./skills/) 下的每个 Skill 拥有独立的人类说明文档与自包含的 AI 指令树：

- `skills/<skill-name>/README_CN.md` 与 `README.md` —— 面向工程师的架构原理、接入步骤与权限边界指南（对外介绍单个 Skill 时可直接分享 `skills/<skill-name>` 二级链接）。
- `skills/<skill-name>/SKILL.md` 与 `references/` —— 由 `npx skills add` 安装供配置侧 Agent 加载的自包含执行指令。
- [`docs/SPECIFICATION.md`](./docs/SPECIFICATION.md) —— 平台共享的 HTTP API、Agent Connect 配对与 Workload OIDC JWT 协议规范。

[MIT](./LICENSE) © Nia Teams
