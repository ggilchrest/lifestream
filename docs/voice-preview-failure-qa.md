# Check a saved-voice preview when audio cannot start

Use the maintainer’s disposable synthetic fixture. Do not connect a real voice provider, microphone, speaker or account.

1. Choose the synthetic Assistant and refresh its saved voices. Pick the synthetic voice.
2. Make the fixture reject audio initialization, then select “Preview Synthetic voice”. The error should appear, “Stop voice preview” should be disabled and “I reviewed this voice” should remain unavailable. No TTS request should be sent.
3. Repeat with a failed audio resume. You should see the failure and the preview should not remain active.
4. Hold audio initialization, start a preview, then select “Stop voice preview” before releasing initialization. The late completion must not send a TTS request or restart the preview.
5. Once audio is available, run the original reviewed-voice journey separately to check synthetic playback and activation. A failure-path check does not establish audible playback or physical-device acceptance.

On 2026-11-16, all four synthetic failure-path cases and the separate saved-voice browser journey passed in disposable fixtures. This does not establish audible playback or physical-device acceptance. Do not use the interrupted PWCE browser job, the quarantined Insights runner or a live service for them.
