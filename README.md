# Lifestream

Implementation workspace for a persistent assistant runtime. The exact completed and active work is recorded in `implementation/checkpoint.json`; a green bootstrap or specification check is not runtime or production acceptance.

## Start here

Read [AGENTS.md](AGENTS.md), [the bootstrap guide](BOOTSTRAP.md), and [the current checkpoint](implementation/checkpoint.json).

With Node.js 24 available, run:

```sh
node --test scripts/workspace.test.mjs
node scripts/workspace.mjs check
node scripts/workspace.mjs preflight LS-S001
```

The first two commands validate the workspace tooling without private access. Preflight checks that the selected slice, worktree, scope aid, and prerequisites agree; it is not an authorization mechanism. A user request for a bounded task, milestone, or batch covers its ordinary dependency-ready implementation work, subject to the safety and external-action boundaries in `AGENTS.md`.

The private specification is a separate Git repository at `.private/`; its contents, private reports, and credentials must not be committed here. Public CI never fetches the private repository or needs its credentials. The historical `spec-lock.json` is retained as provenance and is not an implementation gate.

Application runtime/package-manager versions, build scripts, and application CI belong to the first implementation slice. Node 24 here is only the bootstrap/CI tool runtime.

## License

This repository contains an [Apache 2.0 license](LICENSE). This does not resolve licensing of private specification content or authorize its publication; release/licensing reconciliation remains a recorded specification decision.
