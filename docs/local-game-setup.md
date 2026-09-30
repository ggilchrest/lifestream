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
