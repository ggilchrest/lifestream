# iOS Assistant v0.1

An operator-local Capacitor 8 application reuses the existing Three.js presentation runtime and packages generic interface code. Swift owns microphone capture, Apple voice processing, speech WebSocket transport, playback and background lifecycle. The app connects to an existing authenticated Lifestream runtime; it contains no Assistant persona, model, private avatar, provider credential or backend.

## Build and run

Requires Node 24+, Google Chrome for the UI test, Xcode with iOS SDK, and an existing configured Lifestream account and Assistant. The independent npm lock keeps iOS tooling out of server installation. First run the normal repository dependency installation and `pnpm build` so integration tests can use the existing server packages.

```sh
cd apps/ios
npm ci
npm run sync
npm test
npm run test:native
open ios/App/App.xcodeproj
```

Choose the App scheme, your own signing team and a connected iPhone. No team, provisioning profile or signing secret is committed. The bundle identifier is `org.lifestream.assistant`; adjust locally if your team's provisioning requires it. `npm run sync` reattaches the local Swift package after Capacitor regenerates its dependency list. Bundled web output and build products are ignored.

An unsigned compile can be reproduced with:

```sh
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphoneos \
  -configuration Release -derivedDataPath DerivedData CODE_SIGNING_ALLOWED=NO build
```

Release accepts HTTPS server origins only; Debug additionally accepts loopback HTTP for isolated local tests. It never accepts embedded credentials, a path/query in the origin, certificate bypasses or redirects. The native bridge is restricted to bundled `capacitor://localhost` content and a small API allowlist. Passwords/codes are cleared after sign-in; cookies are ephemeral and never given to the WebView. Reopening a terminated app requires sign-in. An account with permission to administer the selected Assistant is required in this first app; subscriber-only mobile accounts are not implemented.

**Physical connection prerequisite:** the current local-password server deliberately accepts only loopback traffic and checks Host/Origin. A physical iPhone cannot reach `127.0.0.1` on the Mac. This change opens no listeners, installs no tunnel, weakens no server guard and deploys nothing. A separately approved private TLS connection that preserves the authenticated backend boundary is required before real phone testing. Do not enter credentials into an untrusted proxy. The server source must include this change's additive `personalCompanion` binding support; the previously installed beta is not silently replaced.

## Included behavior

- Account sign-in with optional TOTP; existing Assistants and session appearance selection.
- Shared neutral renderer/core and digest-checked, authenticated appearance resources; private packs remain server-side, fetched only for a permitted foreground display.
- This initial mobile build limits each appearance resource to 64 MiB; larger existing desktop packages produce an explicit error and retain the current display. Smaller mobile assets must be authored separately; the app does not rewrite private packs.
- Native AVAudioSession play-and-record/voice-chat, AVAudioEngine voice processing, conversion to 16 kHz mono PCM input, native 48 kHz PCM output. No browser microphone or WebAudio lifetime dependency.
- Native bounded energy gate: 160 ms qualification, 300 ms pre-roll, 600 ms silence commit and roughly 20 second utterance cap. This is provisional energy gating after Apple processing, not Silero/speaker recognition and not noise/echo acceptance.
- Sequenced speech messages, retired-turn fences, bounded receive/playback backpressure, cancellation and playback settlement after native played-back callbacks. Foreground amplitude animation is coarse callback-driven; no phoneme timing or precise lip-sync is claimed.
- User-selected continuation when locked. Native network/audio and audience checks continue independently of suspended JavaScript. Lock screen shows only a generic title and Stop/Pause/headset-toggle commands. Resuming after an OS kill or call requires a tap; no wake word or boot-time recording.
- iOS system Bluetooth HFP routing; newly available routes rebuild the native session when needed and recheck audience without combining partial PCM from two routes. Removing headphones stops audio rather than continuing a private reply on the speaker. A system route picker is provided; use Control Center for any route not offered there.
- Audience refresh at most every 500 ms during active audio, with a 1.2 second request timeout and local expiry check. Unreachable/revoked/changed scope stops audio. Manual Only-me declarations expire after five minutes; they do not detect nearby people or establish speaker identity.
- Private display clears when hidden or audience changes; a native shield covers app-switcher snapshots before backgrounding. Shared/unknown mode uses generic labels and withholds private transcript and appearance. No camera is used.

