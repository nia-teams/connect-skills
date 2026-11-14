# Repository maintenance

## Documentation boundaries

- Root `README.md` / `README_CN.md`: repository-level skill catalog and quick install index.
- `skills/cloud-oidc/README.md` / `README_CN.md`: cloud access guides.
- `packages/routine-webhook/`: Node.js SDK, CLI, examples, tests, and human guides.
- `skills/<skill>/SKILL.md` and `references/`: installed AI contract, self-contained.
- This file: repository maintenance context.
- `docs/SPECIFICATION.md`: public HTTP and JWT wire contract.
- `npx skills add` installs `skills/<skill>/`; Markdown links inside `SKILL.md` and `references/` must resolve within that tree.
- npm SDK artifact references use inline `node_modules/<pkg>/...` paths after package installation, not relative Markdown links.
- SKILL frontmatter contains only `name` and `description`.
- Keep cloud-oidc at 70–90 lines; routine-webhook at 40–85 lines; agent-bridge at 40–70 lines.
- Platform commands and concise two-phase prompt templates belong in references.

## Contract invariants

- Supported targets: Alibaba Cloud RAM, Tencent Cloud CAM, Kubernetes OIDC RBAC.
- Issuer `https://nia-teams.com`; audience `nia-teams-workload`; RS256 JWKS `/oauth2/jwks`.
- Pairing returns canonical `agentSlug`; role key is `agent.<agentSlug>.<name>`.
- Cloud role names are independent of the Nia Teams role key.
- Resident trust accepts ordinary and elevated subjects; elevated trust accepts only elevated.
- Elevated tokens retain the resident Group and add `nia:elevated:role:<roleKey>`.
- Kubernetes bindings match effective username/group prefixes.
- Owner/admin human membership gates pairing, role configuration and elevation approval.
- Workload subjects/groups authorize external resources independently of human membership.
- Keep elevated ARNs exclusively in `elevationPrompt` (never in `systemPrompt`).
- Role prompts use the target Agent's working language and substituted deployment values.
- Cloud CLI administrator credentials stay local; setup and role tokens have separate purposes.
- Revocation covers external trust/bindings and outstanding STS sessions.

## Change and validation checklist

- Synchronize contract changes across root catalog, skill READMEs, skill, references and specification.
- Provider/policy/RBAC changes require target-specific human approval and live readback.
- Screenshots use real Web components, fictional identities and 2x Chromium rendering.
- Inspect all screenshots for clipping and ensure the close-up includes the composer.
- Install Python dependencies from `requirements-dev.txt`; Bash and jq are required.
- Run `python3 scripts/validate.py` and `git diff --check`.
- The validator checks layout, frontmatter, links, PNG dimensions, fenced syntax and trust JSON.
- In `packages/routine-webhook`, run `npm install`, `npm run typecheck`, `npm test`, and `npm pack --dry-run`.
- Keep root Routine skill and specification byte-identical to the package copies.
- Routine credentials route only Routine-owned chats by `(routineId, topicKey)`.
- Only `reply_to_source` emits replies; default approval and one-way return modes are explicit.
- Treat payloads and replies as untrusted data, never local tool authority.
- Package tests run local HTTP/WSS fixtures, not production credentials.
- Live cloud checks require a separately approved target and local credentials.
- Public release review and human preview approval are separate from a local commit.
