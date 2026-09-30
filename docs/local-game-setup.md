# Local game adapter boundary

The built-in game lane uses `local-game-activity/1.0.0`. Its typed records are
available from `@lifestream/contracts/game-activity`; the adapter port and guarded
envelope boundary are in `packages/providers-bizhawk`. The schema and its approved
digest are unchanged. Generate/check shape types with
`node scripts/generate-provider-types.mjs --game [--check]`. Schema, conditional
and cross-message validation remain required at runtime.

This increment does not launch an emulator, expose a game administration route,
select a model, enroll play hours, read game/save files, or create a schedule.
The supported target qualification is separate for Linux and Windows. No macOS
or headless qualification is claimed.

A trusted host must supply the current qualified source/pins/display predicate,
reviewed observation admission, and a durable authenticated effect-claim callback.
Missing setup or admission refuses the affected operation. The callback must resolve
the original dispatch evidence, exact input/scope/policy, ownership, budgets and
idempotency before I/O; schema-valid admission fields cannot grant permission.
The boundary supplies no in-memory replacement ledger or automatic retry. The durable host ledger must also withhold successor effects while an earlier run outcome or ownership remains unresolved, including across restart.

The closed port exposes observation, bounded controller application, exact-lease
release and ordinary-save control. Game input keeps its `simulatedGame` domain,
activity/run/timeline/campaign identity and logical-activity context. It cannot
supply physical audience, speaker authentication or world truth. Observation
acceptance requires a host-owned reviewed visibility/decoder/media check; a
shape-valid field name is not permission to expose hidden game state. Screenshot
JSON contains opaque references and bounded metadata, never raw bytes, URLs or
filesystem paths. Dedicated image interpretation and ephemeral byte custody remain
separate from the ordinary conversational prompt.

Controller proposals must match the request scope, complete explicit button vector
and checked observation/frame. Admission is rechecked after awaits. The returned
receipt must match action, proposal, idempotency and admission identity; completed
work needs bounded frame accounting and neutralized buttons. Timeout, cancellation,
source loss or invalid output after effect entry remains potentially executed.
The host must reconcile durable adapter state or pause, rather than retry unknown
work. Potentially executed/incomplete work remains quarantined; a trusted reconciliation callback must resolve the original operation before a successor is admitted. Up to 64 pending/unresolved run records are bounded in this component; full durable recovery belongs to the host ledger. One effect per run is admitted through this boundary at a time; global run,
lease, scheduling and budget coordination remains a runtime responsibility.

Safety release has its own trusted exact-old-lease intent, including after gameplay
permission/source availability is withdrawn. It may preempt an in-flight operation.
Its current-scope predicate refers to the shutdown intent, not renewed gameplay
permission. A claimed neutralized-and-paused acknowledgment must identify the
requested lease, an increased fenced epoch, and equal frame samples at increasing
monotonic times. These checks validate an acknowledgment; only real adapter/platform
qualification can establish actual emulator pause. A successor lease must survive
old release. Resume still requires fresh observation and current authority.

Only ordinary save flush/verification operations are admitted by the schema.
Emulator savestates, rewind and arbitrary filesystem operations are rejected. A real
bridge, qualified save persistence/readback, restart from an actual game save,
campaign journal and runtime lifecycle are still implementation/qualification work.
A successful synthetic boundary test does not establish saved game progress.

