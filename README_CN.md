# Nia Teams Connect Skills

将 [Nia Teams](https://nia-teams.com) 云端 Agent 接入云基础设施、集群与外部应用。

[English](./README.md)

```sh
npx skills add nia-teams/connect-skills --skill "$SKILL_NAME"
```

编程助手安装后加载 `skills/<name>/SKILL.md`；npm 包内路径为 `node_modules/@nia-teams/routine-webhook/skills/routine-webhook/SKILL.md`。

## 技能目录

| 技能 | 用途 | 说明文档 |
| --- | --- | --- |
| [`cloud-oidc`](./skills/cloud-oidc/) | 通过 OIDC 为 Agent 提供零信任云与集群访问，支持阿里云、腾讯云和 Kubernetes，区分普通权限与人工批准的提权权限。 | [中文](./skills/cloud-oidc/README_CN.md) · [英文](./skills/cloud-oidc/README.md) · [助手指引](./skills/cloud-oidc/SKILL.md) |
| [`routine-webhook`](./skills/routine-webhook/) · [`@nia-teams/routine-webhook`](./packages/routine-webhook/) (命令行工具与 TypeScript SDK) | 外部脚本、后端服务或本地编程助手按 `topicKey` 调用 Nia Teams 云端 Agent，通过 WebSocket 或 HTTPS 回调接收经过验证的 `routine.reply` 事件（Node.js 20+）。 | [中文](./packages/routine-webhook/README_CN.md) · [英文](./packages/routine-webhook/README.md) · [助手指引](./skills/routine-webhook/SKILL.md) |

## 执行环境

- **cloud-oidc** 在持有云或集群管理员凭证的环境中运行，使用 `aliyun`、`tccli` 或 `kubectl`。管理员凭证留在本地，配置与实测结束后移除临时管理员凭证。
- **routine-webhook** 在外部脚本、服务或本地编程助手环境中运行，需要 Node.js 20+。SDK 与命令行工具发布为 [`@nia-teams/routine-webhook`](./packages/routine-webhook/)，安装命令为 `npm install @nia-teams/routine-webhook`。
- 两项技能均不在被连接的目标 Nia Teams 云端 Agent 沙箱内运行。浏览器配对需由该 Agent 的人类 owner 或 admin 确认。

## 仓库结构

- `skills/`：由 `npx skills add` 安装的自包含助手指引。
- [`packages/routine-webhook/`](./packages/routine-webhook/)：npm SDK、命令行工具、示例与工程师文档。
- [协议规范](./docs/SPECIFICATION.md)：共享配对、Workload OIDC、授权角色与 Routine 协议。
- [维护说明](./AGENTS.md)：验证命令与修改边界。

[MIT](./LICENSE) © Nia Teams
