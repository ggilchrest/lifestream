# Session disclosure on a remembered endpoint

Protect → Session disclosure controls whether the current signed-in session may use approved private relationship context. Apply Session Disclosure saves the choice; Refresh Session State reads the current choice and its revision. This does not identify people nearby, start capture, or grant tool authority. Audience privacy must separately permit private output.

Changing disclosure preserves this session's current text/audio negotiation. A fresh or unbound sign-in starts in text mode. Use Structured session settings to change its mode explicitly; another sign-in does not inherit that choice.

A fresh sign-in opens Session disclosure while the audience is unknown. Leave disclosure unknown and apply once to bind this session to the endpoint. If you are alone, use Only me; then explicitly choose and apply private disclosure if wanted. Declaring Only me alone does not grant private context. The disclosure controls stay usable when the audience is unknown or shared, while private details, Assistant records and Appearance remain protected. Initial account setup retains the Account page for recovery-code review; audience protection still applies.

A remembered endpoint shares its identity and saved Appearance default across sign-ins by the same account. It does not share disclosure, negotiated text/audio mode, or session appearance overrides. Tabs using the same authentication cookie share one session; use another browser profile or isolated browser context to test separate sign-ins. Changing either session does not grant or revoke the other session's disclosure or negotiate audio for it. Output and prepared private context remain subject to current authentication, audience and session fences.

The direct session API accepts exact string choices and a nonnegative safe integer revision. Arrays and other values are rejected without changing disclosure or enabling an unconfigured audio transport. Authentication is checked again after the full request arrives: signing out, revoking the account or reaching administration expiry while a request is pending prevents its later settings change.

Schema migration 50 stores disclosure and modalities per session. Older endpoint metadata cannot prove which session chose it, so pre-upgrade sessions fall back to unknown audience and text until they make a fresh choice. Explicit settings survive a normal server restart on the same origin; a new sign-in starts with unknown disclosure. A new server origin requires authentication again. Unbinding clears only that session's settings.

An isolated candidate restore revokes sessions, clears session settings and appearance overrides, and preserves endpoint Appearance defaults. It requires fresh authentication, disclosure and applicable audience approval before private use. Restoration does not reactivate memory collection or physical devices.

Verification covers real local-password HTTP sessions, prepared memory isolation with synthetic records and a fixture inference provider, database restart, legacy migration, stale revision rejection and restore quarantine. Rendered browser checks exercise the selection controls with distinct authenticated sessions. These checks do not establish physical audience detection, microphone permission, audible playback, provider qualification or Human acceptance.

The read-only Effective endpoint configuration panel composes current session, active Assistant/persona and voice references, pinned Appearance selections and the current session audio lease. It explains precedence, compatibility and unavailable handoff operations. Refresh after another tab changes settings. Saved choices are not proof of actual playback, physical capture or audibility. Unknown/shared audiences conceal this inspector and its API requires current administration access. The panel is usable without a renderer or private asset pack.

Appearance changes wait for turns and playback to finish, including preview audio that has finished generating but is still queued at the endpoint. If sign-out, session settings or playback changes while a save is arriving, the save is rejected without changing the stored selection. Sign in again when needed, wait for playback to finish, then refresh and retry. Appearance defaults and session overrides do not replace the active Assistant or saved voice; a reviewed voice activation creates a new Assistant profile revision and invalidates an older handoff review.

## Structured session settings

In Session disclosure, **Structured session settings** supports a bounded JSON definition for this sign-in:

```json
{"schemaVersion":"1.0.0","mode":"text","audienceScope":"unknown"}
```

**Load current settings** refreshes the document and session revision. Edit/paste only `mode` (`text` or `audio`) and `audienceScope` (`unknown` or `authenticatedSession`). **Preview changes** validates the definition and shows a difference without saving. **Apply reviewed changes** revises the existing session atomically and fences pending output whose input scope changed. Other sign-ins retain independent settings. **Download current settings** exports only the last loaded/applied settings, without session IDs, credentials, assets or grants. Imported text cannot activate itself.

An audio definition requires configured STT and TTS; it negotiates the existing transport and does not start capture or playback. Current provider health remains visible in Effective endpoint configuration. Disclosure still requires permitted current audience and existing approved memory scope. Stale revisions, changed runtime/audience state, invalid fields and edited previews require a fresh review. A failed/uncertain network response must be reconciled with Load current settings before retrying.

The authenticated `/api/runtime/v1/session-definition` GET returns the current projection. POST accepts `operation: preview` or `apply`, the definition and `expectedRevision`; apply additionally supplies the preview `reviewDigest`. The digest fences the proposed definition against the current authenticated session and runtime boundary; it never grants authority. There is no canonical settings store separate from the existing session operation. Identity/persona, voice, appearance, accessibility, interruption policy, physical bindings and handoff retain their existing owners and separate controls; this limited document does not redefine or bulk-activate them.
