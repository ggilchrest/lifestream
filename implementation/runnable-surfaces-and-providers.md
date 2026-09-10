# Runnable Surfaces and Providers

Audit anchor: public `main` at `a7adeb28ddc438e3c31aaf2d2e7867c36660745e`, observed 2026-09-08. This inventory records what the current checkout can actually launch. It does not promote contracts, fixtures, or historical provider evidence into a product claim.

## Composition summary

The only supported application process is `apps/server`. Its CLI constructs an inline `test` configuration with eight provider names set to `fixture`, `:memory:` as the database path, fixture authority, and no secrets. It accepts only `PORT`. It does **not** import or instantiate the runtime library, SQLite `Database`, any fixture provider class, NeMo, VoxCPM2, PWCE, a renderer, or a clock provider. Provider health is synthesized by mapping the configured property names to the string `healthy`.

`apps/presence-web` is not served by that process and has no package or start command. The audit used a separate Python static server only so the checked-in page could be opened; that command is not a product startup path.

The actual wiring is available as the external, revision-bound architecture artifact indexed by [`implementation/evidence/product-reality/architecture-index.json`](evidence/product-reality/architecture-index.json).

## Package-directory inventory

| Directory | Workspace/package state | Executable surface and reality |
|---|---|---|
| `packages/contracts` | Buildable `@lifestream/contracts` package | Schemas, primitives, and validators; no process or start command |
| `packages/providers-fixture` | Buildable `@lifestream/providers-fixture` package | Deterministic test providers only; no process or start command |
| `packages/providers-nemo-speech` | Buildable package, but missing its frozen-lock workspace importer | Real WebSocket adapter; no bundled NeMo process or composed runnable profile |
| `packages/providers-voxcpm` | Buildable adapter package plus a Python sidecar file | Real TTS adapter; sidecar is operator-started and uncomposed |
| `packages/runtime` | Buildable package | Runtime helpers/ports; empty public index and no process or composition root |
| `packages/storage-sqlite` | Buildable package | SQLite primitives and repositories; empty public index and no process |
| `packages/perceptual` | No package manifest or start script | Source plus directly invoked test harness only |
| `packages/performance` | No package manifest or start script | Benchmark helper plus tests only |
| `packages/provider-conformance` | No package manifest or start script | Conformance/authority harnesses and tests only |
| `packages/providers-pwce` | No package manifest or start script | Network-capable client source plus tests; absent from workspace build/lock composition |
| `packages/security` | No package manifest or start script | Threat-model helper plus tests only |
| `packages/simulation` | No package manifest or start script | Scenario helper plus tests only |

Only the six package-manifest directories participate in the explicit root build/typecheck project list and package lifecycle. Root test/lint globs can still inspect unpackaged source directories such as PWCE. None of the six packages has an application `start` script.

## Configuration and active provider table

