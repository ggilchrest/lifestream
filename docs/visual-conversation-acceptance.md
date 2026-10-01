# Visual conversation qualification

The visual publication, turn observer and retained memory source provide distinct
diagnostic receipts. `scripts/qualify-visual-conversation.mjs` correlates an already
collected local snapshot and replays its redacted metadata in isolation:

```sh
node --experimental-strip-types scripts/qualify-visual-conversation.mjs --input /operator-local/diagnostics.json --output /operator-local/new-report.json
```

The input contains `publications`, `turns`, `episodes`, `projections`,
`terminalSources` and optional `lifecycle`. Obtain these through the existing scoped host/repository;
matching supplied identifiers does not authenticate the source or establish
current consent. Each array is bounded to 128 rows and the input to 4 MiB. A
canonical projection must match its exact typed episode and attributed
transformation estimate. Terminal source receipts suppress older retained
snapshots and projections. The output retains hashed identifiers, source-family
and time lineage, prepared-section digests and separate publication, generation,
emission, endpoint acknowledgment, memory projection and correction milestones.
It omits scene prose, media, prompts and Human correction text.

`partialDiagnosticCorrelation` means the supplied metadata is internally
consistent where it can be joined. Missing or expired receipts remain explicit.
`contradictoryMetadata` identifies conflicting supplied joins. Neither status
establishes actual delivery, perception quality, source completeness or Human
acceptance. A completed audio observer acknowledgment and HTTP text emission are
different diagnostic milestones; neither alone proves perceived delivery.

Replay creates new event identifiers, preserves original hashed source families
and dates, pins the redacted artifact and uses the existing isolated replay
implementation without a runner callback. It performs no capture, provider call,
memory write, reinforcement or external effect. Its equality check compares
metadata payloads, not perception or generated replies. Reports use a fresh file
outside connected repository roots with owner-only permissions.

The source host separately exposes actor-scoped `lifecycleReceipts`. These
asynchronous diagnostic rings retain at most 128 pending and 128 published
receipts, with lazy expiry after 60 seconds on either clock. They cover
negotiation, observed runtime camera state, actual runtime lease termination,
admitted frame sequence/clock metadata, rejected ingress, failure after admission
and selected context expiry. An unmatched stop is a no-op; an inactive state
observation does not prove that a physical capture device stopped. Receipt
failure cannot change source-host authority or publication. No idle erasure or
complete inventory is promised.

The offline correlator joins available lifecycle admission, frame/clock, provider,
source epoch and runtime enablement metadata to publication. Legacy snapshots
without lifecycle receipts and truncated inventories remain explicitly partial.
Negotiation, observed capture, admission, source publication, prepared context,
generation, endpoint acknowledgment and memory retention remain separate
milestones. These receipts can be replayed with the same redacted source/time
lineage, without reopening capture or granting authority.

The full visual lifecycle trace remains incomplete; missing receipts do not
establish event completeness.
The memory worker separately exposes owner-scoped `visualIntakeHistory`: bounded
asynchronous background receipts preserve queued, replaced, denied, expired and
retained decisions instead of overwriting each request's earlier milestone. They
contain only hashed owner/request references and closed diagnostic states, with
the same 128 pending/128 retained and lazy 60-second dual-clock bounds. Owner
permission is rechecked on inspection; close removes pending history. No Human
turn/session is created, and neither diagnostic state nor its inspection supplies
consent, recall content, source currency or learning. The offline correlator now
joins available intake request/owner/time metadata to publication and separately
retained typed sources. Queuing may precede publication completion; replacement,
refusal and expiry remain distinct from retention or projection. Global sequence
gaps can reflect owner filtering, expiry or bounded eviction and remain explicit
coverage gaps. Legacy snapshots and sources without retained intake history stay
partial. Replay keeps intake states historical after forgetting, suppresses stale
source/projection payloads, and never reactivates memory. Supplied metadata cannot
authenticate consent or current custody; canonical trace integration remains
pending.
The finalized-turn host now asynchronously retains published `context.viewSelected`
and `context.sourceUsed` envelopes alongside the exact internal nine-section
manifest metadata and section digests. It requires the actual deployment ID,
UUID scope and original finalizer/request identity. Missing/foreign identity and
replay do not fabricate normal events. The internal manifest is explicitly not
the published provider `InputManifest`; no provider/profile/snapshot IDs are invented.
These restricted host-only records share the existing actor scope, 128-record
eviction, lazy 60-second expiry, reset and close boundaries. They contain no
scene, dialogue, user input or reply text, grant no current eligibility, and
prove neither provider admission nor delivery. Whole canonical lifecycle,
durable trace sink and joined replay integration remain incomplete.

The genuine retained context bundle can now join a matching finalized receipt
by actual interaction/view/time and exact manifest/section digests. Mismatches
remain unjoined; source currency and delivery remain unproved. Its pure semantic
replay uses new event/trace/environment IDs, links each original event ID, retains
original source times and manifest, and names its source-relative virtual clock.
It has no provider/media/storage/effect callback and cannot become a new normal
source. Replay does not refresh context, activate capture or reinforce memory.

