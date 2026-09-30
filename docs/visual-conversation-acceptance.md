# Visual conversation qualification

The visual publication, turn observer and retained memory source provide distinct
diagnostic receipts. `scripts/qualify-visual-conversation.mjs` correlates an already
collected local snapshot and replays its redacted metadata in isolation:

```sh
node --experimental-strip-types scripts/qualify-visual-conversation.mjs --input /operator-local/diagnostics.json --output /operator-local/new-report.json
```

The input contains only `publications`, `turns`, `episodes`, `projections` and
`terminalSources`. Obtain these through the existing scoped host/repository;
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

The full visual lifecycle trace remains incomplete: negotiation/enablement,
individual capture sequences, rejected ingress, memory admission before
retention, and production trace/replay wiring need further implementation.
Selected-provider physical input, unannounced animal interpretation, historical
appearance comparison, paired performance under pressure and Human experience
qualification remain separate gates. Metadata fixtures do not satisfy them.
