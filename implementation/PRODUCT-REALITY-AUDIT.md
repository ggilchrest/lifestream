# Lifestream Product-Reality Audit

Audit revision: public main at a7adeb28ddc438e3c31aaf2d2e7867c36660745e
Observed: 2026-09-08
Audit class: current-checkout implementation and executable-reality review

## Executive conclusion

The current repository is **not a finished product, not a personal alpha, and not yet a composed reference runtime**. The most accurate classification is:

> A fixture-oriented implementation scaffold containing real but disconnected infrastructure, with one active provider-specific bounded VoxCPM2 development-host candidate.

What a user can launch today is a small HTTP shell that serves health JSON, a body-agnostic POST /api/interactions returning a static 202, generic fixture authority responses, and a static authority page. A second static page can be opened only with an audit-created web server and shows hard-coded Atlas semantic state. There is no runnable Tifa assistant, text conversation, microphone input, audible output, durable memory journey, real inference, or composed real-provider chain.

The full 91-row matrix contains **zero A classifications**: 10 B, 24 C, 49 D, and 8 E. See [capability-reality-matrix.json](capability-reality-matrix.json). The repository still contains useful contracts, deterministic fixtures, SQLite primitives, a partial profile repository, a semantic behavior controller, a PWCE client, and real NeMo/VoxCPM2 adapters. The finding is that those pieces do not form a supported user journey.

### Plain-language answer by capability

| Capability | Present now? | Primary reality |
|---|---|---|
| Tifa presentation | No | D — specified presentation behavior; no Tifa client, avatar asset, or production renderer |
| Semantic EmbodimentState machinery | Yes, internally | B — real controller infrastructure, uncomposed |
| Presence diagnostic view | Fixture only | C — static Atlas page |
| Authored Tifa persona | No | E — no authoritative Tifa profile exists |
| Profile persistence | Partially | B — isolated SQLite repository with activation-integrity defects; not composed |
| Durable canonical memory | No usable path | D — migration/contracts exist, runtime repository is a Map |
| Semantic long-term memory | No | D — specified; no Hindsight/semantic adapter, candidate pipeline, or paraphrase recall |
| Real inference integration | No | D — specified; no adapter, endpoint, or prompt builder |
| Selected inference model/revision | No | E — the exact choice remains open |
| Real STT | Adapter only | B — buildable pinned NeMo adapter with bounded development-host evidence; no runnable Lifestream profile or packaged/launched NeMo service |
| Real TTS | Adapter only | B — VoxCPM2 development-host candidate; not composed and not a Tifa voice |
| End-to-end voice | No | C — fixture pipeline only; no mic, DSP, real model, or speaker |
| PWCE | Client infrastructure only | B — not packaged, selected, or consumed by cognition |
| One-command personal alpha | No | D — specified; no root start command or sidecar orchestration |

## Evidence discipline and audit anchor

This audit separates six questions for every capability: specified, implemented, verified, included in the current candidate, suitable for a personal alpha, and suitable for production. A passing structural validator, fixture test, migration file, TypeScript port, or historical receipt is not treated as a supported product journey. Classifications are frozen to the pre-deliverable audit anchor: the unregistered gap plan created by this audit is not evidence that a capability was sufficiently specified at that anchor and does not retroactively change E to D.

Baseline receipt: [implementation/evidence/product-reality/baseline.json](evidence/product-reality/baseline.json).

- Public checkout began clean on main, 11 commits ahead of origin/main.
- Public HEAD is a7adeb28; the public checkpoint still says currentRevision equals WORKTREE, so that field is stale.
- Private specification checkout is independently rooted at a85d7450, three commits ahead, with pre-existing changes. Those changes were preserved.
- Node is v24.14.1, npm 11.11.0, and pnpm 10.0.0.
- Fresh Database.migrate reports numeric head 13 but applies only migrations 1, 11, 12, and 13.
- Private validation passed structurally and reported all 87 mapped acceptance cases as specified-not-executed. That establishes specification consistency, not runtime acceptance.

No current live external inference, STT, TTS, memory, renderer, or PWCE service was invoked during this audit. Existing development-host evidence was inspected at its recorded revision and kept within its stated boundary.

