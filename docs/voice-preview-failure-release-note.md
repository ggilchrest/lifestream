# Saved voice preview when audio cannot start

If your device cannot initialize audio for a saved-voice preview, the preview now stops and shows the error instead of remaining marked active. No voice is marked reviewed. You can retry when audio is available.

Review the [synthetic QA checks](voice-preview-failure-qa.md), especially initialization failure and stopping while initialization is pending. The synthetic failure-path checks and the separate saved-voice browser journey passed in disposable fixtures on 2026-11-16. Real-device playback remains separate. The change has not been released or deployed.
