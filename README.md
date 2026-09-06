# Lifestream

Implementation workspace for a persistent assistant runtime. This checkout currently contains development handoff tooling, not a working application. No implementation slice or runtime acceptance is claimed.

## Start here

Read [AGENTS.md](AGENTS.md), [the bootstrap guide](BOOTSTRAP.md), [the specification lock](spec-lock.json), and [the current checkpoint](implementation/checkpoint.json).

With Node.js 24 available, run:

```sh
node --test scripts/workspace.test.mjs
node scripts/workspace.mjs check
node scripts/workspace.mjs preflight LS-S001
```

The first two commands validate the handoff tooling without private access. Preflight deliberately fails until the corrected private specification has a reviewed, committed pin and a slice has been explicitly authorized. A green public CI check is not permission to begin implementation.

The private specification is a separate Git repository at `.private/`; its contents, private reports, and credentials must not be committed here. See the bootstrap guide for authorized checkout and pinning. Public CI never fetches the private repository or needs its credentials.

Application runtime/package-manager versions, build scripts, and application CI belong to the first implementation slice. Node 24 here is only the bootstrap/CI tool runtime.

## License

This repository contains an [Apache 2.0 license](LICENSE). This does not resolve licensing of private specification content or authorize its publication; release/licensing reconciliation remains a recorded specification decision.