## Exact current candidate claim

[implementation/candidate-manifest.json](candidate-manifest.json) names:

- claim: **Lifestream VoxCPM2 TTS Development-Host Candidate**;
- class: bounded-development-host-candidate;
- status: candidate;
- production: false;
- selected package: packages/providers-voxcpm;
- selected provider/model family: VoxCPM/VoxCPM2;
- source revision: 78601cb8397134ef2b463199f16fd975b3875fd0, which does not equal audit HEAD;
- voice material: fixture-voice-design revision 1.

The manifest explicitly excludes strict WSL container isolation, native-Linux acceptance, production GPU acceptance, final Tifa voice identity, subjective emotional fidelity, production deployment, and release-image provenance. It also leaves standard inference and renderer selection outside the claim. Its attached LS-S050 evidence is a provider-neutral TTS boundary, not a composed product.

One manifest reference is stale against the current private decision register: `implementation/candidate-manifest.json:53` calls LS-DEC-013 “perceptual acceptance,” while `.private/docs/16-decision-register.md:19` defines current LS-DEC-013 as production retention, deletion, encryption-key custody, backup, and recovery. The candidate's plain exclusions still make its perceptual boundary clear, but that decision label must not be treated as current specification traceability.

Therefore the candidate does **not** claim:

- a current-HEAD whole-product candidate;
- Tifa identity, persona, avatar, voice, or relationship behavior;
- real inference or a selected shared model;
- memory persistence or semantic recall;
- real STT as part of the candidate;
- microphone capture, DSP, speaker playback, or a complete voice loop;
- Presence or authority user journeys;
- PWCE connection or urgent attention;
- fresh-install packaging, deployment, personal-alpha, or production acceptance.

Candidate evidence remains useful for the one bounded fact it supports: a real VoxCPM2 adapter and operator-provisioned development-host sidecar were exercised within the recorded constraints.

## Actual runnable architecture

Solid arrows below are current supported HTTP wiring. Dashed arrows are audit-only static serving or isolated adapter evidence. The absence of an arrow from the server to the lower components is intentional.

<pre>
Human ──HTTP──▶ apps/server ──serves──▶ Control Web (static Atlas fixture)
                    ▲
                    └ - - inline test configuration names; no provider objects

Human - - audit-only static server - -▶ Presence Web (static Atlas fixture)

Repository machinery not composed into apps/server:
  Runtime primitives     SQLite infrastructure     Fixture providers
  NeMo STT adapter - -▶ operator dev host
  VoxCPM2 adapter  - -▶ operator dev host
  PWCE client      - -▶ isolated dev gateway/tests
</pre>

An explorable, source-linked HTML rendering and browser-check receipt are outside Git and indexed by [architecture-index.json](evidence/product-reality/architecture-index.json). The HTML passed deterministic validation and automated containment/readability checks at 1440×900, 1600×1000, 1920×1080, and 2048×1320, including light/dark captures. That validates the audit diagram, not the Lifestream product.

## What actually starts

There is no root start script. pnpm start fails with ERR_PNPM_NO_SCRIPT_OR_SERVER.

After a build, PORT=3831 pnpm --filter @lifestream/server start launches apps/server. The entrypoint accepts only PORT and calls an inline defaultConfig whose eight provider strings are all fixture, storage is in memory, and authority is fixture. It does not load either checked-in JSON profile. Evidence: package.json:7-12 and apps/server/src/index.ts:37-38.

At runtime:

- /health, /health/live, /health/ready, and /health/degraded return 200;
- /control/ returns the static authority page;
- /presence/ returns 404;
- canonical messages, sessions, interaction SSE, and audio WebSocket paths return 404;
- POST /api/interactions ignores the request body and returns a static accepted response.

The complete route probe is in [runtime-smoke.json](evidence/product-reality/runtime-smoke.json). The route and process inventory is in [runnable-surfaces-and-providers.md](runnable-surfaces-and-providers.md).

## Provider composition by profile

