// Ephemeral conversation-test overrides, not a persisted Assistant VoiceProfile.
export const deliveryModes = ["neutral", "explanation", "reassurance", "concern", "celebration", "warning", "emergency"] as const;
export type VoiceReference = { dataBase64: string; sampleRateHz: 16000; transcript: string; consent: true };
export type VoiceSettings = { description: string; seed: number; deliveryMode: typeof deliveryModes[number]; pace: number; energy: number; reference: VoiceReference | null };
export const defaultVoiceSettings: Readonly<VoiceSettings> = Object.freeze({ description: "", seed: 0, deliveryMode: "neutral", pace: 0.5, energy: 0.4, reference: null });
export function parseVoiceSettings(value: unknown): VoiceSettings {
  if (value === undefined) return { ...defaultVoiceSettings };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Voice settings must be an object");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !Object.hasOwn(defaultVoiceSettings, key))) throw new Error("Unknown voice setting");
  const settings = { ...defaultVoiceSettings, ...data };
  if (typeof settings.description !== "string" || settings.description.length > 300 || /[()\r\n\x00-\x1f]/u.test(settings.description)) throw new Error("Voice description must be up to 300 characters without parentheses or line breaks");
  if (!Number.isInteger(settings.seed) || settings.seed < 0 || settings.seed > 2147483647) throw new Error("Seed must be an integer from 0 to 2147483647");
  if (!deliveryModes.includes(settings.deliveryMode)) throw new Error("Unsupported delivery tone");
  for (const key of ["pace", "energy"] as const) if (typeof settings[key] !== "number" || !Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 1) throw new Error(`${key} must be between 0 and 1`);
  if (settings.reference !== null) {
    const ref = settings.reference;
    if (!ref || typeof ref !== "object" || Array.isArray(ref) || Object.keys(ref).some(key => !["dataBase64", "sampleRateHz", "transcript", "consent"].includes(key))) throw new Error("Invalid voice reference");
    if (ref.consent !== true) throw new Error("Confirm permission to use the reference voice");
    if (ref.sampleRateHz !== 16000 || typeof ref.dataBase64 !== "string" || ref.dataBase64.length > 853336 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(ref.dataBase64)) throw new Error("Reference must be 16 kHz mono PCM");
    const size = Buffer.from(ref.dataBase64, "base64").length;
    if (size < 64000 || size > 640000 || size % 2) throw new Error("Reference must be 2–20 seconds");
    if (typeof ref.transcript !== "string" || ref.transcript.length > 1000) throw new Error("Reference transcript must be up to 1000 characters");
    settings.reference = { ...ref, transcript: ref.transcript.trim() };
  }
  return { ...settings, description: settings.description.trim() };
}
