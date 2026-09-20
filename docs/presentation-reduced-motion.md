# Presentation accessibility

The browser or native display uses its current `prefers-reduced-motion` preference. When reduced motion is on, automatic body animation holds its current pose and automatic blink/gaze layers are suppressed. Semantic conversation status continues updating; accessibility does not change Assistant identity, memory, audience, voice or authority.

The appearance panel reports the active preference and whether an explicitly requested five-second preview is running. Explicit body/face previews remain available and End preview stops them. A change to the display preference cancels an existing preview; timeout, new playback, interaction, scope change, navigation and privacy cleanup retain their existing cancellation rules. Body animation resumes with current semantic intent when the preference is off.

Mouth movement driven by actual endpoint audio playback remains available in reduced motion. It returns to rest when playback stops; this is an amplitude indicator, not phoneme alignment or proof of physical audibility. Effective endpoint configuration reports the preference as a local browser observation, separate from server settings and physical audience claims. No preference or consent is copied during handoff.

Verification uses real Three.js animation, rendered browser/native controls, media-preference changes, bounded previews and synthetic playback samples. No microphone or camera is opened. Physical preference behavior and perceived comfort still require Human review.
