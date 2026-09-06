export type Profile = "test" | "local-dev";
export type SecretRef = { kind: "env"; name: string };
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
  storage: { databasePath: string; artifactDirectory: string };
  authority: { provider: string; authentication: string };
  secretRefs: Record<string, SecretRef>;
};

export const isProfile = (value: unknown): value is Profile => value === "test" || value === "local-dev";
