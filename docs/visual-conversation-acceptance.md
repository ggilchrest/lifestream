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