| Profile, manifest, or claim | Declared selection | Actual composition | Classification |
|---|---|---|---|
| CLI inline test | Every category named fixture | No provider instance; names become health strings | C |
| test.json | All fixture, in-memory DB | Not loaded by CLI | D |
| local-dev.json | Fixture except system clock, file paths | Not loaded; no DB/provider construction | D |
| local-presence | Private specification requires real audio/renderer adapters and authenticated clients | No checked-in profile, exact provider selection, or runtime composition | D |
| pwce-integrated | Private specification requires PWCE adapters and governed evidence integration | No checked-in profile, exact provider selection, or runtime composition | D |
| Vox wsl-development | VoxCPM2 sidecar only | Separate operator process; no Lifestream profile | B |
| NeMo manifest | NeMo-Speech.cpp/Nemotron on RTX 5090 | Manifest pins the runtime/model and the adapter is buildable; no runnable profile composition or NeMo service launcher | B |
| PWCE client | Pinned Gateway HTTP/SSE contract | Source library only; omitted from workspace packaging/composition | B |
| Release/production | A production profile and fail-closed gates are specified | No runnable profile, composed provider selection, image, or deployment | D |

The /health response says all eight providers are healthy because apps/server/src/index.ts:28 maps configuration keys directly to healthy. An isolated server configured with deliberately nonexistent provider names still reported ready and all healthy. The configuration digest at line 18 uses a top-level replacer that removes nested provider/storage/authority values; materially different configurations produced the same digest. Health cannot attest active provider identity.

### Every current fixture substitution

- inference: concatenating fixture provider;
- memory: constructor-seeded lexical substring provider;
- STT: deterministic text events;
- TTS: deterministic lifecycle plus synthetic, byte-inconsistent PCM;
- playback: bounded in-memory array;
- renderer: in-memory semantic-state receiver;
- world: deterministic world fixture;
- capability: deterministic capability fixture;
- authentication/authority: fixture headers and generic responses;
- clock: a configuration label without an instantiated provider.

The real providers are not substitutes silently composed behind those labels. They are separate packages or files with bounded evidence.

## Presentation and presence

### Presence

apps/presence-web renders a polished but static semantic diagnostic:

- assistant: Atlas;
- speech: listening;
- activity: conversing;
- attention: participant;
- engagement: engaged;
- urgency: normal;
- sequence: 12;
- renderer: ready.

All state is in the first line of apps/presence-web/app.js. The page declares “Semantic state only” in index.html:9. There is no fetch, SSE, WebSocket, image, canvas, video, audio, input, transcript, caption, microphone control, speaker control, avatar asset, rendered gaze behavior, lip synchronization, or error recovery. The runtime's semantic state can carry an `attentionTargetRef`, but no visual renderer consumes it. Presence is not served by apps/server and has no start command. The audit used a temporary static server to open it.

This means:

- semantic EmbodimentState machinery: B, real infrastructure but uncomposed;
- fixture RendererProvider: C;
- minimal Presence view: C;
- real presentation layer: D;
- production avatar experience: D.

### Authority control

apps/control-web is the only page served by the application. It shows a hard-coded Atlas request to send one email. app.js:1 only toggles local DOM state; it sends no request. After approval it nevertheless says the approval was recorded by the server. The server authority wildcard does not persist requests or grants and accepts unknown paths generically.

This is C, a fixture UI/API demonstration, not a Human authority journey. Non-fixture authentication/enrollment/session recovery remains an open decision under LS-DEC-025.

### Screenshot evidence

Raw screenshots remain outside Git as required. Hashes, dimensions, URLs, and observations are in [screenshot-index.json](evidence/product-reality/screenshot-index.json):

- Control desktop: hard-coded Atlas permission request;
- Presence desktop: hard-coded Atlas semantic view;
- Presence 390×844: responsive layout only, not a mobile client.

No desktop companion, personal/mobile companion, ambient-presence client, or voice-only client exists. Endpoint class types and an in-memory registry do not constitute those clients.

## Persona and identity

The repository contains no authoritative authored Tifa Core Persona. Separate case-insensitive whole-word searches covered the public root and the independent private root while excluding this audit's newly created deliverables. Public-root matches were limited to:

