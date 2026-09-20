# Candidate backup and isolated recovery

The local candidate exports a consistent SQLite snapshot, authentication and forgetting safety records, and only declared presentation-package files. Provider credentials, sign-in exports, model weights, raw source assets and live audio are excluded. The composition runner encrypts this export together with producer-owned PWCE state and incident exports on a separate local volume.

## Backup

Use the composition `candidate-backup.mjs` runner with an operator-local configuration. Its repository identity is pinned after one explicit initialization. It checks that the destination is a mounted filesystem separate from the service before opening the key or repository. The macOS adapter reads a deployment-specific 256-bit key from Keychain through a pipe. Keys never appear in command arguments, receipts or ordinary exports. Keep an independently recoverable offline key copy in separate physical custody.

A scheduled invocation checks daily incremental, weekly full-content rescan and monthly isolated restore deadlines independently. Each restic snapshot is a complete logical generation; deduplication does not require a chain of incremental restores. Weekly runs force content rescanning. Every successful backup performs a full repository data check. Deployment-scoped generations expire by wall time after 30 days, including when no fresh generation was created. Content-free receipts expire after one year. A missing disk, locked key, interrupted export or failed integrity check produces failure, not a successful-backup receipt. The Mac must be awake with the operator's login session active and the volume accessible; missed intervals are attempted after availability returns.

## Restore

Restore into a **new, isolated directory**, using the current safety directory from independent custody. Neither the live service nor an existing directory is overwritten. The Lifestream CLI is:

```sh
node scripts/candidate-recovery.mjs snapshot --candidate /operator-local/candidate --packages /operator-local/packages --destination /operator-local/new-snapshot
node scripts/candidate-recovery.mjs restore --snapshot /operator-local/new-snapshot --current-safety /operator-local/candidate/safety --destination /operator-local/recovered
```

These low-level commands create private plaintext staging and are intended for the encrypted composition runner. The runner removes staging after encryption or recovery. It verifies encrypted bytes before invoking each application's recovery rules. It cannot infer the latest forgetting history from an arbitrary older backup. Missing, changed or provably older current safety records refuse recovery. Loss of current safety custody requires a separate recovery decision; do not relabel an older journal as current.

Before access, recovery replays current forgetting and authentication changes, revokes old sessions, closes logical sessions, removes prepared context, cancels queued automatic-memory work and disables its prior collection approval. Package resources are hash checked. Endpoint defaults remain pinned; session overrides are discarded. A retired package selection is reported as unavailable and retains the renderer's neutral fallback until the owner chooses an available package. No package is silently substituted.

A restored server requires loopback, local authentication and fixture World/capability bindings. Historical authority is quarantined, including proposal-mediated authority requests; no live PWCE, recorder or automatic audience adapter is rebound. The interface displays **Restored copy: device actions are quarantined** after fresh sign-in. Audience starts unknown; automatic memory requires fresh scope approval. The authenticated `/api/runtime/v1/recovery` endpoint reports this state. PWCE separately reapplies current incident expiry and prevents its restored World store from starting live. Restoring data does not approve live reactivation.

## Human recovery check

1. Keep the live candidate running. Review the backup and integrity receipt, exact revisions and isolated destination.
2. Sign in to the isolated restored Lifestream URL with current credentials. Check the restored-copy notice, Assistant/profile activation and record histories. Verify a deliberately forgotten synthetic record stays empty. Old sessions and consumed recovery codes must fail.
3. Check that audience is unknown and authority requests return `restored_authority_quarantined`. Apply an appropriate private session scope only for inspection. Check available presentation choices and any unavailable default. Keep live device bindings disabled.
4. Inspect PWCE's separate receipt and retained/expired incident counts. Confirm no recorder, action or away route started.
5. Copy the offline backup key to separate physical custody and test decryption from that copy. A same-host key file is preparation, not disaster-recovery acceptance.

The component tests cover data integrity, newer forgetting, recovered credentials, consumed codes, session revocation, package defaults, unavailable selections, path attacks and runtime quarantine. Database/profile/history/Dreaming/trace/secret requirements in LS-DEP-031 remain broader release criteria; a successful encrypted restore alone does not close that entire requirement.
