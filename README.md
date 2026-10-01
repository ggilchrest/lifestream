# Lifestream

Implementation workspace for a persistent assistant runtime. The exact completed and active work is recorded in `implementation/checkpoint.json`; a green bootstrap or specification check is not runtime or production acceptance.

## Start here

Read [AGENTS.md](AGENTS.md), [the bootstrap guide](BOOTSTRAP.md), and [the current checkpoint](implementation/checkpoint.json).

Status reconciled on 2026-09-18 against source `448c6e9`: the technical core through S081 is implemented with revision-bound qualifications; the combined S080/S081 Human decision is recorded separately. S083 initiative and S084 Discovery component paths are implemented, not untouched future work. Full physical, perceptual, protected external-authority, production and new Human acceptance remain separate. Follow the checkpoint and current qualification selectors rather than treating older failure receipts or planning snapshots as current blockers. This documentation update did not rerun live acceptance.

With Node.js 24 available, run:

```sh
node --test scripts/workspace.test.mjs
node scripts/workspace.mjs check
node scripts/workspace.mjs preflight LS-S001
```

The first two commands validate the workspace tooling without private access. Preflight checks that the selected slice, worktree, scope aid, and prerequisites agree; it is not an authorization mechanism. A user request for a bounded task, milestone, or batch covers its ordinary dependency-ready implementation work, subject to the safety and external-action boundaries in `AGENTS.md`.

The private specification is a separate Git repository at `.private/`; its contents, private reports, and credentials must not be committed here. Public CI never fetches the private repository or needs its credentials. The historical `spec-lock.json` is retained as provenance and is not an implementation gate.

The application workspace is implemented. Its current package metadata requires Node 24 or newer and pins `pnpm@10.0.0`. Application checks are `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm test:browser-surface`; actual-browser and selected-provider checks have additional environment requirements documented by their harnesses. Bootstrap checks alone do not exercise the application.

## License

This repository contains an [Apache 2.0 license](LICENSE). This does not resolve licensing of private specification content or authorize its publication; release/licensing reconciliation remains a recorded specification decision.
