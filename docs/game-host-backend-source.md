# Disabled native host backend integration

This source slice implements `/api/runtime/v1/game-host` from the shared v1 HTTP
contract. No shipped profile, launcher, environment variable or default creates
the port. `ServerOptions.gameHost` is required, local-password authentication
must exist, and restore quarantine disables the route. An ordinary authenticated
session sees `404 game_host_disabled` unless trusted host options are supplied.

The trusted composition supplies a `createRepository(database)` factory for the
existing `ActivityCheckpointRepository`, finite attachment/duration limits,
independently qualified installation/source binding resolution, current binding
and controller checks, and the existing native boundary's observation, action,
reconciliation and exact-old-lease shutdown qualifiers. Missing source binding or
required receipt/admission qualification fails closed. Client metadata, a healthy
socket and schema validity cannot fill these ports. No account, HMAC key, pairing,
game start/resume, save/load, model call or runtime coordinator is created here.

`onAttached` receives a frozen `GameHostJoin`. Its `runController(input, ports)`
invokes the existing `runCheckpointedGameController` with the same repository and
prepared dispatch selection. The caller supplies current checkpoint/admission
qualification, an abort signal, and independently qualified actual usage. It is
an explicit host join, without a background driver or automatic continuation.
Changing those ports during a call fences that call. Scope/current checks bind
the existing principal and local session to its active conversation, personal
healthy endpoint, assistant permission and owned active relationship. Endpoint,
relationship/context, audience, logout or source changes fence the attachment.
Runtime polls use continuing session checks without refreshing administration.

Migration 68 adds bounded native dispatch metadata linked to an existing
controller reservation. The coordinator first reserves worst-case resources.
The guarded Linux adapter commits a one-time `claimed` row before a command can
be polled. The final `/admit` commits `claimed -> entered` once before Windows may
invoke native I/O. Both transitions temporarily use SQLite WAL synchronous FULL
and restore the legacy connection setting after the synchronous commit. They
recheck current scope/checkpoint/ledger state on both sides of the write. An
unresolved reservation for the same run or native host blocks a new dispatch,
including after close/reopen, detach or a changed run identity.

Cancellation, expiry, disconnect or lost admission/result evidence retain the
claim and held resources. No command/admission/result replay or budget refund is
provided. Incoming result acknowledgement means bounded ingress only; the
existing guarded adapter and coordinator must independently qualify the native
receipt and usage before settlement. Actual qualified terminal evidence can
settle historical accounting; acknowledgement delivery alone is never evidence.
Late or cross-correlated results cannot settle another command. Fencing/detach
does not claim neutralization or a safely paused emulator; those require the
separate exact-old-lease native shutdown evidence. `controlSave` is unavailable.

Publication requires the earlier shared-contract patch first, then this backend
patch. Windows owns native client/packaging and sole publication. The backend
patch changes no providers-bizhawk implementation, protected game schema,
deployed unit, credential, asset, runtime threshold or shared-P2 gate. The lockfile
adds only the existing BizHawk workspace link and retains all platform entries.

Validation uses synthetic local accounts, source qualifiers, game receipts and
loopback fixtures. It proves auth/scope/origin/CSRF fences, actual prepared
coordinator joining, one-time durable dispatch, expiry/cancel/lost evidence,
duplicate/late input rejection, rollback, callback mutation fencing and SQLite
reopen behavior. It does not qualify a real emulator, ROM, native shutdown,
authority channel or live game session.
