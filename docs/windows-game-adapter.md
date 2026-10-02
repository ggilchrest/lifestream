# Windows native game adapter preparation

The portable SDK supplies a one-peer listener bound only to `127.0.0.1:43183`,
mutual HMAC pairing, bounded typed controller requests, a Lua5.4 peer and separate
local PNG custody. The host supplies an approved credential; none is generated.
The peer uses .NET sockets because the bundled comm receive loop does not safely
preserve partial headers across timeout or stop its header loop on EOF. Framing
still uses ASCII UTF-8 byte length followed by a space, with strict finite bounds.
There is no reconnect, control retry, arbitrary script or model-supplied path.

Build first, then run `node scripts/package-game-adapter-windows.mjs C:\new-output`.
The result includes a copied Node executable and the generic adapter runtime.
`LifestreamGameAdapter.exe adapter-cli.mjs --check` verifies loading only. Activation
requires a trusted host to import `@lifestream/providers-bizhawk`, call
`listenForNativeBizHawk`, and pass `nativeBridgeEnvironment` only to its explicitly
authorized emulator child. The host must supply independent display/core/game/
configuration and decoder qualification, current scope/pins, finite bounds,
reviewed observation acceptance and durable authenticated claims/reconciliation.
Missing callbacks or qualification leave effects unavailable.

The actual Lua entrypoint refuses simulation requests and checks the selected
BizHawk version, SNES system and ROM identity before game observation or input.
Controls use a complete twelve-button vector, finite frame/wall/input leases,
normal speed, neutralization and exact-lease shutdown. Pause acknowledgments need
equal frame samples at increasing monotonic times. Screenshot PNGs are bounded,
digest/frame/time/scope bound, CRC and decompression checked, and expire from local
custody. The transport carries opaque metadata, never image bytes or file paths.
Only dedicated, approved image interpretation may consume raw image bytes.

No visible-state decoder is guessed: native observations contain no decoded RAM
fields. Ordinary save-control remains explicitly unqualified and refused. No
savestate, rewind, cheat, guide, hidden RAM read, credential import or automatic
game launch is supplied. Real graphical play, save flushing/reload, live Tifa
planning, controller outcomes, campaign journal and memory remain separate joined
qualification. Simulated Lua and ROM-free pairing tests establish neither gameplay
competence nor an actual journal/memory pipeline.

The desktop backend route is `http://127.0.0.1:43182/control/`, including same-origin
WebSockets. An approved Windows-loopback forward to Linux-loopback43182 can serve
that route. Port43183 is strictly internal to Windows and needs no LAN firewall or
port proxy. Forwarding43182 does not itself connect the native SDK to Linux's
trusted activity coordinator: authenticated host integration still needs wiring.
Do not expose the native control listener or invent a new credential/authority
scheme to work around that dependency. No route, firewall or forwarding is created
by this package. An optional Windows HTTPS/iOS ingress remains a separate approved
parent operation; the native adapter does not require broader Windows exposure.

The inert `WindowsGameHostClient` implements the shared
`@lifestream/contracts/game-host` authenticated HTTP contract (see
`game-host-rpc-v1.txt`) over the existing Windows-loopback43182 forward. Its
caller supplies an existing authenticated fetch, immutable installation/scope
metadata, independently current source qualification, a trusted native factory,
and exact-old-lease shutdown. The factory must install the supplied boundary at
the SDK's final native entry and resolve only after `await transport.ready`
confirms mutual authentication. Admission must not precede a handshake wait.
Never double-wrap an already guarded adapter.
`/admit` runs once in the final observation/action/release callback before I/O;
release additionally requires independently trusted shutdown intent. Shared JSON,
attachment metadata and accepted ingress never qualify native evidence or
coordinator settlement. A lost admission/result reply fences without retry.

One bounded poll continues alongside one operation. Closed schemas, canonical
digests, exact correlation, response stream byte limits, original deadlines and
local monotonic limits fence replay, expiry, cancellation, revocation and denied
transport. The client pursues the captured original input lease through its
separate shutdown port; abort alone never proves pause or neutralization. No
save RPC is supported. `WindowsHostLifecycle` remains an optional generic finite
in-process lifecycle utility. Neither class creates a channel without trusted
ports, reconnects, starts an emulator or supplies live authority.
An inherited Node IPC channel proves a mechanism only. Cookies/session authority
must stay in trusted desktop/main code; separate-host messages use private
inherited IPC. CLI arguments, renderer messages and IPC presence do not authorize
attachment, pairing or gameplay. The CLI remains a loader/readiness check only.
