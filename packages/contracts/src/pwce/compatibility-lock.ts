export type GatewayArtifact = { readonly path: string; readonly sha256: string };
export type PwceCompatibilityLock = {
  readonly lockVersion: "1.0.0";
  readonly pwceBundle: { readonly bundleId: "pwce-agent-gateway.bundle.v1"; readonly bundleVersion: "1.0.0"; readonly bundleDigest: string; readonly profileId: "pwce-agent-gateway.v1"; readonly profileVersion: "1.0.0"; readonly artifacts: readonly GatewayArtifact[]; readonly generatedClientSha256: string };
  readonly lifestreamProfile: { readonly profileId: "lifestream-pwce.v1"; readonly profileVersion: "1.0.0"; readonly mappingSchemaSha256: string; readonly fixtureSha256: string };
  readonly requiredOperations: readonly string[];
  readonly adapterRevision: string;
};

export const PWCE_GATEWAY_ARTIFACTS = Object.freeze([
  { path: "contracts/gateway/operation-catalog.json", sha256: "51bfb941913fc27578dc3c4b3ca038d4bfdf4433eda72f2069173503e7b19a0c" },
  { path: "contracts/gateway/pwce-agent-gateway-profile.schema.json", sha256: "268a4e670ba9b32457725944c87ec46fda7dda821dc2f48fc5d8ff022f434e36" },
  { path: "contracts/gateway/pwce-agent-gateway-request.schema.json", sha256: "56fdd84719ddbe6d5d2a9644e9079b25df2e719dcbf0a9e33b3bf16d79760175" },
  { path: "contracts/gateway/pwce-agent-gateway-response.schema.json", sha256: "06fc6a9635c192329d43723f596330a336f1f3e57edd05e7d634110ebbb6f9ae" },
  { path: "contracts/gateway/pwce-lifestream-compatibility-lock.schema.json", sha256: "25fe08baaf362deb929abdb99980a7911fc6b63a4cbaf651749d66b021ffd78e" },
] as const);
export const PWCE_GENERATED_CLIENT_SHA256 = "2b5bc339e0e50b021af274d042a99e2443be8ce241adc7ff1db547cb1a12e96c";
export const REQUIRED_PWCE_OPERATIONS = Object.freeze(["context.getPreparedInputs", "context.query", "evidence.get", "events.subscribe", "authority.evaluate", "authority.authorizeDispatch", "authority.getGrants", "capabilities.getSnapshot", "capabilities.invoke", "capabilities.getInvocation", "trace.publish", "health.get"]);

export function createPwceCompatibilityLock(adapterRevision: string): PwceCompatibilityLock {
  if (!adapterRevision.trim()) throw new Error("adapter revision required");
  return { lockVersion: "1.0.0", pwceBundle: { bundleId: "pwce-agent-gateway.bundle.v1", bundleVersion: "1.0.0", bundleDigest: "3af96275bc26754a8cebc64febb10b5ca50c951fd5003f106e06cfda846d4d3b", profileId: "pwce-agent-gateway.v1", profileVersion: "1.0.0", artifacts: [...PWCE_GATEWAY_ARTIFACTS], generatedClientSha256: PWCE_GENERATED_CLIENT_SHA256 }, lifestreamProfile: { profileId: "lifestream-pwce.v1", profileVersion: "1.0.0", mappingSchemaSha256: "8daa8430d96db08631f950a86a757b5e49cbdec635db5a604a141100afd9998d", fixtureSha256: "9554ff2ddd4c1e1564961d1d1a9d0e8e98dc03088e0443967f1279a15e02df39" }, requiredOperations: [...REQUIRED_PWCE_OPERATIONS], adapterRevision };
}

export function validatePwceCompatibilityLock(lock: PwceCompatibilityLock): void {
  if (lock.lockVersion !== "1.0.0" || lock.pwceBundle.bundleId !== "pwce-agent-gateway.bundle.v1" || lock.pwceBundle.bundleVersion !== "1.0.0" || lock.pwceBundle.bundleDigest !== "3af96275bc26754a8cebc64febb10b5ca50c951fd5003f106e06cfda846d4d3b" || lock.pwceBundle.profileId !== "pwce-agent-gateway.v1" || lock.pwceBundle.profileVersion !== "1.0.0") throw new Error("unsupported PWCE compatibility lock");
  if (JSON.stringify(lock.pwceBundle.artifacts) !== JSON.stringify(PWCE_GATEWAY_ARTIFACTS)) throw new Error("PWCE artifact digest mismatch");
  if (lock.pwceBundle.generatedClientSha256 !== PWCE_GENERATED_CLIENT_SHA256) throw new Error("PWCE generated client digest mismatch");
  if (JSON.stringify(lock.requiredOperations) !== JSON.stringify(REQUIRED_PWCE_OPERATIONS)) throw new Error("required operation coverage mismatch");
  if (lock.lifestreamProfile.profileId !== "lifestream-pwce.v1" || lock.lifestreamProfile.profileVersion !== "1.0.0") throw new Error("unsupported Lifestream mapping profile");
}