- an explicit Tifa voice-identity exclusion in implementation/candidate-manifest.json:49;
- the test that checks that exclusion in scripts/candidate-manifest.test.mjs:31;
- the same exclusion in implementation/evidence/LS-S029-wsl-warmup.json:47;
- an opaque voiceRef named tifa in packages/runtime/test/voice.test.ts:11.

Private-root matches were limited to opaque `fixture:voice:tifa` values in `.private/fixtures/validation-vectors.json:12` and generated `.private/fixtures/contract-closure-vectors.json:14538`, plus provider-neutral Tifa presence contract prose at `.private/docs/16-decision-register.md:37`. Authored private persona fixtures identify themselves as Example Assistant. The pre-existing untracked private `Archive.zip` was also inspected by entry name and content search: it contains older roadmap/specification prose, but no authored Core Persona fields or visual/audio asset entries. Neither those fixtures nor the public storage test profile named A is Tifa. Exact searches and match lists are retained in [inventory-searches.json](evidence/product-reality/inventory-searches.json).

Useful infrastructure exists:

- AssistantProfileRepository writes profile rows to SQLite and uses a transaction for activation;
- the generic schema contains identity, values, prohibitions, relationship boundaries, and style boundaries;
- persona projection and bounded-delta helpers exist.

But the full identity claim fails:

1. AssistantProfileRepository.create uses a much weaker hand-written validator than the canonical schema and permits a caller to insert an incomplete profile directly as active, bypassing draft/CAS activation and its audit row.
2. Activating revision 2 updates the old row SQL status to superseded but not its serialized profile JSON. get and list parse only that JSON. After reopening, both revisions report active through the repository.
3. The projection helper is not called and serializes declarations rather than complete active adaptive values, confidence, review, and mode state.
4. Adaptation validation omits several durable, cumulative, and evidence constraints.
5. Dreaming helpers accepted and applied a proposal whose kind was changeCorePersona, so protected persona mutation is not enforced.
6. There is no API or UI to inspect, compare, create, activate, or reverse profiles.
7. There is no active profile/adaptation trace emission and no real-model behavioral acceptance.

Probe details: [persistence-and-integrity-probes.json](evidence/product-reality/persistence-and-integrity-probes.json). Classification details: persona rows in [capability-reality-matrix.json](capability-reality-matrix.json).

## Durable storage versus useful memory

The repository has a real Node SQLite wrapper with WAL, foreign keys, transactions, migration digests, and a backup primitive. That is B-level infrastructure. It is not application persistence because the server only creates/checks directories and never opens Database.

### Migration reality

Files exist for 0001–0009 and 0011–0013; there is no 0010. Database.loadMigrations registers only 1, 11, 12, and 13. A fresh probe created only:

- schema_migrations;
- capability_snapshots;
- skills;
- capability_proposals;
- interaction_endpoints.

Profile migration 2 is applied ad hoc by AssistantProfileRepository. Memory, prepared context, Dreaming, sessions, trace outbox, and Human authority migrations are not part of global migration. Therefore “head 13” is a numeric maximum, not evidence of a complete schema.

### Canonical memory

packages/storage-sqlite/src/memory.ts is a Map, despite its package location. It stores immutable objects for one process but has no SQLite connection, lifecycle event table, correction projection, export/import, or restart continuity. The prepared-context cache, Dreaming repository, session store, trace outbox, endpoint registry, and most capability state are also Maps or arrays.

### Controlled restart journey

The server was started as a separate process using an isolated file path, posted “My favorite hot drink is jasmine tea,” stopped, restarted using the same path, and posted “Which beverage do I prefer?” Both posts returned the same static 202. No database file was created after either stop. There was no response, citation, memory record, lifecycle state, or correction endpoint. The required journey therefore failed at admission; it would be misleading to manufacture the later correction steps.

The fixture provider separately proved only exact substring behavior: Earl Grey matched, the differently worded beverage question did not, and a new repository instance contained zero records.

### Useful memory conclusion