Automatic memory remains a server policy and is not newly enabled by this app. Existing privacy and voice-owner admission rules apply. Mobile push, offline inference, automatic speaker identity, phone-call answering, automatic conversation migration from the Mac and Android are outside this first build.

## Acceptance journeys — physical iPhone required

Record iPhone/iOS version, source revisions, selected runtime/provider identities, network route, headset model and result for each journey. Software/fixture results do not sign off the native audio route. Use a neutral Assistant and non-sensitive prompts first.

1. **Install and connection:** launch; open/close Connection & account; try invalid address, bad password and bad TOTP; confirm useful failure and cleared secret fields. Connect successfully; select an existing Assistant. No microphone starts before Start listening. Sign out and confirm controls/display clear. Relaunch and verify sign-in is required.
2. **Disclosure controls:** sign in; verify shared/unknown generic labels, no private avatar/text and no recalled private memory. Tap Only me; confirm five-minute notice. Change Assistant and Appearance; Apply appearance and Refresh; verify persisted session selection, package failure handling and continued usable conversation controls. Private content must not appear after an overlapping Shared / unknown click.
3. **Microphone permission:** deny the first prompt; Start must recover without a stuck spinner. Enable permission in Settings; tap Start again. Verify the OS microphone indicator and native route label. Tap Stop during setup, recognition, text generation and speech; no late audio or new turn may play.
4. **Speakerphone conversation:** speak several turns at normal and quiet volume; check recognition, output, echo, clipped beginnings, silence commits and noise rejection. Interrupt a reply with speech. Inspect actual provider evidence; an echo fixture response is not real-provider acceptance. Record latency separately against the existing objectives.
5. **Lock without opt-in:** leave Continue this conversation when locked unchecked; Start, then lock/app-switch. Microphone and output must stop. Reopen; tap Start to resume explicitly.
6. **Lock with opt-in:** check Continue this conversation when locked; Start while foreground; lock during listening and during a reply. Ask follow-up turns with the display locked. Native capture/playback must continue; the lock screen must contain no private title or transcript. Test Stop, Pause and AirPods stem/headset toggle; each must stop both microphone and playback. No remote Play action may restart listening.
7. **AirPods and routes:** start on speaker; connect AirPods, use Audio devices/system Control Center and confirm both output and microphone route. Test already-connected AirPods at Start, Bluetooth reconnect, wired headphones and supported routes. An old partial utterance must not become a new mixed-route request. Remove/disconnect headphones mid-private reply: audio stops without continuing on speaker; restart explicitly only after inspecting route.
8. **Phone/system interruption:** incoming call, Siri, alarm, audio-service reset and another recording app. Audio must relinquish appropriately, report the interruption and require a new Start; no surprise resumed recording or doubled output. Check other media resumes after Stop.
9. **Privacy while locked:** Only me + background opt-in; lock and wait past five minutes. The conversation must stop at expiry. Separately revoke sign-in, switch audience or permission on the server during speech. No old reply may resume on reconnect. Reopening must not flash prior transcript/avatar in the app or app switcher.
10. **Network transitions:** switch Wi-Fi/cellular, lose the private tunnel, disable networking and restore it. Expect bounded fail-closed stop rather than a fabricated successful turn. Tap Start after connectivity returns. Verify no duplicate transcript, PCM replay, stale voice ownership or automatic private fallback.
11. **Long session and resource bounds:** run at least 30 minutes with repeated Start/Stop, foreground/background and route transitions. Renew disclosure explicitly between conversations. Inspect battery, thermal behavior, native memory, queue bounds, turn deadlines and quality. OS termination must leave no claim of continued listening; relaunch must not auto-record.
12. **Presentation and accessibility:** portrait/landscape and small screen, VoiceOver, Dynamic Type/reduced motion, appearance failure, wrong resource digest and GPU context loss. All account, disclosure, Assistant, appearance, background, Start/Stop and Audio devices controls remain usable. Native speech must not depend on avatar loading or WebView animation. Check native route-sheet dismissal as well as opening it.

## Evidence and release limits

See `implementation/evidence/IOS-V01-20260925.json` for exact measured software results and source binding. No iOS runtime is installed on the development Mac at the start of this task; unsigned SDK compilation is not simulator execution. Physical audio, lock survival, echo/noise behavior, Bluetooth transitions, latency/battery and Human acceptance remain release gates. Existing Mac/provider failures and prior accepted journeys are preserved.