| Configuration or claim | Declared provider selection | What the runnable process actually uses | Evidence class |
|---|---|---|---|
| Server CLI default | inference, memory, STT, TTS, world, capability, renderer, and clock all named `fixture`; `:memory:`; fixture authority | No provider objects and no SQLite connection. The names drive only health JSON. | Runnable fixture/stub shell |
| `test.json` | All eight provider categories are `fixture`; in-memory storage; fixture authority | File is not loaded by the CLI. It matches the inline default by coincidence. | Configuration artifact only |
| `local-dev.json` | All categories fixture except `clock: system`; file-backed paths; fixture authority | File is not loaded. The server would only create parent/artifact directories even if passed programmatically. | Configuration artifact only |
| `local-presence` | Private deployment contract requires real audio/renderer adapters and authenticated clients | No checked-in configuration file, exact provider selection, or runtime composition. | Specified only; D |
| `pwce-integrated` | Private deployment contract requires PWCE adapters and governed external evidence | No checked-in configuration file, exact provider selection, or runtime composition. | Specified only; D |
| `wsl-development` Vox profile | VoxCPM2 runtime/model/RTX 3080 settings for the TTS sidecar | Separate operator-provisioned WSL process. It is not a `RuntimeConfig`, is not started by Lifestream, and has no server connection. | Operator-provisioned development evidence |
| NeMo provider manifest | NeMo-Speech.cpp v0.1.0, Nemotron streaming English 0.6B, RTX 5090 | Manifest pins the runtime/model and the adapter can target `/v1/realtime`; no server profile composes it and no service launcher exists. | Recorded development-host adapter evidence |
| PWCE client | Lifestream mapping profile `lifestream-pwce.v1` pins Gateway profile `pwce-agent-gateway.v1` and bundle `pwce-agent-gateway.bundle.v1` over HTTP/SSE | Not a workspace package, not in the root build or lockfile, and not instantiated. | Library plus mocks and narrow isolated-development receipt |
| Active candidate manifest | VoxCPM2 `TextToSpeechProvider` 2.0.0 only | No whole-Lifestream runtime profile. Candidate source is `78601cb…`, not audit HEAD. | Bounded development-host candidate |
| Release/production | A production profile and fail-closed constraints are specified in the private deployment contract | No runnable profile, provider composition, reproducible application image, deployment, or production process. | Specified only; D |

Sources: [`apps/server/src/index.ts`](../apps/server/src/index.ts), [`apps/server/src/config/profiles/test.json`](../apps/server/src/config/profiles/test.json), [`packages/providers-voxcpm/wsl-profile.json`](../packages/providers-voxcpm/wsl-profile.json), [`packages/providers-nemo-speech/provider-manifest.json`](../packages/providers-nemo-speech/provider-manifest.json), [`implementation/candidate-manifest.json`](candidate-manifest.json). The specified-only `local-presence`, `pwce-integrated`, and `production` profile contracts are at `.private/docs/13-deployment-and-configuration.md:32-50`; no corresponding checked-in public configuration files exist.

## Fixture substitutions

| Port or concern | Fixture implementation or label | Current use |
|---|---|---|
| Inference | `FixtureInferenceProvider` concatenates arbitrary section content | Unit tests only; not instantiated by server |
| Assistant memory | `FixtureMemoryProvider` performs case-insensitive substring matching over constructor data; reinforcement is a no-op | Unit tests only; not instantiated by server |
| STT | `FixtureSpeechToTextProvider` emits deterministic partial/committed/terminal events | Unit tests and fixture pipeline only |
| TTS | `FixtureTextToSpeechProvider` emits deterministic pre-audio/data/terminal events and a synthetic frame | Unit tests and fixture pipeline only; its declared 10 samples are backed by only three decoded bytes |
| Playback | `FixturePlaybackSink` stores frames in an in-memory bounded array | Unit tests only; no sound device |
| Renderer | `FixtureRendererProvider` stores semantic state in memory | Unit tests only; no client transport |
| World | `FixtureWorldProvider` returns deterministic fixtures | Unit tests only |
| Capability | `FixtureCapabilityProvider` supports deterministic policy tests | Unit tests only |
| Authentication/authority | Fixture headers and generic handler | Runnable only in `test`; no durable request/grant store |
| Clock | String label `fixture` in inline/test configuration | No clock object is instantiated |

The package indexes for `packages/runtime`, `packages/providers-fixture`, and `packages/storage-sqlite` export nothing. Their classes are reached by test-file imports, not by application composition.

## Real adapters and their proven boundary

### NeMo-Speech.cpp STT