- SQLite canonical memory/lifecycle: D;
- restart continuity: D;
- lexical fixture recall: C;
- semantic/episodic/entity/fact retrieval: D;
- Hindsight/non-fixture adapter: D;
- automatic candidate extraction: D;
- candidate validation/admission: D;
- semantic ranking/token budgeting: D;
- real Dreaming/consolidation: C with a failed protected-operation probe;
- memory inspection/correction UX: E;
- personal-alpha privacy/retention/provenance enforcement: D.

The test-only backup rehearsal copies a synthetic SQLite table and checks file integrity. It does not prove full application memory, profile, session, authority, artifact, secret-rebind, or rollback recovery.

## Cognition and real inference

No runnable profile has an active InferenceProvider object. The CLI merely contains the string fixture; even the fixture class is not instantiated.

The private specification and provider-message schema define a canonical nine-section, trust-separated prompt plus InputManifest. Its required order is: policy; Core Persona; Adaptive Persona; interaction/endpoint/mode state; prepared memory; world context; capability state; conversation; user input. Sections 5 through 9 are untrusted. The canonical request also carries top-level `executionMode` and `scope` (including endpoint, session, and interaction references), which must agree with section 4 and remain immune to content in the untrusted sections. The implementation enforces none of this: it exposes arbitrary kind/content/trusted sections and a method named infer, while the canonical interface is named generate. Fixture inference concatenates all supplied content. There is no builder, fixed order, source/digest manifest, token budget, redaction enforcement, persona pin, endpoint/mode binding, prepared-memory injection, conversation assembly, world/capability state assembly, or application call site. If registered, implemented, and verified, proposed LS-S052/LS-TEST-069 would make those invariants executable.

There is also no:

- SGLang/OpenAI-compatible network adapter;
- endpoint or credential reference;
- selected standard model or model revision;
- quantization, context, or KV-cache policy;
- streaming real-model response;
- real no-tool conversation;
- real-model structured capability selection.

The exact standard inference choice remains open under LS-DEC-011. Because the implementation is absent, no real conversation or tool-selection call was attempted. Performing one against an arbitrary operator endpoint would not establish repository integration.

## Speech and endpoint audio

| Stage | Status | Current reality |
|---|---|---|
| Microphone capture | D | Types only; no browser/native capture |
| Resampling/normalization | D | No resampler; focused probe reproduced false sample-rate labeling |
| Acoustic echo cancellation | D | Specified; absent |
| Noise suppression | D | Specified; absent |
| Gain control | D | Specified; absent |
| VAD | D | NeMo request option only; no observation/event consumer |
| Turn commitment | C | Synthetic committed fixture event only |
| Real STT | B | Buildable NeMo adapter plus bounded development-host evidence; no runnable profile composition, packaged/launched service, or endpoint |
| Real inference | D | Specified but absent; exact model selection remains E separately |
| Speech-safe segmentation | C | Unit-tested class exists, but VoicePipeline uses its own one-segment helper |
| Expressive decision | C | Injected fixture decision or neutral default, not derived by cognition |
| VoxCPM2 TTS | B | Real development-host adapter/candidate; uncomposed |
| Bounded fixture playback sink | C | In-memory sink only |
| Audible speaker output | D | Specified endpoint behavior; no physical or browser output implementation |
| First audible sample | C | Timestamp means first fixture sink call/provider PCM, not sound at a speaker |
| Barge-in/fencing | C | Separate fixture controller and sink tests; not integrated into VoicePipeline |

Two integration defects are decisive:

1. NeMo accepts 16 kHz mono PCM. Vox sidecar output is 48 kHz mono. VoxCpmProvider always asks the sidecar for 48 kHz, then copies caller format metadata onto returned bytes. A focused probe produced 48 kHz wire data reported as 16 kHz. There is no resampler or distinct input/output format plan.
2. VoicePipeline does not use SpeechSafeSegmenter; it emits segment-0 for each inference chunk. Two chunks produced duplicate segment IDs. It also processes STT, inference, TTS, and playback sequentially and never integrates the interruption controller, so it cannot continuously listen and barge in during playback.

The fixture TTS frame declares 10 PCM16 samples but its base64 payload decodes to three bytes; validation does not check decoded length. Fixture playback evidence proves call ordering, not valid audible PCM.

