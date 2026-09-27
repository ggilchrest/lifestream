# iOS connection persistence implementation plan

Goal: retain the configured server, account name and authenticated session across app termination, within the existing server expiry/revocation rules.

Use a native Keychain record with device-only after-first-unlock accessibility and no synchronization. Persist only the origin, account name and scoped session cookies; never passwords, authenticator codes, CSRF tokens, transcripts or audience declarations. The WebView receives connection metadata only. Restore validates the session through the existing API, resets disclosure to unknown, and never starts audio. Sign-out clears the local session even when the server cannot be reached; retain address/account for later sign-in. Changing origin or account clears old cookies before issuing requests. Transient connection failures retain the saved session for retry.

- [x] Add failing native transport persistence probes and rendered restart tests, using isolated accounts/storage.
- [x] Implement SavedConnectionStore, Keychain adapter, transport save/restore/forget methods and bridge methods.
- [x] Restore connection fields and validate sessions at UI startup; handle revoked, offline and overlapping attempts safely.
- [x] Run native, UI, packaging and SDK checks; update existing iOS acceptance instructions.
- [x] Commit generic source only, build a new operator-local signed app preserving bundled assets, install on the paired phone if available, and distinguish physical observations from automated proof.

Files: apps/ios/ios/App/CapApp-SPM/Sources/CapApp-SPM/{NativeTransport,ConnectionStore,AssistantPlugin}.swift; apps/ios/web/{controller.js,index.html}; apps/ios/scripts/test-transport.mjs; apps/ios/test/{transport-probe.swift,integration.test.mjs}; docs/ios-v0.1.md. No backend authentication-policy changes.

Verification: npm --prefix apps/ios test; npm --prefix apps/ios run test:native; focused eslint; xcodebuild Release iphoneos with the existing local signing identity; bundle hash comparison; devicectl installation. Server administrative expiry remains 30 minutes; an expired session asks for the password while preserving its address/account.

The operator added bundled animation toggles and a separate Settings pane. Main retains the avatar, listening/Stop, audio route and immediate privacy controls. Settings owns connection/account, Assistant choice, bundled appearance, animation toggles and background opt-in. Persist Assistant/appearance/animation preferences in the same device-only native record; leave background opt-in and audience declaration unset on cold launch. Only declared bundled body clips are offered, grouped by clip if several states share it. The current private low-poly model declares only Idle; no new authoring/retargeting or false mouth/face capability is implied. Shared renderer gains an optional clip-enabled callback defaulting to all enabled; its existing clients remain unchanged.

Completed: device-only connection/session/preferences implementation, main/Settings UI, and bundled animation switches. Signed build 3 installed and launched on the paired iPhone; physical main screen inspected. Five iOS integration/packaging/persistence tests, six native tests, and ten focused renderer tests pass. Persistence probe uses separate native processes with an isolated file store; real Keychain cold-restart and physical audio acceptance remain Human steps. A final crossfade regression stops disabled prior actions immediately. Browser fixture teardown closes retained connections to avoid hanging after checks.
