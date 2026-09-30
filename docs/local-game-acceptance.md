# Local game qualification

Platform, native control/save recovery, selected-provider perception, speech
performance and Human qualification are separate claims. Existing fixture passes
and receipt shapes do not establish actual play or useful autonomous progress.

The offline evaluator consumes already collected scoped snapshots:

```sh
node --experimental-strip-types scripts/qualify-local-game.mjs \
  --input /operator-local/game-diagnostics.json \
  --output /operator-local/new-game-lineage-report.json
```

Its input is a closed object with `decisions`, `proposals`, `admissions`, `actions`,
`observations`, `campaigns`, `episodes`, `projections` and `terminalEpisodes` arrays.
The first eight contain existing canonical record shapes; terminal records contain
only an episode UUID, newer revision and forgotten/expired/invalidated state.
Input is a regular local file bounded to 256 KiB, at most 32 rows per array and
the existing safe snapshot limit of 8,192 nodes. Getters, proxies, cycles, binary
payloads and extra raw-media/save/authority fields are rejected.

Available decision/observation/journal, proposal/prepared-view,
action/admission/frame/result and retained episode/projection metadata is
correlated. Missing records remain explicit gaps. Contradictory supplied metadata
produces a diagnostic report and CLI exit code 2; partial metadata yields exit
code 0 while `claimsRuntimeAcceptance` remains false. Neither result passes an
acceptance case. A completed receipt, neutral-controls flag or save digest is
still a supplied assertion requiring its independent native owner qualification.
UTC timestamps do not measure monotonic execution latency.

Reports hash opaque identities and source references and omit scene descriptions,
questions/advice prose, goals, prompts, controller buttons, recipient/channel
references, artifact paths, raw screenshots and save bytes. They preserve source
families, frame ranges, original dates, pinned digests and distinct milestones.
A newer terminal episode suppresses stale episode/projection payloads; replay
cannot restore or reinforce memory. The existing isolated replay path creates new
IDs and pins the redacted artifact, without accepting a runner/provider callback
or invoking capture, controllers, saves, scheduling, contacts or learning.
Equality compares metadata only. Reports use fresh owner-only files outside the
connected repository roots and never overwrite an existing report.

This tool is a bounded diagnostic component, separate from a complete canonical
activity trace. Current source custody, exact full prepared-input lineage,
budgets, native pause and ordinary-save recovery, configured-hours/contact/image
outcomes, authenticated advice and its actual causal result remain independently
qualified. Each Linux/Windows graphical ordinary-speed platform and selected
provider needs its own actual evidence, including display loss, stationary-frame
pause, durable ordinary save readback/restart/load and honest unsaved loss.
Paired speech/resource tests and Human relevance/control are also separate gates.

Advice-bearing episode admission additionally requires separately retained active
Human input with its real activation history and exact owner, original turn,
quote transformation and revision. The original help item and independent source
retention must still be eligible; episode retention cannot outlive that question
custody. Host qualification of the actual question delivery and authenticated
reply remains mandatory on admission and historical reuse. The exact selected
advice object can expose inert source references; a copied wrapper cannot.

Additive custody metadata links these sources to the episode and canonical
unverified experiential projection. It retains bounded source references, never
a second advice quote or recipient configuration. Forgetting/correction of the
Human input, help withdrawal, source erasure and restore quarantine remove
dependent episode/projection payloads transactionally; opaque fences survive.
Dependency cascades do not erase independent Human input. This source path does
not send help, authenticate a channel, dispatch an action, prove advice success
or promote installed/native platform qualification.

Ordinary foreground HTTP conversation can select this validated advice-bearing
episode through the existing nine-section prepared-memory path. It remains dated
historical game experience with uncertainty, without raw advice/authentication or
recipient references in its game context. Held replies recheck source custody,
consent and audience before releasing prose. Original Human/source forgetting,
correction, help erasure, authentication withdrawal or expiry fences a selected
reply; an unknown, shared or foreign relationship audience cannot select it.
Historical recall does not itself require a current game pause or contact grant.
Isolated HTTP/SQLite fixtures verify these fences; their synthetic Human input,
channel authentication and native action predicates do not qualify live advice,
causal success or platform acceptance.

The adapter's save boundary requires an independent host qualifier for actual
native persistence/readback before entering a save-control operation and after
its result. Closed metadata checks bind request, timeline, pinned artifact and
save/readback/confirmation clocks; verification preserves the older ordinary
save's original timeline, frame, bytes digest and creation date. Existing ordinary
save creation may precede the current flush request. A shape-valid success or
opaque readback reference cannot qualify itself. Failed or withdrawn qualification
after entry leaves the operation potentially executed and quarantined until
trusted reconciliation. This code performs no file/save/emulator operation and
does not prove native flush, restart/load or recover lost unsaved progress.

Already collected paired speech/resource/display measurements can be scored with:

```sh
node --experimental-strip-types scripts/qualify-local-game-performance.mjs \
  --input /operator-local/game-measurements.json \
  --output /operator-local/new-game-performance-report.json
```

The closed input has `environment` and `runs`. The pinned environment declares
the Linux or Windows profile, source/providers/configuration/game digests,
monotonic clock mapping, nominal core frame rate and two to eight pressure
conditions beginning with `disabled`. Each condition holds at most 5,000 trials;
the local regular-file input is bounded to 32 MiB. Trials retain requested-speech,
prepared-read, interruption-stop and audio-continuity milestones, warm/cold
status, optional-work outcomes, resource observations and separate game
presentation measurements. Missing values remain explicit. Every failed,
timed-out and cancelled foreground attempt stays in its denominator; cold
successes never fill the required 200 exact warm completed speech pairs.

The scorer preserves the existing 900/1,500 ms spoken-word, 15/40 ms prepared-read
and 150/250 ms audible-stop median/p95 objectives. Paired overhead is reported
without inventing a game-specific threshold. Optional planning/perception,
checkpoint/reflection deferrals, drops and failures remain separate from
foreground speech. Resource headroom, memory pressure, display cadence,
nominal-speed ratio, controller response, decisions, idle and deliberate pauses
are reported separately. A disconnected viewer with an available display is
distinct from display loss. Neither a measured speech pass nor a supplied
`physical` label qualifies native performance, useful gameplay or Human review;
matched emulator-only presentation/control and actual per-platform evidence
still require independent qualification. The tool starts no measurement run,
provider, camera, game, save, schedule or contact, and creates a fresh owner-only
report outside connected repository roots.
