# Development handoff

## Two repositories, separate validation

The public checkout is `ggilchrest/lifestream`. The independently versioned specification is `ggilchrest/lifestream-specs`, checked out at `.private/`. The committed `.gitignore` protects this boundary on fresh clones; a Git ignore is an accident-prevention measure, not a security boundary against force-add or copying content.

Public CI checks bootstrap structure and regression tests without accessing private content. Private CI runs the complete specification validator, including slice reading lists and packets. Neither check is runtime acceptance. Do not add private checkout credentials to public pull-request workflows, use `pull_request_target` to run untrusted code, or upload private validation output to public artifacts.

## Establish the working baseline

1. Inspect both Git roots, origins, branches, and dirty state. Never replace an existing `.private` directory or discard changes.
2. If it is absent and access is authorized, use the `ggilchrest`-scoped GitHub CLI to clone `ggilchrest/lifestream-specs` into `.private`. Fetch only when needed; do not replace local work or silently follow a branch over the current checkout.
3. Inspect current corrections and decisions. Run `npm ci`, `npm run validate`, and `git diff --check` inside the private repository after specification changes. Local commits may preserve verified batch evidence; push or publish only when the user requests it.
4. Keep the private specification checkout available locally and run its validation when changing specification content. The private checkout is a working specification source, not an immutable implementation-admission gate.
5. Run local preflight for the selected slice. It compares the public checkpoint, packet scope, prerequisites, and current worktree without requiring a specification pin or granting permission.

The former `spec-lock.json` is retained only as historical metadata and is not consulted by implementation preflight.

## Slice and batch handoff

`implementation/checkpoint.json` is the actual implementation state; the private Markdown checkpoint is only a format/runbook reference. It records what is active, completed, changed, checked, or blocked so work can resume safely.

The private repository contains the roadmap, explicit readings for all slices, and the available packet files. `npm --prefix .private run slice-packet -- LS-SNNN` displays a slice's source inputs. A packet is a scope and test checklist, not a specification pin, permission token, or publication gate. Existing `preparedNotAuthorized` values are legacy labels and have no controlling effect.

The default operating unit is the bounded task, milestone, or dependency-ordered batch described in the user's request. That one request covers its ordinary dependency-ready implementation work. Update the live checkpoint after each slice and continue automatically; do not require repeated continuation prompts, baseline review, or slice-by-slice ratification.

When the user requests a slice or batch:

1. Read common material once for the batch, then inspect each selected slice's additional readings, scope packet, acceptance cases, and prerequisites as it becomes active. Record the actual public branch, base/current revision, active slice, and expected files in the checkpoint. Preserve prior evidence and unrelated work.
2. Run `node scripts/workspace.mjs preflight LS-S001` (or the selected ID). The tool is read-only and reports inconsistent state. Fix stale scope/checkpoint metadata within the requested work when the intended boundary is clear. Dependency receipts in `implementation/evidence/LS-SNNN.json` remain evidence that named checks passed at a public revision; receipt syntax alone is not correctness proof.
3. Execute the slice goal, run its commands and mapped acceptance cases, update the checkpoint, and continue to the next dependency-ready slice without waiting for user input. The first slice creates/pins application tooling; bootstrap CI's Node version is not a product architecture decision.
4. Record changed files, command results, evidence and next action for every slice. Distinguish `implemented` from `verified`. A local slice commit may preserve verified evidence; do not mark a slice verified or advance based on specification checks alone.

Before public publication, inspect every staged path and its content for private material. Copying private contracts into the public repository requires the user to place those exact artifacts in publication scope; private repository access alone is not permission to publish them.

## Checks

```sh
node --test scripts/workspace.test.mjs
node scripts/workspace.mjs check
npm --prefix .private ci
npm --prefix .private run validate
node scripts/workspace.mjs preflight LS-S001
```

Preflight exits nonzero when the selected slice's checkpoint, worktree, packet, or prerequisite evidence is inconsistent. Correct the aid when the intended scope is clear; do not bypass a real dependency or safety failure. Hosted CI has not run merely because its workflow file exists, and publication still requires user direction.

Repository-level `AGENTS.md` is deliberately concise; changing slice details stay in the packet and checkpoint.
