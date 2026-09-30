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

The operator must provide the exact legitimate game/build/core/configuration/script
and visible-state-manifest pins, a real graphical watchable session, finite policies
and runtime authority before actual play. Existing providers and installed services
remain unchanged. Scripted tests use no real game, emulator, save, camera or external
recipient.
