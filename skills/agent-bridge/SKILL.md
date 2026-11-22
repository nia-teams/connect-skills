---
name: agent-bridge
description: Use when a user wants to connect a local AI assistant (Claude Code, Codex, WorkBuddy, CodeBuddy, Doubao, Antigravity, Factory Droid, Pi Coding Agent, DeepSeek Harness, or another host) to a Nia Teams GroupChat with WeChat, or bring a paired Agent into another chat.
---

# Connect a local AI to Nia Teams

Pair this local AI as a remote Agent in a Nia Teams GroupChat. Friends can collaborate with the Agent in the chat; model inference and tools still run on the local AI host in the selected working directory.

## Choose the chat

- To join an existing GroupChat, use `--group-link '<group-invite-url>'`. Use the full `/join/<token>` invite URL; a `/share/<token>` link is read-only. If the user asks to join a chat but supplies no invite URL, ask for it. The invite joins both the user and this Agent.
- To create a new GroupChat with the user and this Agent, omit `--group-link`.
- Use `--agent-name '<agent>'` if a display name is wanted for the new Agent.

## Run on the local AI host

Use Node.js 20+ (22+ for Doubao). Select the matching adapter and run its commands from the project directory. For npm adapters the syntax is `<nia-cli> connect [--group-link '<group-invite-url>'] [--agent-name '<agent>'] --cwd '.'`. DeepSeek Harness uses `npx --prefix ~/.dsh/profiles/web nia-dsh connect [--group-link '<group-invite-url>'] [--agent-name '<agent>']` from the project directory.

```sh
# Claude Code
npm install -g @nia-teams/claude-code-plugin
nia-claude connect --cwd '.'

# Codex
npm install -g @nia-teams/codex-bridge
nia-codex connect --cwd '.'

# WorkBuddy / CodeBuddy
npm install -g @nia-teams/workbuddy-plugin
nia-workbuddy connect --cwd '.'

# Doubao (豆包)
npm install -g @nia-teams/doubao-bridge
nia-doubao connect --cwd '.'

# Antigravity
npm install -g @nia-teams/agy-bridge
nia-agy connect --cwd '.'

# Factory Droid
npm install -g @nia-teams/droid-bridge
nia-droid connect --cwd '.'

# Pi Coding Agent
npm install -g @nia-teams/pi-bridge
nia-pi connect --cwd '.'

# DeepSeek Harness (DSH)
dsh plugin --profile web add @nia-teams/dsh-plugin
npx --prefix ~/.dsh/profiles/web nia-dsh connect
# After connect completes, run dsh web in the background.
dsh web
```

## WeChat scan and browser handoff

- **First connection:** `connect` displays a QR code in the terminal. Ask the user to scan it with WeChat while `connect` waits. The scan registers or reuses their Nia Teams account, pairs this Agent, and adds both to the selected chat.
- **Credentials already saved on this machine:** Run `connect` with the same chat selection rules. It reuses the local Agent and requires no new scan.
- **After connection:** The CLI saves credentials and starts the background daemon (except DSH, which uses `dsh web`). It opens `handoffUrl` in the browser. On a remote or headless host, give the user the printed `handoffUrl` to enter the chat.

## Other local AI hosts

Install `@nia-teams/agent-bridge-core` in your integration project. Read `node_modules/@nia-teams/agent-bridge-core/skills/agent-bridge-core/SKILL.md` and `node_modules/@nia-teams/agent-bridge-core/examples/wechat-connect.mjs`; use `node_modules/@nia-teams/agent-bridge-core/dist/index.d.ts` for types. Call `connectWithWeChat({ groupLink?, agentName? })` to connect, then start `BridgeClient` in the background with the returned credentials.
