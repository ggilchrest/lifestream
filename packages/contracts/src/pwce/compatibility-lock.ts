export type GatewayArtifact = { readonly path: string; readonly sha256: string };
/** Lifestream's dependency pin. Product-level accepted revision pairs belong to composition. */
export type PwceConsumerPin = {
  readonly pinVersion: "1.0.0";
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
  { path: "contracts/gateway/pwce-agent-gateway-authority-request.schema.json", sha256: "c88e5eb7bb98c867ed5e0a2bf71c4e58f012aa068ecd8fc93cd40caecc42b318" },
  { path: "contracts/gateway/pwce-agent-gateway-authority-response.schema.json", sha256: "b064fc855886a63beb7ca934cdef8f2c51a20e9244c399a0d19afeb635a2c82f" },
] as const);
export const PWCE_GENERATED_CLIENT_SHA256 = "fdb2a5a425b1a54e0d41c923e6ae701eb865e710334869c885b499f06abde175";
export const LIFESTREAM_PWCE_MAPPING_SCHEMA_SHA256 = "8daa8430d96db08631f950a86a757b5e49cbdec635db5a604a141100afd9998d";
export const LIFESTREAM_PWCE_FIXTURE_SHA256 = "9554ff2ddd4c1e1564961d1d1a9d0e8e98dc03088e0443967f1279a15e02df39";
export const REQUIRED_PWCE_OPERATIONS = Object.freeze(["context.getPreparedInputs", "context.query", "evidence.get", "events.subscribe", "authority.evaluate", "authority.authorizeDispatch", "authority.getGrants", "capabilities.getSnapshot", "capabilities.invoke", "capabilities.getInvocation", "trace.publish", "health.get"]);

export function createPwceConsumerPin(adapterRevision: string): PwceConsumerPin {
  if (!adapterRevision.trim()) throw new Error("adapter revision required");
  return { pinVersion: "1.0.0", pwceBundle: { bundleId: "pwce-agent-gateway.bundle.v1", bundleVersion: "1.0.0", bundleDigest: "32c555ba675b61b4c1ec82245e314a8f6ca537484defbeb48b9fe1b6bdf4e2e2", profileId: "pwce-agent-gateway.v1", profileVersion: "1.0.0", artifacts: [...PWCE_GATEWAY_ARTIFACTS], generatedClientSha256: PWCE_GENERATED_CLIENT_SHA256 }, lifestreamProfile: { profileId: "lifestream-pwce.v1", profileVersion: "1.0.0", mappingSchemaSha256: LIFESTREAM_PWCE_MAPPING_SCHEMA_SHA256, fixtureSha256: LIFESTREAM_PWCE_FIXTURE_SHA256 }, requiredOperations: [...REQUIRED_PWCE_OPERATIONS], adapterRevision };
}

export function validatePwceConsumerPin(pin: PwceConsumerPin): void {
  if (pin.pinVersion !== "1.0.0" || pin.pwceBundle.bundleId !== "pwce-agent-gateway.bundle.v1" || pin.pwceBundle.bundleVersion !== "1.0.0" || pin.pwceBundle.bundleDigest !== "32c555ba675b61b4c1ec82245e314a8f6ca537484defbeb48b9fe1b6bdf4e2e2" || pin.pwceBundle.profileId !== "pwce-agent-gateway.v1" || pin.pwceBundle.profileVersion !== "1.0.0") throw new Error("unsupported PWCE consumer pin");
  if (JSON.stringify(pin.pwceBundle.artifacts) !== JSON.stringify(PWCE_GATEWAY_ARTIFACTS)) throw new Error("PWCE artifact digest mismatch");
  if (pin.pwceBundle.generatedClientSha256 !== PWCE_GENERATED_CLIENT_SHA256) throw new Error("PWCE generated client digest mismatch");
  if (JSON.stringify(pin.requiredOperations) !== JSON.stringify(REQUIRED_PWCE_OPERATIONS)) throw new Error("required operation coverage mismatch");
  if (pin.lifestreamProfile.profileId !== "lifestream-pwce.v1" || pin.lifestreamProfile.profileVersion !== "1.0.0") throw new Error("unsupported Lifestream mapping profile");
  if (pin.lifestreamProfile.mappingSchemaSha256 !== LIFESTREAM_PWCE_MAPPING_SCHEMA_SHA256 || pin.lifestreamProfile.fixtureSha256 !== LIFESTREAM_PWCE_FIXTURE_SHA256) throw new Error("Lifestream mapping digest mismatch");
  if (!pin.adapterRevision.trim()) throw new Error("adapter revision required");
}
