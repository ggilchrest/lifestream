export type Profile = "test" | "local-dev" | "ai5090" | "mac-local";
export type SecretRef = { kind: "env"; name: string };
export type ProviderRequirement = "required" | "optional";
export type RuntimeConfig = {
  profile: Profile;
  providers: {
    inference: string;
    memory: string;
    stt: string;
    tts: string;
    world: string;
    capability: string;
    renderer: string;
    clock: string;
  };
  providerRequirements: Record<keyof RuntimeConfig["providers"], ProviderRequirement>;
  inferenceProfile?: { runtime: string; runtimeVersion: string; model: string; modelRevision: string; servedModelName: string; quantization: string; contextLength: number; endpoint: string; containerImageDigest?: string; modelArtifactDigest?: string; developmentOnly: true };
  sttProfile?: { runtime: string; runtimeVersion: string; model: string; modelRevision: string; endpoint: string; modelArtifactDigest: string; mappingRevision: string; language: string; developmentOnly: true };
  ttsProfile?: { runtime: string; runtimeVersion: string; model: string; modelRevision: string; quantization: string; endpoint: string; voiceBundleKey: string; voiceBundleRevision: number; mappingRevision: string; developmentOnly: true };
  storage: { databasePath: string; artifactDirectory: string };
  authority: { provider: string; authentication: string };
  secretRefs: Record<string, SecretRef>;
};

export const isProfile = (value: unknown): value is Profile => value === "test" || value === "local-dev" || value === "ai5090" || value === "mac-local";