- Package: `packages/providers-nemo-speech`.
- Pin: NeMo-Speech.cpp v0.1.0 at `4f967622…`; Nemotron streaming English 0.6B at `ebe59e5a…`; immutable runtime/model artifact hashes are recorded.
- Interface: WebSocket `${baseUrl}/v1/realtime`; input must be PCM16, 16 kHz, mono.
- Evidence: `implementation/evidence/LS-S049.json` records one development-host probe through an SSH tunnel. Checked-in adapter tests use `FakeSocket`.
- Boundary: real adapter infrastructure, not a microphone, endpoint DSP, packaged/launched NeMo service, composed runtime profile, full conformance suite, performance claim, deployment, or production claim. Endpointing is observation-only.
- Integrity gap: the required `model` option is not transmitted to or negotiated with the service; the manifest carries the pin, not the wire protocol.
- Revision boundary: LS-S049 records `41e13b5…`, which is not an ancestor of audit HEAD. The provider package tree is byte-equivalent across that comparison, so the receipt supports the unchanged adapter only, not current-HEAD composition. Exact checks are in [`provider-evidence-boundaries.json`](evidence/product-reality/provider-evidence-boundaries.json).

### VoxCPM2 TTS

- Package and process: TypeScript adapter plus `packages/providers-voxcpm/sidecar/voxcpm_sidecar.py`.
- Pin: `voxcpm==2.0.3` at `19b6bf75…`; `openbmb/VoxCPM2` at `32279eff…`; RTX 3080 development placement.
- Sidecar routes: `GET /healthz`, `GET /readyz`, `GET /v1/capabilities`, and `POST /v1/tts/synthesize`.
- Evidence: `implementation/evidence/LS-S029.json` and its WSL warmup receipt record a bounded operator-provisioned development run, including streaming/cancellation/soak observations.
- Boundary: the current candidate is this adapter only. It excludes final Tifa voice identity, subjective fidelity, native Linux, release-image provenance, production hardware acceptance, deployment, and production.
- Artifact state: `source-lock.json` is `blocked-before-build`; `post-build-attestation.json` is `not-built`.
- Voice identity: the only allowed bundle is `fixture-voice-design@1`, with no reference or prompt audio and sandbox-only rights. The adapter ignores `request.voiceProfile` and uses its constructor bundle.
- Format defect: the sidecar contract is 48 kHz mono. The adapter requests 48 kHz and relabels returned data with the caller's requested format, so a 16 kHz request can receive 48 kHz bytes described as 16 kHz.

### PWCE Agent Gateway

- Source: `packages/providers-pwce/src/client.ts`.
- Operations: profile negotiation, authority, health, prepared inputs, context/evidence, grant/evaluation/dispatch, capabilities/invocation, trace publishing, and invalidation SSE parsing.
- Packaging: no `package.json` or `tsconfig`; root build/typecheck and the lockfile omit it.
- Evidence: `implementation/evidence/LS-S028.json` still records revision `WORKTREE`. The environment-backed test reaches only the narrow profile/authority/health/prepared-input path; broader operations and SSE use injected mocks.
- Boundary: no configured live provider, no cognition composition, no end-to-end read-only question, and no truthful outage journey.
- Proactive attention: `subscribeInvalidations` is a cache-reevaluation stream. There is no typed urgent-attention event, privacy/suitability gate, interruption mapping, or expressive delivery path.

### Real providers that do not exist

- Standard inference: no SGLang/OpenAI-compatible adapter, endpoint configuration, model, model revision, or runtime negotiation.
- Semantic memory: no Hindsight or other non-fixture adapter, embeddings, semantic index, or semantic retrieval engine.
- Production renderer: no selected renderer or character runtime.
- Human authentication: no non-fixture authentication, enrollment, session recovery, or administration provider.
- Endpoint audio: no capture, DSP, or physical playback provider.

## User-facing surfaces

### `apps/control-web`

- Served by `apps/server` at `/control/`.
- Displays one hard-coded Atlas email request and one hard-coded history line.
- JavaScript has no `fetch`, WebSocket, SSE, storage, or authenticated session. Approve and deny mutate local text only; approve nevertheless says “Approval recorded by the server.”
- Classification: C, fixture UI rather than a working authority journey.
- Screenshot: see `control-web` in [`screenshot-index.json`](evidence/product-reality/screenshot-index.json).

### `apps/presence-web`

