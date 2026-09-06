# Development handoff

## Two repositories, two gates

The public checkout is `ggilchrest/lifestream`. The independently versioned specification is `ggilchrest/lifestream-specs`, checked out at `.private/`. The committed `.gitignore` protects this boundary on fresh clones; a Git ignore is an accident-prevention measure, not a security boundary against force-add or copying content.

Public CI checks bootstrap structure and regression tests without accessing private content. Private CI runs the complete specification validator, including slice reading lists and packets. Neither check is runtime acceptance. Do not add private checkout credentials to public pull-request workflows, use `pull_request_target` to run untrusted code, or upload private validation output to public artifacts.

## Establish the private baseline

1. Inspect both Git roots, origins, branches, and dirty state. Never replace an existing `.private` directory or discard changes.
2. If it is absent and access is authorized, use the `ggilchrest`-scoped GitHub CLI to clone `ggilchrest/lifestream-specs` into `.private`. Fetch only when requested/needed; do not silently follow `main` as the implementation target.
3. Review corrections and proposed decisions. Run `npm ci`, `npm run validate`, and `git diff --check` inside the private repository. Arrange its commit/publication with user authorization. Approval of a reference baseline does not ratify every Proposed choice or resolve unrelated Open decisions.
4. Record the exact full private commit in `spec-lock.json.revision`, the SHA-256 of that commit's `contracts/contract-manifest.json`, and a real human review record (`reviewer`, UTC `reviewedAt`, and an evidence reference). Set status to `pinned` only then. `baseRevision` records historical provenance; it is never a fallback target. Do not put private review text in this public metadata.
5. Use an independent clean checkout at that exact revision. Pin changes are reviewed specification migrations, never automatic repairs. Run local preflight; the tool verifies the repository, revision, clean state, manifest digest, checkpoint schema, and full private validation before admitting a slice.

The current lock pins the reviewed specification commit `adfed6cc78f65fd3b6c5938723943ac424d84dfd`. Future specification changes require a newly reviewed, published commit and matching manifest digest; a branch name, `WORKTREE`, or a digest of uncommitted files cannot replace an immutable target.

## Slice handoff

`implementation/checkpoint.json` is the actual implementation state; the private Markdown checkpoint is only a format/runbook reference. It starts blocked, with no active or completed slices and no allowed application writes.

The pinned private repository contains the roadmap, explicit readings for all slices, and `roadmap/packets/LS-S001.json`. That first packet is a prepared scope, not permission to execute. `npm --prefix .private run slice-packet -- LS-S001` displays its source inputs. For later slices, produce and review an exact packet in the private repository before pinning the applicable baseline; a roadmap preview alone is not executable authority.

When the user requests a slice:

1. Review its packet and prerequisites at the locked revision. Record the actual public branch, base/current revision, active slice, and the packet's exact allowed files in the checkpoint. Preserve prior evidence and unrelated work. Clear only resolved blockers.
2. Run `node scripts/workspace.mjs preflight LS-S001` (or the requested ID). The tool is read-only: it neither authorizes work nor edits state. Failed checks block coding. Dependency receipts live in `implementation/evidence/LS-SNNN.json`; each names `slice`, `status: verified`, a full public commit, and nonempty passing `checks` with command and evidence. Reviewers still need to inspect that evidence; receipt syntax alone is not correctness proof.
3. Execute exactly the selected goal; run the packet's commands and mapped acceptance cases. The first slice creates/pins application tooling; bootstrap CI's Node version is not a product architecture decision.
4. Record changed files, command results, evidence and next action. Distinguish `implemented` from `verified`. Commit only when directed. Do not mark a slice verified or advance based on specification checks alone.

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
