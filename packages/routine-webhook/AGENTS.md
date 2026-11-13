# Maintainer context

Part of `nia-teams/connect-skills`; root `AGENTS.md` covers the shared repository.

## Modules

- `src/client.ts`: disk-free invocation and transport selection.
- `src/provision.ts`: agent-connect and scoped Routine administration.
- `src/store.ts`: local named profiles; no setup bearer serialization.
- `src/stream.ts`: serial reply handling, replay cursor, heartbeat, reconnect.
- `src/callback.ts`: raw-byte HMAC and reply validation.
- `src/http.ts`: URL trust boundary, no-redirect HTTP, bounded retry.
- `src/types.ts`: public wire and profile types.
- `bin/nia-routine-webhook.mjs`: CLI only; stdout JSON, diagnostics stderr.

Node.js 20+, ESM. Runtime dependency: `ws`; do not import browser-only APIs.
Direct SDK construction stays disk-free. `fromProfile` opts into disk access.

## Invariants

- Protocol is `nia-routine-source-v1`; `(routineId, topicKey)` selects the topic.
- HMAC signs the exact serialized bytes; retries retain body and idempotency key.
- Choose one invocation auth mode. WSS requires the Routine secret.
- Validate origins before sending credentials; reject redirects on HTTP and WSS.
- Setup bearer and poll secret remain in memory; discard bearer references after use.
- Atomic profile writes use a random temporary file and rename, modes `0700`/`0600`.
- One process writes a config directory at a time; do not imply multiwriter transactions.
- Acknowledge cursors only after handler and optional persistence succeed.
- Handler failure blocks later queued replies; expired history needs explicit recovery.
- Replies are external data, not permission grants. Callback signatures are not replay prevention.

## Synchronization

For API changes, update types, SDK, CLI, local-server tests, examples, both READMEs,
`skills/routine-webhook/SKILL.md`, and `docs/SPECIFICATION.md` together.
Keep README TypeScript blocks byte-identical to their runnable example files.
Root `skills/routine-webhook/SKILL.md` and `docs/SPECIFICATION.md` are the sources;
copy them byte-for-byte into this package and run root `python3 scripts/validate.py`.
Preserve the AI reading pointer in `dist/index.d.ts` and ship skill/spec/examples/assets.
Use fictional screenshot identities and real React product components at 2x.
Governance defaults come from the Nia Teams organization; license is MIT.

## Verification

```sh
npm ci
npm run typecheck
npm run build
npm test
npm pack --dry-run
```

Tests use local HTTP/WebSocket servers and CLI subprocesses, not production credentials.
Review package file lists and public identity hygiene before release.
Remote creation, signed pushes, and npm publishing require human review and approval.