The NeMo receipt is historical rather than current-HEAD execution: `implementation/evidence/LS-S049.json` names revision `41e13b5…`, which is not an ancestor of audit HEAD. The `packages/providers-nemo-speech` tree is byte-equivalent between that revision and HEAD, so B remains supportable for the adapter, but the receipt does not prove current runtime integration. Exact Git checks and hashes are in [provider-evidence-boundaries.json](evidence/product-reality/provider-evidence-boundaries.json).

The complete real chain—microphone → endpoint DSP/VAD → NeMo → selected shared inference → expression decision → safe segmentation → VoxCPM2 → speaker, with barge-in and late-frame fencing—does not exist.

## PWCE integration and proactive attention

packages/providers-pwce/src/client.ts is meaningful network-capable infrastructure. It negotiates a pinned profile and has methods for context, evidence, grants, evaluation/dispatch, capabilities/invocations, trace publication, prepared inputs, health, and invalidation SSE.

It is nevertheless not a Lifestream feature today:

- the folder has no package manifest or tsconfig;
- it is absent from the root build/typecheck and lockfile;
- no configuration profile selects it;
- the server never imports it;
- the environment-backed evidence is narrow and its public receipt says WORKTREE;
- the broad operation and SSE tests inject fake responses;
- no prompt builder or conversation loop consumes PWCE data.

subscribeInvalidations means cached context may need reevaluation. It is not an urgent fact or safety alarm. There is no typed urgent-attention event with provenance/freshness/expiry, privacy/suitability policy, interruption outcome, shared expression decision, or delivery trace. The printer-fire path therefore does not exist.

No end-to-end read-only world question or truthful outage/degraded-state journey is executable. PWCE is B-level client infrastructure plus C-level mocks, not a connected extension.

## Operations and ordinary user journey

A fresh user cannot currently:

- run one documented application command;
- select a real profile;
- bind secrets through a supported path;
- start NeMo, shared inference, Hindsight, VoxCPM2, a renderer, and optionally PWCE;
- see truthful component health;
- author or activate Tifa;
- configure Tifa voice;
- start a typed or voice conversation;
- restart and recover state;
- inspect/correct memory;
- use durable Human authority;
- enter/leave AI Mode or Game Mode through a defined lifecycle;
- back up and restore a complete installation.

The repository contains no canonical AI Mode/Game Mode state machine or operator command. A WSL execution note mentions preserving an existing external design, while the public ExecutionMode enum contains only normal, replay, and simulation. If AI/Game Mode is a personal-alpha requirement, its authoritative contract must be supplied or explicitly chosen; this audit does not invent it.

The existing package is a fixture-safe development/test repository, not a personal-alpha deployment.

## Minimum Lovable Tifa comparison

All 12 standalone target items and all 5 PWCE-extension items are unmet. Per-item reasons are recorded under minimumLovableTifa in [capability-reality-matrix.json](capability-reality-matrix.json).

The most important distinction is that isolated real adapters do not bridge the gaps between them:

- VoxCPM2 being real does not supply a Tifa voice, inference, STT, microphone, speaker, or presentation.
- NeMo being real does not supply a microphone, VAD policy, turn commit, inference, or audio output.
- SQLite being real does not make the server persist profiles or memory.
- a static semantic view does not make an avatar or client.
- a PWCE client does not make a connected, qualified world-context journey.

## Architectural gaps versus simple implementation gaps

### Architectural gaps

1. **No composition root.** The server and libraries are disconnected. Provider selection, lifecycle, health, degradation, routes, storage, and shutdown do not converge in one executable runtime.
2. **No canonical durable state path.** Global migrations omit most domain schemas; many storage repositories are Maps; the server never opens SQLite.
3. **No conversation path.** Canonical HTTP/SSE/WS routes are absent and prompt composition is missing.
4. **No presentation transport.** Semantic state, renderer, Presence, captions, and audio devices have no shared client protocol or live connection.
5. **No complete audio clock/format/ownership implementation.** Capture, DSP, format conversion, playback, concurrent listening, and interruption are missing; current adapters disagree on sample rate.
6. **No identity/memory administration boundary.** There is no supported Human workflow, non-fixture authentication, or trace-pinned persona/memory view.
7. **No application packaging boundary.** External GPU processes and local CPU endpoints have no orchestrated startup, identity, readiness, restart, or recovery contract in executable configuration.

