# Lifestream working agreement

## Before work

- This public implementation repository and `.private/` are independent Git roots. Inspect both statuses; preserve unrelated edits. Never stage `.private/`, private specifications, credentials, or private evidence in the public repository. Do not force-add ignored files.
- Read `BOOTSTRAP.md`, `implementation/checkpoint.json`, and the requested task, milestone, or batch in the private roadmap. One user request for that bounded outcome is sufficient to work through its normal dependency-ready slices; do not ask for repeated continuation or ratification.
- Read the roadmap's common material once at the start of a batch or material specification change. For each slice, read only its additional **Read first** material and mapped acceptance cases that have not already been read or that changed.
- Run `node scripts/workspace.mjs preflight LS-SNNN` before changing a slice. Preflight, packets, and the checkpoint check scope, prerequisites, worktree state, and resumability. They do not grant or withhold permission. If an aid is stale, update it within the requested work rather than asking for a new prompt.
- Treat packet file lists as the expected slice boundary. If ordinary implementation needs another closely related file, update the scope aid and continue. Stop only if the expansion materially changes the requested outcome or crosses a safety, privacy, compatibility, credential, live-effect, or repository boundary.

## Execution and evidence

- Preserve the specification's identity, trust, provider, memory, replay, and speech-hot-path boundaries. Do not silently invent a material safety, privacy, compatibility, data-ownership, retention, authority, or external-effect choice. Make routine reversible implementation choices and repair ordinary failures without stopping.
- Use deterministic fixtures; no live effects, production data, credentials, deployment, or external coordination without authorization.
- Run the selected packet's commands and acceptance cases. Record exact commands, revision, result, and durable evidence. Never turn planned checks, an empty suite, or specification validation into runtime acceptance.
- Update the checkpoint at slice start and after material validation. Keep completed-slice evidence, then continue automatically through the requested scope while prerequisites are satisfied.
- Stop only for a material scope/dependency conflict, an unresolved material product/safety/privacy/compatibility/data decision, unreproducible validation, credential or live/production-effect risk, or a genuine packet stop condition. Ask the smallest concrete question needed to continue.
- Local slice commits may preserve verified evidence within a requested bounded task, milestone, or batch. Pushes, releases, production activation, and specification publication require separate user direction. Use `codex/` for a requested new working branch; do not change an existing branch just for inspection.

## Commands and GitHub identity

Bootstrap checks: `node --test scripts/workspace.test.mjs` and `node scripts/workspace.mjs check`. Private specification checks: `npm --prefix .private ci` then `npm --prefix .private run validate`. Application commands do not exist until LS-S001.

For GitHub CLI operations on this project, scope credentials to the requested account without changing the global active account:

```sh
GH_TOKEN="$(gh auth token --user ggilchrest)" gh <arguments>
```

Never print a token, enable shell tracing around it, or store it in a file. If that account is unavailable, report the identity/access issue instead of silently using another account.