`createAuthenticatedGameTransport` now operates an already connected stream; it
creates no listener or reconnect. Its control framing matches the UTF-8 byte length
and space prefix in the [referenced BizHawk socket implementation](https://raw.githubusercontent.com/TASEmulators/BizHawk/2.11.1/src/BizHawk.Client.Common/Api/SocketServer.cs).
That source connects outward from the emulator. It is an API reference, not a
selected or qualified installed build. A future bridge must detect partial native
sends and fail safely; native screenshot retry behavior must not become controller
retry behavior. No Lua peer or screenshot byte lane is supplied by this increment.

An explicitly paired credential of 32–128 bytes authenticates a fresh per-connection
challenge using HMAC-SHA256 over the exact challenge JSON. The challenge binds the
protocol, random session/nonce, provider, pins, scope digest and finite expiry.
The bridge replies with closed canonical JSON containing `type: authenticate`
and `proof`; the host confirms `type: authenticated`. Credentials and proofs are
never error text. The scope and credential are copied at creation; the host's
credential copy remains under host custody. Pairing proves possession of a bridge
credential; current authority, qualified source and reviewed observations remain
separate required predicates. Missing pairing has no fallback grant.

Control frames are at most 128 KiB, length prefixes at most six digits, and text
decoding rejects malformed UTF-8. The session duration is explicit and bounded.
Up to eight calls can await replies, with one additional release slot. The registry
retains at most 256 request identities plus a reserved release identity during that
connection. Authenticated replies must match the original operation, request,
correlation and provider; the existing boundary still validates complete records.
One late response for an abandoned call is discarded. Replays and unrelated replies
close the channel. A lost effect outcome stays potentially executed; no reconnect,
retry or durable reconciliation is inferred from a new connection.

The host receives one redacted disconnect notification and must fence ownership
and pursue real pause. A queued release and its scripted acknowledgment do not prove
that a busy native bridge can stop an emulator. Tests cover a temporary loopback TCP
socket with a scripted peer; actual Lua, graphical emulator, game and save effects
remain separate implementation and qualification work.

The operator must provide the exact legitimate game/build/core/configuration/script
and visible-state-manifest pins, a real graphical watchable session, finite policies
and runtime authority before actual play. Existing providers and installed services
remain unchanged. Scripted tests use no real game, emulator, save, camera or external
recipient.

The emulator-independent campaign journal core now persists compact sourced
continuity through `CampaignJournalRepository`. It creates no activity run, save
or memory record. The host supplies explicit owner/restore gates, an enabled finite
retention policy, journal/identity/source/byte quotas, verified source eligibility,
exact derivative validation and authority to initialize a new campaign journal.
These synchronous predicates are host-owned; a model's references or self-score
cannot grant them. Missing journals stay unavailable until an authorized,
source-grounded creation is supplied.

SQLite writes compare journal and goal revisions, preserve immutable entry IDs,
and acknowledge only committed metadata. Compaction cannot reset a goal revision
or reinterpret an omitted source entry. Privacy erasure retains opaque fences;
dependent entries/goals are removed before reuse while independent entries survive.
If summary evidence is erased, inspection reports `needsReview` with no summary,
and canonical selection is unavailable until a newly validated summary is written.
Policy changes, finite expiry, source invalidation and explicit retraction cannot
resurrect content after restart; clock rollback refuses reads/writes. Restore
quarantine must be supplied by the trusted host and cannot be cleared by a journal.

`selectCampaignContext` materializes the already compact journal for an existing
conversation section, preserving source/epistemic labels and unfinished goals. It
keeps all retained compact entries because this core has no contradiction oracle;
insufficient context budget reports omission instead of dropping a contrary clue.
The returned selection has a current-source callback for pending-use fencing.
Runtime checkpoint/save binding, prepared-context integration, journal generation,
fresh ordinary-save/view reconciliation and actual next-action selection remain
implementation work. SQLite close/open with scripted sources proves metadata
persistence only; it does not prove saved game progress or autonomous continuity.

`selectGameCampaignContext` now checks the concrete game wrapper against that
authoritative journal, exact activity/run/epoch/timeline/campaign, pins and a fresh
game observation. Every entry has one explicit current/historical binding. Current
entries must belong to the current timeline; older-save learning stays historical.
Observed attempts require action references, observed entries require observation
references, and attributed advice requires advice references. Those IDs still need
host evidence validation; their presence alone cannot establish an effect or advice.

The host must verify the actual loaded ordinary-save lineage, reviewed source and
goal reconciliation, graphical/source/authority scope and authoritative core revision.
Missing reconciliation, source loss, changed journal access, expiry or clock rollback
withholds the selection and retires pending use. Game freshness uses explicit finite
activity policy, independently of physical-camera TTL. Visible facts must cite an
included screenshot; current decoded values retain exact timeline/source/freshness.
The compact existing-section payload preserves epistemic labels, current versus
historical entries and limited save metadata, without save bytes or executable controls.
SQLite restart/forgetting tests use scripted game/save/source predicates. Actual save
readback, older-save load, field decoding, runtime checkpoint/prepared-view integration
and autonomous next-task behavior remain separate implementation and qualification.


`prepareGameCampaignContext` binds an authentic immutable selection to one
host-created prepared activity view with exact Assistant/owner/relationship and
logical conversation/session/endpoint identity. Copies, accessors, another view and
model-authored current callbacks cannot supply that identity. The existing prompt
assembler admits it only for internal logical activity planning, with empty Human
input and no voice/social opening/camera projection. It creates no public activity
origin or widened wire enum, runtime enrollment, controller or delivery authority.
Game data enter the same untrusted conversation section; nine-section order,
selected Assistant identity, prepared memory and world/capability context remain.
The canonical prepared view and manifest retain exact source identities and
content digests. Game freshness tightens source expiry without extending other
sources. Reuse through `requestForFinalizedTurn` checks the same prepared selection
before admission and after asynchronous work; forgetting/reconciliation/source
withdrawal permanently retires it. Callers must perform that check before using a
late result. Tests assemble real canonical prepared requests, exercise actual
SQLite reopen/forgetting and a scripted asynchronous provider. They do not prove
selected-model planning, actual gameplay/save reconciliation or Human delivery.
The runtime activity coordinator, durable lifecycle/checkpoint, native bridge and
separate foreground history/help selection remain implementation work.


`runGamePlanningTurn` now performs one bounded decision through the existing P2
optional-work coordinator, using the exact cached canonical request (including its
host-set output token limit). It creates no independent history, per-frame loop,
run enrollment, effects or contact. The host supplies explicit finite planning
bounds, pinned provider/tokenizer identity, measured provider preemption/slot release
qualification and a durable once-only worst-case budget reservation before calls.
Missing priority qualification suppresses work; a failed/cancelled call does not
silently refund the host reservation. Tokenization uses the selected provider for
input and completed output, with no estimated fallback. A hung port retains the
existing single slot until it settles; foreground preemption fences late results.

The exact source/view/journal selection produces a canonical `GameDecisionInput`
sidecar with manifest digests and earlier planning/source expiry. Excessive complete
selections are refused rather than silently pruning contradictory history. Model
output is JSON null (no action) or an inert canonical `GameActionProposal`. Scope,
epoch, timeline, observation/view revisions, current visible field predicates,
advice lineage, unique controls and frame/wall bounds must match the prepared view.
Hidden/previously revealed values cannot become current predicates; tool requests,
arbitrary Lua/save operations, malformed/oversized output and missing terminal fail.
Actual dispatch still requires a new observed frame, independent capability admission,
input ownership and durable action identity through the governed adapter. Planning
publication never dispatches. Source/provider/clock changes cancel pending publication.
Tests use scripted provider/tokenizer/host reservations and do not prove durable
reservation restart behavior, actual model competence, game outcomes or provider
priority measurements. Durable run/checkpoint/admission, host lifecycle integration
and native dispatch qualification remain required.


`ActivityCheckpointRepository` now persists canonical host metadata and separate
planning budget reservations. It requires explicit owner authorization, restore
quarantine, source/transition grounding, finite retention/quotas and exact configured
GameBounds; presence of a game/save/checkpoint does not grant any authority. CAS
checkpoint/ledger revisions, epoch/state floors and same-timeline revision floors
survive restart. A new older-save branch needs a new epoch and trusted transition,
retains the original ordinary-save attribution and cannot reduce existing usage.
The store counts actual cumulative serialized checkpoint bytes under its finite quota.

Once-only planning reservations bind an exact run/scope/view/revision/invalidation
and provider identity. Held maximum input/output/call capacity is distinct from
actual used tokens/calls. Unknown, cancelled or failed work never silently clears
its reservation. Only a trusted source-qualified terminal may settle it once into
actual usage; the original historical checkpoint remains unchanged while the ledger
reports current usage. A later checkpoint cannot roll back that ledger. Quotas and
identity fences remain bounded and are not reset by compaction, expiry or save load.
Source invalidation erases dependent checkpoint prose and withholds reuse until new
grounded metadata. Exact policy changes retract it; finite expiry never renews on
writes. Clock rollback, restore quarantine and owner withdrawal deny use/admission.
The host wires the bounded sweep into existing cleanup; no new schedule is enrolled.
Final callback policy/source/expiry changes roll back metadata mutations atomically.

Reads expose recovery-only metadata with `continuationAuthority:false`. An ordinary
save reference yields requiresReconciliation; no save means no exact recovery point.
The store never launches/resumes an emulator, reconstructs game state or replays an
action. Tests use actual SQLite close/open and a separate real Node process to verify
metadata/usage/reservation persistence and duplicate refusal. Save/source/transition/
usage predicates are scripted; actual saved game progress, native crash recovery,
model/controller behavior and restore pipeline/runtime host wiring remain unqualified.

`selectGameWindow` checks explicitly configured play or separate contact hours
against the operator's IANA timezone, current policy revision and finite GameBounds.
Local-day windows are half-open and nonoverlapping; overnight hours require split
windows. Disabled, missing, invalid or withdrawn setup cannot supply eligibility.
Selections are immutable and authentic; current policy, clock rollback, window end
and local-date changes fence pending use. Temporal eligibility grants no start,
controller, resume, recipient or delivery authority.

Occurrence identities use the scoped owner/activity, purpose, policy revision,
timezone, local date and window. Repeated local hours during DST fall-back share
one identity even across different run IDs; nonexistent spring-forward hours create
no match. Actual Intl calendar tests cover those transitions. This component
registers no schedule or contact, and does not yet persist occurrence claims or
enforce restart deduplication. Those durable lifecycle/host gates remain required;
a paused run must require explicit authorized resume rather than replacement start.