### Smaller implementation repairs

- include every intended migration in the global ordered migrator;
- correct profile schema validation and serialized status updates;
- hash nested effective configuration correctly;
- make health probe instantiated providers instead of strings;
- export package APIs intentionally;
- repair the NeMo workspace lock importer and package PWCE;
- use the existing segmenter and unique segment IDs;
- validate PCM decoded byte count and preserve actual sample rate;
- stop the static authority UI from claiming a server write without a response;
- refresh the stale checkpoint revision when an authorized slice next owns it.

Those repairs matter, but none alone creates Minimum Lovable Tifa.

## Highest-impact missing capabilities

Ranked by effect on what a user can do:

1. **A real composed text interaction** using a selected model, canonical prompt, Tifa profile, durable session/trace, and a client response. Without it there is no assistant.
2. **Durable Tifa identity and semantic memory** that survive restart, support paraphrase recall/correction, and are inspectable by the Human. Without this there is no stable relationship.
3. **A real Tifa presentation client** with avatar/renderer, live states, captions/text fallback, and truthful errors. Without this the user sees Atlas diagnostics rather than Tifa.
4. **Endpoint audio and a composed real voice loop** with capture/DSP/VAD, NeMo, shared inference, VoxCPM2, speaker playback, barge-in, and format integrity. Without this the user cannot speak or hear.
5. **Truthful configuration, health, and one-command operations** across CPU and GPU processes. Without this the user cannot launch or trust the system.
6. **Human profile/memory/authority controls and recovery.** Without this personal data and protected actions are not safely manageable.
7. **Live PWCE context and a distinct urgent-attention seam.** This is an extension after standalone coherence, not a prerequisite for Tifa.

## Minimum additive roadmap plan

The smallest credible plan is **11 additive slices**: 9 for standalone personal alpha and 2 for the PWCE extension. Combining them further would create multi-system slices too large to validate truthfully.

Standalone sequence:

1. LS-S051 — executable composition, complete migrations, configuration identity, and truthful health;
2. LS-S052 — real inference, canonical prompt, sessions/traces, and a typed text journey;
3. LS-S053 — authored Tifa identity, durable profile administration, prompt/trace pinning, and real-model behavior;
4. LS-S054 — durable semantic personal memory with two-restart paraphrase/correction acceptance;
5. LS-S055 — production-shaped Tifa Presence client, renderer/avatar, captions, text fallback, and live semantic state;
6. LS-S056 — endpoint capture, DSP/VAD/resampling, audio WebSocket, device controls, and speaker playback;
7. LS-S057 — integrated expressive real voice, shared visual/audio decision, unique segmentation, barge-in, and TTFSW;
8. LS-S058 — ordinary-user onboarding, provider/profile/voice/memory/authority/status controls and mode lifecycle;
9. LS-S059 — one-command packaging, fresh-install/restart/backup/restore/performance acceptance, and a standalone candidate.

PWCE extension:

10. LS-S060 — package and compose the pinned Gateway; prove a qualified read-only world question and truthful outage;
11. LS-S061 — typed urgent-attention event, interruption/privacy policy, expressive delivery, and extension candidate.

The full proposed slice contracts—prerequisites, exact user outcome, files/components, acceptance cases, non-goals, evidence, and stop conditions—are in the independently rooted private roadmap at .private/roadmap/MINIMUM-LOVABLE-TIFA-GAP-PLAN.md. These identifiers are proposal-only: they are not registered in the canonical roadmap/traceability map and have no executable packets. No completed slice or historical evidence was renumbered or rewritten.

## Decisions genuinely requiring the user

### Required before affected standalone slices can complete