- No package manifest, start command, data subscription, or server route.
- Hard-coded state: Atlas, listening, conversing, participant, engaged, normal urgency, sequence 12, renderer ready.
- Renders a CSS orb and semantic labels. The page says “Semantic state only.”
- No image/video/canvas avatar, transcript, captions, text input, microphone, speaker, device picker, lip sync, gaze, or error recovery.
- Classification: C, minimal diagnostic semantic-state view rather than a presentation client.
- Screenshots: desktop and mobile-layout evidence are indexed in [`screenshot-index.json`](evidence/product-reality/screenshot-index.json). Mobile responsiveness is not a mobile-companion claim.

There are no other user clients. Endpoint classes (`ambientPresence`, `personalCompanion`, `desktopCompanion`, `voiceOnly`, `testHarness`) are types plus an in-memory registry, not applications.

## Executable processes and startup commands

| Process or surface | Command available now | Result and limitation |
|---|---|---|
| Root application | `pnpm start` | Fails: no root start script |
| Server | `pnpm build`, then `PORT=3000 pnpm --filter @lifestream/server start` | Starts fixture/stub HTTP server; build output is required first |
| Control web | Included in server `/control/` | Static fixture page |
| Presence web | None | Audit used `python3 -m http.server` only; this is not supported product startup |
| VoxCPM2 sidecar | `python3 packages/providers-voxcpm/sidecar/voxcpm_sidecar.py` | Without `VOXCPM_MODEL_SNAPSHOT` plus `VOXCPM_ARTIFACTS_STAGED=1`, the loopback process can expose liveness but remains unready. Usable startup additionally requires the pinned runtime/model, `VOXCPM_MODEL_PATH`, and exactly one visible RTX 3080-class CUDA device. Lifestream does not start or connect it. |
| NeMo-Speech.cpp service | None in this repository | Adapter only; external operator process required |
| PWCE Agent Gateway | None in this repository | External system plus uncomposed client |

There is no application Docker/Compose definition, startup orchestrator, sidecar readiness sequence, secret-binding command, or ordinary-operator runbook.

## Actual HTTP surface

Implemented in `apps/server/src/index.ts:33-34`:

| Method | Path | Actual behavior |
|---|---|---|
| any | `/health/live` | Static liveness/profile response; method is not gated |
| any | `/health/ready` | Ready when the server socket and directories are available; method is not gated |
| any | `/health/degraded` | Returns the same synthesized health unless internal state is manually degraded; method is not gated |
| any | `/health` | Synthesized profile/storage/authority/provider health; method is not gated |
| POST | `/api/interactions` | Ignores body; returns static 202; this path is not in the canonical catalog |
| any | `/api/authority/v1/*` | Generic fixture authentication/origin/body checks; unknown GETs return generic 200 and unknown mutations generic 202; no durable objects |
| any | `/control`, `/control/`, `/control/{single-file}` | Static control assets; method is not gated |
| any | everything else | 404 JSON |

The schema catalog declares the following routes, but the server does not implement their canonical behavior:

| Method/transport | Catalog path | Current runtime |
|---|---|---|
| POST HTTP | `/api/runtime/v1/messages` | 404 |
| GET HTTP | `/api/runtime/v1/interactions/{interactionTraceId}` | 404 |
| POST HTTP | `/api/runtime/v1/interactions/{interactionTraceId}/cancel` | 404 |
| POST HTTP | `/api/runtime/v1/sessions` | 404 |
| GET HTTP | `/api/runtime/v1/sessions/{sessionId}` | 404 |
| POST HTTP | `/api/runtime/v1/sessions/{sessionId}/end` | 404 |
| POST HTTP | `/api/runtime/v1/sessions/{sessionId}/handoff` | 404 |
| GET HTTP | `/api/authority/v1/requests` | Generic 200, not catalog response |
| GET HTTP | `/api/authority/v1/requests/{requestId}` | Generic 200, not catalog response |
| POST HTTP | `/api/authority/v1/requests` | Generic 202 rather than durable 201 |
| POST HTTP | `/api/authority/v1/requests/{requestId}/approve` | Generic 202, no request transition |
| POST HTTP | `/api/authority/v1/requests/{requestId}/deny` | Generic 202, no request transition |
| POST HTTP | `/api/authority/v1/requests/{requestId}/cancel` | Generic 202, no request transition |
| GET HTTP | `/api/authority/v1/grants` | Generic 200, no durable grants |
| GET HTTP | `/api/authority/v1/grants/{grantId}` | Generic 200, no durable grant |
| POST HTTP | `/api/authority/v1/grants/{grantId}/revoke` | Generic 202, no revocation transition |
| GET SSE | `/api/runtime/v1/interactions/{interactionTraceId}/events` | 404; no SSE server |
| GET WebSocket | `/api/runtime/v1/audio` | 404; no upgrade handler |

