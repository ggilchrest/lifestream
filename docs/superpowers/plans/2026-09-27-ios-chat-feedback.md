# iOS sign-in, conversation feedback and typed chat

Goal: opening the app restores the user's session; microphone, backend and output progress are visible; users can send typed messages and read speech transcriptions and responses.

The operator expressly authorizes saving credentials. Keep password custody in the existing device-only nonsynchronizing Keychain record, never JavaScript storage or a returned bridge field. Validate cookies first, then attempt at most one native password sign-in if expired. OTP codes are never saved and OTP-protected renewal requires a fresh code. Sign-out removes credentials/cookies, retaining connection metadata/preferences. Do not alter server authentication lifetime. Do not start microphone automatically.

NativeVoice owns measured input level and buffer delivery, speech detection, transcription, response generation, audio queue/playback and failures. Fix the reproducible oversized-callback speech-gate discard with callback-independent bounded analysis windows; retain provisional energy-based detection and physical testing gates. Expose safe bounded errors instead of suppressing them. Display three labeled lights plus an input-level meter, with text for ready, active, waiting and failure. No simulated activity in the real app.

NativeText uses the existing authenticated typed-message API and validated SSE contract. Text Send never activates microphone or TTS. Stop cancels pending text; audience/display changes discard stale results. Retain private-display/audience requirements and explain them beside the transcript. Keep settings in Settings.

- [x] Native credential renewal, explicit forget, wrong-password/OTP/offline handling and separate-process tests.
- [x] Variable-sized microphone callback regression, native stage telemetry, no-sample watchdog and useful errors.
- [x] Typed transport success/error/cancel/trace tests through isolated real APIs.
- [x] Main UI lights, text composer/transcript, privacy/cancellation and rendered journeys.
- [x] Scoped lint/native/browser tests, signed operator-local build, install/launch and visual inspection.

Keep all assets/deployment evidence outside Git. No pushes, cloud publication, new camera or microphone activation. Report synthetic/native/software checks separately from hands-on iPhone audio and Keychain acceptance. Preserve broader release gates. Runtime baseline: source821c369, backendc3d4208f with d99ba968 web-auth overlay.

Delivered software verification: seven iOS integration/packaging/native transport tests and eight Swift tests passed; focused eslint and signed iPhone SDK build passed. Build4 installed on the paired phone. Browser main/Settings screenshots inspected. Physical speech, locked/AirPods behavior, and real Keychain force-quit/reopen acceptance remain Human checks; no microphone activated by this verification. Existing low-poly model/animation bundle retained. Prior installs need one successful sign-in to store a password. A previously supplied authenticator code conservatively requests manual renewal because the current server does not return MFA enrollment metadata.
