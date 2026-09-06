# Lifestream working agreement

## Before work

- This public implementation repository and `.private/` are independent Git roots. Inspect both statuses; preserve unrelated edits. Never stage `.private/`, private specifications, credentials, or private evidence in the public repository. Do not force-add ignored files.
- Read `BOOTSTRAP.md` and `implementation/checkpoint.json`. For implementation, run `node scripts/workspace.mjs preflight LS-SNNN` for the explicitly requested slice. A blocked preflight means stop implementation and report the smallest unresolved condition; do not weaken the packet or checkpoint to make it pass.
- Spec review and bootstrap maintenance may proceed while implementation is blocked. They do not complete an application slice.
- Read the current private roadmap's common reading list and each selected slice's **Read first**, **Acceptance cases**, and packet. Work in an explicitly authorized, dependency-ordered batch; IDs are not execution order. All hard prerequisites need verified evidence.
- Confirm the reviewed packets and checkpoint name the exact writable files for the current slice. Component descriptions and packet previews are not a writable-file allowlist. Amend scope explicitly before touching another file.

## Execution and evidence

- Preserve the specification's identity, trust, provider, memory, replay, and speech-hot-path boundaries. Do not invent missing contracts or silently resolve Open/Deferred decisions. Proposed reference choices are not production acceptance.
- Use deterministic fixtures; no live effects, production data, credentials, deployment, or external coordination without authorization.
- Run the selected packet's commands and acceptance cases. Record exact commands, revision, result, and durable evidence. Never turn planned checks, an empty suite, or specification validation into runtime acceptance.
- Update the checkpoint at slice start and after material validation. Keep completed-slice evidence. Within an explicitly authorized batch, auto-advance to the next packet after the current slice is verified; do not wait for conversational continuation.
- Stop the batch only for a material scope/dependency conflict, unresolved product or specification decision, unreproducible install or validation, credential/production-effect risk, required human review, or another packet stop condition. Routine implementation failures should be repaired within the authorized scope.
- Commit/push, releases, and specification publication require user direction. Use `codex/` for a requested new working branch; do not change an existing branch just for inspection.

## Commands and GitHub identity

Bootstrap checks: `node --test scripts/workspace.test.mjs` and `node scripts/workspace.mjs check`. Private specification checks: `npm --prefix .private ci` then `npm --prefix .private run validate`. Application commands do not exist until LS-S001.

For GitHub CLI operations on this project, scope credentials to the requested account without changing the global active account:

```sh
GH_TOKEN="$(gh auth token --user ggilchrest)" gh <arguments>
```

Never print a token, enable shell tracing around it, or store it in a file. If that account is unavailable, report the identity/access issue instead of silently using another account.