Published `memory.referencesSelected` events now name only retained MemoryRecord
UUIDs represented in the final prepared-memory formatting. Relationship-record
UUIDs stay distinct. Discovery displacement and unknown/legacy metadata cannot
create a memory-selection claim; mandatory/convention-rendered sources remain
accounted for. This adds source metadata, not memory capture or retrieval policy.
Selected-provider physical input, unannounced animal interpretation, historical
appearance comparison, paired performance under pressure and Human experience
qualification remain separate gates. Metadata fixtures do not satisfy them.

The actual existing SQLite visual projection owner now queues a restricted
published `memory.candidateProposed` milestone only after its committed candidate
and typed source validate together. Source MemoryRecord/episode IDs, revisions,
source digest and creation UTC are preserved. Its separately named artifact is
small redacted candidate metadata with actual bytes, size and digest; it is not
a full MemoryRecord body. Prose, observations and confidence-policy notes are
omitted. The background producer has its own UUID, no invented Human interaction
or source event IDs, and no fabricated source monotonic clock. This separate
metadata journal bounds pending and retained records to 128 each with lazy
60-second dual-clock expiry, owner isolation, consent revision/forget/correction,
reset/close and rollback fences. It never changes projection or activation,
ordinary extraction, eligibility or authority. Activation does not rewrite a
historical candidate as active. Durable sink, lifecycle-change source identity
and full joined replay remain incomplete: current memory lifecycle rows have
no recorded UUID event ID, which diagnostics must not invent.

Genuine retained candidate bundles now correlate with genuine finalized-memory
selection by exact MemoryRecord ID, Assistant and chronological source events.
Cross-session/cross-environment use stays historical. Copies, mismatched Assistant,
unselected records or reversed time remain unjoined. The join explicitly leaves
owner equivalence, current usability and delivery unproved. Its pure semantic
replay retains both exact redacted artifacts and original source event/time,
uses a new isolated environment/event/background producer and the existing
context virtual clock, and leaves the missing candidate monotonic clock null.
There is no provider, source-refresh, memory or effect callback. Held metadata
after forgetting can explain history but cannot reactivate or reinforce memory,
or masquerade as a new normal source. Full lifecycle/media replay remains open.

New visual activations now persist a canonical MemoryLifecycleEvent and an exact
redacted validation artifact in the original existing SQLite lifecycle transaction.
The UUID names the committed mutation, not a historical ID invented during trace
projection. Actual candidate/record revisions, source episode/digest, actor and
current consent/projection/capacity checks bind the receipt. The artifact stores
actual metadata bytes/size/digest and proves neither perception quality nor truth.
Rollback leaves no activation receipt, duplicate activation creates none, and
SQLite reopen preserves identity. There is no new schema, table, migration or
memory engine. Legacy rows remain missing rather than receiving synthetic IDs.
Owner reads validate the stored envelope/artifact against actual current source;
correction, erasure, expiry, consent loss, mismatches and rollback withhold it.
Existing privacy erasure removes validation/source payload and preserves only the
real opaque event UUID; repeated erasure cannot mint or discard that ID. Ordinary
legacy receipts and independent Human memory retain their existing semantics.
Canonical asynchronous lifecycle projection and full joined replay remain next.

The existing bounded background memory journal now asynchronously projects
published `memory.lifecycleChanged` from genuine storage-owner activation reads.
The payload references the original recorded canonical mutation UUID and exact
revisions/source, with source UTC and null unrecorded monotonic clock. Copies,
proxies and schema-only/legacy data cannot donate normal source provenance.
Candidate and lifecycle events share producer order and 128 pending/retained
bounds, owner policy, lazy dual-clock expiry, reset/close/rollback and erasure.
Reads also withhold/purge bodies erased directly through the memory owner.
Genuine candidate/activation/finalized-memory bundles can join exact owner,
record/episode/source digests and chronological source events. Context owner
qualification, current eligibility and reply delivery remain unproved. Pure
joined replay preserves all three exact artifacts and canonical mutation/source
IDs in an isolated environment, with no media/provider/storage/effect callback
or reinforcement; erased history cannot become a normal source. Legacy and other
mutation/capture/perception/native lifecycle coverage remains partial.

New source-owner correction and payload-erasure rows now have distinct original
mutation UUIDs committed with their actual memory revision changes in the existing
SQLite transaction. A projected correction returns its mutation UUID separately
from the Human entry UUID; a source-only correction returns no projected mutation
identity. Source retirement, direct visual-memory forgetting, policy withdrawal,
expiry and restore quarantine retain their actual erasure receipt. On subsequent
payload erasure, only original opaque activation/mutation UUIDs survive; correction
text, source/context references and revision detail in old event payloads are
removed. Unknown or corrupt original revision metadata remains null in the new receipt;
optional diagnostics cannot prevent privacy erasure. Legacy rows acquire no
invented history identity. Write failure rolls
back the mutation and receipt together, and real database restart preserves the
committed receipt. Independent Human memory and existing forgetting fences remain
separate.

These internal source identities are not canonical `MemoryLifecycleEvent`
operations or authenticated trace envelopes. A Human correction entry UUID is not
a MemoryRecord evidence ID, and payload erasure is not canonical source-preserving
`invalidate`. Supplied or copied metadata cannot establish original-owner custody.
The increment supplies actual source identifiers for later qualified joins; full
canonical correction/privacy lifecycle mapping, durable trace retention and actual
provider/native replay qualification remain incomplete. It adds no table,
migration, durable retention period, capture, model call or external effect.
