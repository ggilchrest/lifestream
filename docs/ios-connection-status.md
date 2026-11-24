# iOS main-screen connection light

The small light beside the Lifestream heading reports Native transport/session
observations. It is separate from the privacy dot, microphone activity and the
existing main status text. Its screen-reader status and tooltip describe the
state without relying on color.

| Color | Meaning |
| --- | --- |
| Green | A current Native sign-in/session response established authentication, with successful traffic observed within the last 30 monotonic seconds. |
| Amber | Connecting, restoring or retrying; no supported Native observation is available; or the last verification has expired. |
| Red | Unconfigured, signed out, authentication required, or an observed network/server failure. |

A saved URL, stored account, cookie or locally logged-in setting does not establish
green. Authentication must come from the current Native request and a valid
session response. Successful existing 2xx traffic or parsed current WebSocket
messages can keep that authenticated connection fresh. An old-origin callback,
closed socket or late UI snapshot cannot reinstate an older state.

This is a last-observed indicator, not a continuous reachability monitor or a
server/model health guarantee. It adds no heartbeat, backend request or socket.
If an idle connection has no fresh observation for 30 seconds, green becomes
amber. An unobserved disconnection may therefore remain green for that bounded
interval. A new successful request can reverify a known session. A server 5xx
means the server reported a problem; red does not necessarily mean the physical
network is disconnected. Authentication endpoint 4xx or a non-admin 401 clears
indicator authentication. Other permission/privacy failures do not masquerade
as authentication failure or renew green.

Stopping the microphone or normally closing its socket does not imply connection
loss. Abnormal current socket failure does. Successful ongoing speech traffic is
observed without reading or retaining its contents, and uses one coalesced weak
freshness timer rather than a per-packet timer. Privacy locking remains a separate
decision and is never inferred from this light.

Detailed transitions use the existing optional Native diagnostics: the closed
`connection_changed` event and known reason codes. No URL, password, cookie,
token, authenticator code, account identifier, transcript, audio or private
content is included. Diagnostics stay off by default. Recovery flags, collection
permissions, entitlements, endpoint policy and TLS trust are unchanged.

Focused checks live in `ConnectionStatusTests`, `DiagnosticBufferTests`,
`connection-indicator.test.mjs`, `native-connection-status.test.mjs` and
`connection-indicator-layout.test.mjs`. The transport probe intercepts all HTTP
with a synthetic peer and an in-memory connection store. Rendered checks use the
actual main controller with synthetic Native events, block outbound network, and
cover narrow/light/dark/enlarged layouts. These checks do not establish physical
iPhone, current backend, signed-package or voice-quality acceptance; follow the
native build checklist and coordinate those delivery steps separately.
