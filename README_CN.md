# Nia Teams Connect Skills

将本地 AI 接入 [Nia Teams](https://nia-teams.com) 群聊，将云端 Agent 接入云基础设施、集群与外部应用。

[English](./README.md)

```sh
npx skills add nia-teams/connect-skills --skill "$SKILL_NAME" -y
```

编程助手安装后加载 `skills/<name>/SKILL.md`；npm 包内路径为 `node_modules/@nia-teams/routine-webhook/skills/routine-webhook/SKILL.md`。

## 技能目录

| 技能 | 用途 | 说明文档 |
| --- | --- | --- |
| [`agent-bridge`](./skills/agent-bridge/) | 微信扫码一次，将本地 AI 配对为远程 Agent 并加入群聊。 | [助手指引](./skills/agent-bridge/SKILL.md) |
| [`cloud-oidc`](./skills/cloud-oidc/) | 通过 OIDC 为 Agent 提供零信任云与集群访问，支持阿里云、腾讯云和 Kubernetes，区分普通权限与人工批准的提权权限。 | [中文](./skills/cloud-oidc/README_CN.md) · [英文](./skills/cloud-oidc/README.md) · [助手指引](./skills/cloud-oidc/SKILL.md) |
| [`routine-webhook`](./skills/routine-webhook/) · [`@nia-teams/routine-webhook`](./packages/routine-webhook/) (命令行工具与 TypeScript SDK) | 新建话题会唤醒 Nia Teams Agent；已有话题支持静默发消息。通过 WebSocket 或 HTTPS 回调接收已验证的回信（Node.js 20+）。 | [中文](./packages/routine-webhook/README_CN.md) · [英文](./packages/routine-webhook/README.md) · [助手指引](./skills/routine-webhook/SKILL.md) |

## 本地 AI 快速接入

```sh
npx skills add nia-teams/connect-skills --skill agent-bridge -y
```

按[适配器指引](./skills/agent-bridge/SKILL.md)在本地 AI 所在机器运行 `connect`。用微信扫描终端显示的二维码，注册或复用 Nia Teams 账号，并配对 Agent。

通过 `--group-link` 传入 `/join/<token>` 邀请链接，可让你和 Agent 一起加入已有群聊。`/share/<token>` 链接仅供查看。不传此选项则新建一个你和 Agent 的群聊。同一台机器上再次运行时会复用已保存的凭证，不必再扫码。

## 执行环境

- **agent-bridge** 在本地 AI 所在机器运行（Node.js 20+，豆包为 22+）。
- **cloud-oidc** 在持有云或集群管理员凭证的环境中运行，使用 `aliyun`、`tccli` 或 `kubectl`。管理员凭证留在本地，配置与实测结束后移除临时管理员凭证。
- **routine-webhook** 在外部脚本、服务或本地编程助手环境中运行，需要 Node.js 20+。SDK 与命令行工具发布为 [`@nia-teams/routine-webhook`](./packages/routine-webhook/)，安装命令为 `npm install @nia-teams/routine-webhook`。
- 以上技能均不在目标云端 Agent 沙箱内运行。

## 仓库结构

- `skills/`：由 `npx skills add` 安装的自包含助手指引。
- [`packages/routine-webhook/`](./packages/routine-webhook/)：npm SDK、命令行工具、示例与工程师文档。
- [协议规范](./docs/SPECIFICATION.md)：共享配对、Workload OIDC、授权角色与 Routine 协议。
- [维护说明](./AGENTS.md)：验证命令与修改边界。

[MIT](./LICENSE) © Nia Teams
