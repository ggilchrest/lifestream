/** Model-output framing only. These records grant no output or tool authority. */
export const VOICE_RESPONSE_VERSION = "voice-response/1" as const;
export const voiceResponseBounds = Object.freeze({ frameBytes: 4096, wireBytes: 65536, textCharacters: 16384, units: 128, speechCharacters: 720 });
export type VoiceResponseHeader = { version: typeof VOICE_RESPONSE_VERSION };
export type VoiceResponseUnit = { channel: "speech" | "display"; text: string };
