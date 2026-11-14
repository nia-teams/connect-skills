---
name: agent-bridge
description: 把你的 AI（Claude Code、Codex、WorkBuddy、豆包、Antigravity、DeepSeek Harness 等）当成群成员拉进群聊，邀请朋友进群和你一起直接跟这个 AI 对话，解决用 AI 时环境配不通、满屏报错看不懂、死循环越改越乱、跟 AI 讲不清需求、截图问人也说不明白现场等各种问题。
---

# 拉本地 AI 进群协作

将当前运行在本机的 AI 作为群成员拉进 Nia Teams 群聊，让邀请码所属的朋友与用户一起在群里直接跟当前 AI 对话协作；模型推理、工作目录与工具执行留在本机。

## 输入参数

- `inviteCode`：邀请码；未知时向用户询问。
- `userName`：首次注册使用的用户显示名；无法从已知上下文确定时向用户询问。
- `agentName`：当前 AI 在群聊中的名字（1–60 字符），自行拟定。
- `cwd`：当前工作目录（`.`）。

本机已有同一服务端的配对凭证时，只需 `--invite-code`，复用原账号与 Agent 建新群。

## 安装与连接（Node.js 20+，豆包需 22+）

按当前运行的本地 AI 选择对应包安装并执行：

```sh
# Claude Code
npm install -g @nia-teams/claude-code-plugin
nia-claude connect --invite-code '<code>' --user-name '<user>' --agent-name '<agent>' --cwd '.'

# OpenAI Codex
npm install -g @nia-teams/codex-bridge
nia-codex connect --invite-code '<code>' --user-name '<user>' --agent-name '<agent>' --cwd '.'

# WorkBuddy / CodeBuddy
npm install -g @nia-teams/workbuddy-plugin
nia-workbuddy connect --invite-code '<code>' --user-name '<user>' --agent-name '<agent>' --cwd '.'

# 豆包（Doubao Work / Doubao CLI）
npm install -g @nia-teams/doubao-bridge
nia-doubao connect --invite-code '<code>' --user-name '<user>' --agent-name '<agent>' --cwd '.'

# Google Antigravity CLI
npm install -g @nia-teams/agy-bridge
nia-agy connect --invite-code '<code>' --user-name '<user>' --agent-name '<agent>' --cwd '.'

# DeepSeek Harness (DSH)
dsh plugin --profile web add @nia-teams/dsh-plugin
npx --prefix ~/.dsh/profiles/web nia-dsh connect --invite-code '<code>' --user-name '<user>' --agent-name '<agent>'
```

前五种工具的 `connect` 会启动后台守护进程并在浏览器打开 `handoffUrl`（该守护进程已在运行时加 `--no-start`）；DSH 执行 `connect` 后在工作目录后台运行 `dsh web`。远程机器或浏览器未能打开时，将输出的 `handoffUrl` 原样发给用户点击进群。

## 其他本地 AI

不属于以上六种工具时，在独立目录执行 `npm install @nia-teams/agent-bridge-core`，参考 `node_modules/@nia-teams/agent-bridge-core/dist/index.d.ts` 与 `examples/connect.mjs` 编写后台常驻脚本：调用 `connectWithInvite({ inviteCode, userName, agentName })` 完成建群并打开 `handoffUrl`，再用凭证构造 `new BridgeClient(credentials)`，在 `await bridge.start()` 前注册 `onThreadMessage` 与 `onThreadCancel`，通过 `bridge.rpc('group_chat.send_message', { sessionId: frame.sessionId, toolCallId: frame.deliveryId, content })` 回复群聊。
