# Development handoff

## Two repositories, two gates

The public checkout is `ggilchrest/lifestream`. The independently versioned specification is `ggilchrest/lifestream-specs`, checked out at `.private/`. The committed `.gitignore` protects this boundary on fresh clones; a Git ignore is an accident-prevention measure, not a security boundary against force-add or copying content.

Public CI checks bootstrap structure and regression tests without accessing private content. Private CI runs the complete specification validator, including slice reading lists and packets. Neither check is runtime acceptance. Do not add private checkout credentials to public pull-request workflows, use `pull_request_target` to run untrusted code, or upload private validation output to public artifacts.

## Establish the private baseline

1. Inspect both Git roots, origins, branches, and dirty state. Never replace an existing `.private` directory or discard changes.
2. If it is absent and access is authorized, use the `ggilchrest`-scoped GitHub CLI to clone `ggilchrest/lifestream-specs` into `.private`. Fetch only when requested/needed; do not silently follow `main` as the implementation target.
3. Review corrections and proposed decisions. Run `npm ci`, `npm run validate`, and `git diff --check` inside the private repository. Arrange its commit/publication with user authorization. Approval of a reference baseline does not ratify every Proposed choice or resolve unrelated Open decisions.
4. Keep the private specification checkout available locally and run its validation when changing specification content. The private checkout is a working specification source, not an immutable implementation-admission gate.
5. Run local preflight; the tool verifies the public checkpoint, packet scope, prerequisites, and current worktree without requiring a specification pin.

The former `spec-lock.json` is retained only as historical metadata and is not consulted by implementation preflight.

## Slice and batch handoff

`implementation/checkpoint.json` is the actual implementation state; the private Markdown checkpoint is only a format/runbook reference. It starts blocked, with no active or completed slices and no allowed application writes.

The private repository contains the roadmap, explicit readings for all slices, and the available packet files. `npm --prefix .private run slice-packet -- LS-SNNN` displays a slice's source inputs. A packet is a scope aid for the current batch, not a specification pin or publication gate.

The default operating unit is now an explicitly authorized dependency-ordered batch. A batch is a user-approved sequence of individually packeted slices. Codex must update the live checkpoint after every slice, but must continue automatically through the batch after each slice verifies. The user is not expected to send conversational continuation prompts between slices.

When the user requests a slice or batch:

1. Review every packet and prerequisite in the requested batch at the current private checkout. Record the actual public branch, base/current revision, active slice, and the current packet's exact allowed files in the checkpoint. Preserve prior evidence and unrelated work. Clear only resolved blockers.
2. Run `node scripts/workspace.mjs preflight LS-S001` (or the requested ID). The tool is read-only: it neither authorizes work nor edits state. Failed checks block coding. Dependency receipts live in `implementation/evidence/LS-SNNN.json`; each names `slice`, `status: verified`, a full public commit, and nonempty passing `checks` with command and evidence. Reviewers still need to inspect that evidence; receipt syntax alone is not correctness proof.
3. Execute exactly the current packet's goal; run its commands and mapped acceptance cases. After verification, update the checkpoint and continue to the next explicitly authorized packet without waiting for user input. The first slice creates/pins application tooling; bootstrap CI's Node version is not a product architecture decision.
4. Record changed files, command results, evidence and next action for every slice. Distinguish `implemented` from `verified`. Commit only when directed. Do not mark a slice verified or advance based on specification checks alone.

Before public publication, review every staged path and its content for private material. Copying any private contracts for LS-S002 needs an explicit approved public export set; private repository access alone is not permission to publish them.

## Checks

```sh
node --test scripts/workspace.test.mjs
node scripts/workspace.mjs check
npm --prefix .private ci
npm --prefix .private run validate
node scripts/workspace.mjs preflight LS-S001
```

The last command currently exits nonzero by design. No bypass flag exists. Hosted CI has not run merely because its workflow file exists; workflows become active only after authorized publication. Application CI must be added with LS-S001 and its real package scripts.

Repository-level `AGENTS.md` is deliberately concise; exact changing slice details stay in the pinned packet and checkpoint, following [official OpenAI guidance on project instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
