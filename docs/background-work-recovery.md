# Background work recovery

Background work is durable only when the work owns a safe replay boundary. A foreground request or capacity pressure may preempt an eligible preparation; that work returns to the idle queue with a bounded new deadline and up to the configured `automaticRetries` budget (0–3). P2 work is deferred while foreground work has priority. The accepted shared-provider limits are a cancellation handoff of at most 10 ms and a slot-release declaration of at most 250 ms. Optional shared-provider analysis remains withheld until the selected provider supplies both bounds as qualified runtime evidence.

A user cancellation is terminal. A privacy operation, authorization change, evidence change, stale source, stale provider identity, expired deadline, or changed review boundary is also terminal. The worker never replays an action that could duplicate an external or user-visible effect. Owner admission receipts and idempotency records stay charged when a job cannot safely be repeated.

The existing in-process fixture provider supplies explicit software-only bounds of zero milliseconds for both shared-provider limits. That lets the fixture exercise optional hypothesis analysis and recovery tests without implying a mac-local or ai5090 qualification. Those real runtimes continue to withhold provider-backed analysis until their cancellation and slot-release evidence is available.

The current durable paths behave as follows:

- Discovery supplied-source preparation is replayed while the live process is idle and the supplied source remains fresh. Its raw selected source is intentionally not retained in the durable work row, so a process restart cannot reconstruct it; the charged receipt remains and a new current admission is required.
- Profile Builder keeps its pinned local snapshot. A worker interruption marks the job retryable, and an idle worker resumes it. Explicit cancel deletes the snapshot and cannot replay it. Current relationship ownership and privacy checks still fence the retry.
- Relationship insight analysis is deterministic and source-pinned. A queued job resumes after restart only while its relationship revision and source references still match. Stale or revoked sources become terminal.
- Relationship Lab stores its pinned synthetic experiment and active phase. A restart resumes an interrupted phase only while the provider identity, consent, configuration, relationship boundary and source snapshot remain current. Explicit cancel, stale dependencies and provider failure remain terminal; no activation or external effect is replayed.

These rules preserve a source or snapshot when it is safe to retry, while making an unavailable or changed boundary visible instead of silently manufacturing a new result.