1. **Standard inference and model profile, LS-DEC-011.** Choose the exact engine, model/revision, quantization, context window, KV-cache policy, and supported endpoint. Hardware placement is already ratified; provider identity is not.
2. **Tifa identity content.** Approve the authoritative Core Persona text, protected self-facts, privacy/relationship boundaries, behavioral/voice/style prohibitions, and initial numeric adaptive dimensions/baselines. Generic fixtures cannot answer this.
3. **Tifa presentation identity.** Approve the avatar/art direction and licensed source assets, plus the selected personal-alpha renderer. Production renderer remains explicitly open under LS-DEC-011.
4. **Tifa voice source and acceptance.** Supply or approve the voice reference/design material, consent/rights record, intended identity boundaries, and Human acceptance rubric. The fixture bundle cannot be promoted.
5. **Non-fixture Human administration, LS-DEC-025.** Choose authentication, initial administrator enrollment, session protection/revocation, and recovery before real protected/profile/authority flows can be claimed.
6. **Personal-memory privacy defaults.** Approve which categories may be automatically admitted, which require review, and the personal-alpha sensitivity/retention/deletion defaults. Hindsight itself is already the proposed reference default and does not need a new selection unless the user wants another provider.
7. **First supported endpoint platform.** Choose the endpoint whose capture, playback, device, permission, and recovery behavior will define LS-S056. A desktop browser is the proposed bounded default.
8. **First supported personal-alpha host and process topology.** Choose the host OS and where the Node server, browser/audio endpoint, inference/STT, VoxCPM2, memory provider, and optional PWCE process run. LS-DEC-036 selects only the prior LS-S029 WSL2 Vox development profile; it does not select the complete personal-alpha packaging target.
9. **AI Mode/Game Mode contract, if required for this alpha.** Identify the authoritative external design or approve a bounded state/lifecycle/ownership contract; the repository does not define one.

### Required only for the PWCE extension

10. **Urgent-attention semantics and policy.** Approve the event ownership/profile, allowed urgency sources, expiry/freshness requirements, quiet hours, interruption defaults, and Human controls. Generic invalidation must not be reinterpreted as an alert.

### Required only for production or public release

- LS-DEC-012: measured production latency targets and performance acceptance;
- LS-DEC-013: production retention, deletion, encryption-key custody, backup, and recovery policy;
- LS-DEC-010: exact open-source license for public release packaging.

Routine implementation choices—exact class layout, endpoint library, local Compose structure, migration mechanics, UI component organization, or use of the already proposed Hindsight reference—do not need repeated ratification if they stay within approved decisions and slice boundaries.

## Commands and evidence

Verification summary: [implementation/evidence/product-reality/verification.json](evidence/product-reality/verification.json).

Key results:

- private install and validation: pass; 46 validator tests; 50 registered slices; 87 registered cases still specified-not-executed;
- frozen offline lockfile-only install: expected failure, exposing the incomplete NeMo workspace importer;
- public typecheck: pass;
- public tests: 101/101 pass with loopback permission;
- lint: pass;
- build: pass;
- workspace structural check: pass;
- focused provider/cognition/voice/PWCE suite: 31/31 pass within fixture/adapter scope;
- focused persona/memory/context/Dreaming/rehearsal suite: 9 pass within helper/fixture scope;
- focused UI/server/runtime/storage suite: 21 pass within fixture scope;
- `pnpm start` at the repository root: expected failure, no start script;
- server start and local route smoke: pass, exposing the fixture/stub boundary;
- migration, restart, lexical recall, profile activation, config digest, sample-rate, segmentation, and Dreaming probes reproduced the findings in [persistence-and-integrity-probes.json](evidence/product-reality/persistence-and-integrity-probes.json); their exact commands and transient helper source are retained in [probe-commands.md](evidence/product-reality/probe-commands.md);
- architecture validation and automated browser visual check: pass for the audit artifact.

Evidence directory: [implementation/evidence/product-reality/](evidence/product-reality/).

## Audit boundary and non-actions

This audit created documentation, a JSON matrix, small receipts, and external screenshots/diagram artifacts. It did **not** implement broad product functionality, change completed slice records, rewrite historical evidence, deploy anything, call production services, push an image, publish a release, alter credentials, or mix the private specification repository into the public Git root.

The existing public checkpoint and historical provider evidence were deliberately left unchanged. Any later implementation should create new additive slice evidence at the exact revision where the corresponding user journey becomes executable.
