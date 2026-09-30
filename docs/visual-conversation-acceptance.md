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

The full visual lifecycle trace remains incomplete: pre-retention memory admission
is not joined and missing receipts do not establish event completeness.
Production trace/replay integration remains pending; these internal diagnostics
are separate from the closed canonical trace envelope and its event catalogue.
Selected-provider physical input, unannounced animal interpretation, historical
appearance comparison, paired performance under pressure and Human experience
qualification remain separate gates. Metadata fixtures do not satisfy them.