Probe receipt: [`implementation/evidence/product-reality/runtime-smoke.json`](evidence/product-reality/runtime-smoke.json).

## Durable-storage inventory

| Store or repository | Current reality | Restart-capable application path |
|---|---|---|
| SQLite `Database` | Real Node SQLite, WAL, foreign keys, transaction wrapper, backup primitive | No; server never constructs it |
| Migration ledger | Files 0001–0009 and 0011–0013 exist; 0010 is absent | `Database.migrate()` loads only 1, 11, 12, and 13 |
| Assistant profiles | Real SQLite repository lazily installs migration 2 | No server path; weaker validation permits direct active rows; superseded JSON status remains stale |
| Adaptations | Migration 3 only | No repository or composition |
| Canonical memory | Migration 4 and schemas | `MemoryRepository` is a volatile Map; no lifecycle event store |
| Prepared context | Migration 5 and schemas | Runtime builder/cache are volatile helpers |
| Dreaming | Migration 6 plus callback helpers | Proposal repository is a Map; no durable journal/recovery |
| Sessions | Migration 7 plus `SessionStore` | Store is a Map |
| Trace outbox | Migration 8 plus `TraceOutbox` | Outbox is an array |
| Human authority | Migration 9 plus isolated helpers | General grants are not durably composed; fixture API returns fabricated outcomes |
| Capability snapshots | Loaded migration 11 plus cache | SQLite table exists after migration; runtime cache is a Map; server uses neither |
| Skills/proposals | Loaded migration 12 | Tables are inert; no server path |
| Interaction endpoints | Loaded migration 13 plus registry | SQLite table exists; runtime registry is a Map; no clients register |
| Artifact directory | Server creates/checks directory | No artifact repository or lifecycle |

A fresh migration probe reports numeric head 13 but only migrations `[1, 11, 12, 13]` and five tables. The number therefore overstates schema completeness. See [`baseline.json`](evidence/product-reality/baseline.json).

## Restart and semantic-memory result

An isolated server was started with a file database path, given “My favorite hot drink is jasmine tea,” stopped, restarted against the same path, and given “Which beverage do I prefer?” Both calls returned the identical static 202 admission body. No database file was created after either stop. There was no assistant answer, citation, memory record, or correction endpoint, so the required journey failed before memory admission.

Separately, the fixture memory provider matched `Earl Grey` exactly, failed the differently worded beverage question, and had zero records in a new repository instance. That is lexical fixture behavior, not semantic memory or restart persistence. Exact receipt: [`persistence-and-integrity-probes.json`](evidence/product-reality/persistence-and-integrity-probes.json).

## Fresh-machine and operations conclusion

The repository is a safe fixture-oriented development scaffold with some real adapter infrastructure. It is not a usable personal-alpha installation:

- no supported one-command startup;
- no real provider composition;
- no truthful readiness proof;
- no text or audio conversation API;
- no Tifa identity or presentation client;
- no durable memory journey;
- no ordinary setup/status/profile/voice workflow;
- no complete backup/restore or mode-transition workflow;
- no release artifact or production profile.

The bounded provider receipts remain valuable as development evidence, but they cannot bridge these missing application paths by themselves.
