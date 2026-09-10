import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Profile, ProviderRequirement, RuntimeConfig, SecretRef } from "./schema.js";

type ConfigInput = Partial<RuntimeConfig> & { [key: string]: unknown };
type ConfigSources = { defaults: ConfigInput; profile: ConfigInput; environment: ConfigInput; cli: ConfigInput };

const keys = new Set(["profile", "providers", "providerRequirements", "inferenceProfile", "ttsProfile", "storage", "authority", "secretRefs"]);
const providerKeys = new Set(["inference", "memory", "stt", "tts", "world", "capability", "renderer", "clock"]);
const storageKeys = new Set(["databasePath", "artifactDirectory"]);
const authorityKeys = new Set(["provider", "authentication"]);
const requirementKeys = new Set(["inference", "memory", "stt", "tts", "world", "capability", "renderer", "clock"]);
const defaultRequirements: Record<string, ProviderRequirement> = { inference: "required", memory: "required", stt: "required", tts: "required", world: "optional", capability: "optional", renderer: "optional", clock: "required" };
export const isProfile = (value: unknown): value is Profile => value === "test" || value === "local-dev" || value === "ai5090" || value === "mac-local";

const assertObject = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
};

const assertKeys = (value: Record<string, unknown>, allowed: Set<string>, name: string) => {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown ${name} key: ${key}`);
};

const merge = (...sources: ConfigInput[]): ConfigInput => {
  const result: ConfigInput = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        result[key] = { ...((result[key] as Record<string, unknown> | undefined) ?? {}), ...value };
      } else result[key] = value;
    }
  }
  return result;
};

const validateSecretRefs = (value: unknown): Record<string, SecretRef> => {
  const refs = assertObject(value, "secretRefs");
  for (const [key, ref] of Object.entries(refs)) {
    const candidate = assertObject(ref, `secretRefs.${key}`);
    if (candidate.kind !== "env" || typeof candidate.name !== "string" || candidate.name.length === 0) throw new Error(`invalid secret reference: ${key}`);
  }
  return refs as Record<string, SecretRef>;
};

export const loadConfig = (sources: ConfigSources): RuntimeConfig => {
  const merged = merge(sources.defaults, sources.profile, sources.environment, sources.cli);
  assertKeys(merged, keys, "configuration");
  if (!isProfile(merged.profile)) throw new Error("profile must be test, local-dev, ai5090, or mac-local");
  const providers = assertObject(merged.providers, "providers");
  assertKeys(providers, providerKeys, "providers");
  const providerRequirements = { ...defaultRequirements, ...assertObject(merged.providerRequirements ?? {}, "providerRequirements") };
  assertKeys(providerRequirements, requirementKeys, "providerRequirements");
  const inferenceProfile = merged.inferenceProfile === undefined ? undefined : assertObject(merged.inferenceProfile, "inferenceProfile");
  if (inferenceProfile) {
    for (const key of ["runtime", "runtimeVersion", "model", "modelRevision", "servedModelName", "quantization", "endpoint"]) if (typeof inferenceProfile[key] !== "string" || !inferenceProfile[key]) throw new Error(`invalid inference profile value: ${key}`);
    const artifacts = [inferenceProfile.containerImageDigest, inferenceProfile.modelArtifactDigest].filter((value) => typeof value === "string" && value.length > 0);
    if (artifacts.length !== 1) throw new Error("inference profile requires exactly one runtime artifact digest");
    if (typeof inferenceProfile.contextLength !== "number" || !Number.isInteger(inferenceProfile.contextLength) || inferenceProfile.contextLength <= 0 || inferenceProfile.developmentOnly !== true) throw new Error("invalid inference profile limits");
  }
  const ttsProfile = merged.ttsProfile === undefined ? undefined : assertObject(merged.ttsProfile, "ttsProfile");
  if (ttsProfile) {
    for (const key of ["runtime", "runtimeVersion", "model", "modelRevision", "quantization", "endpoint", "voiceBundleKey", "mappingRevision"]) if (typeof ttsProfile[key] !== "string" || !ttsProfile[key]) throw new Error(`invalid TTS profile value: ${key}`);
    if (!Number.isInteger(ttsProfile.voiceBundleRevision) || (ttsProfile.voiceBundleRevision as number) <= 0 || ttsProfile.developmentOnly !== true) throw new Error("invalid TTS profile limits");
  }
  const storage = assertObject(merged.storage, "storage");
  assertKeys(storage, storageKeys, "storage");
  const authority = assertObject(merged.authority, "authority");
  assertKeys(authority, authorityKeys, "authority");
  for (const [key, value] of Object.entries(providers)) if (typeof value !== "string" || value.length === 0) throw new Error(`invalid provider: ${key}`);
  for (const [key, value] of Object.entries(storage)) if (typeof value !== "string" || value.length === 0) throw new Error(`invalid storage value: ${key}`);
  for (const [key, value] of Object.entries(authority)) if (typeof value !== "string" || value.length === 0) throw new Error(`invalid authority value: ${key}`);
  if (merged.profile === "test" && Object.values(providers).some((value) => value !== "fixture")) throw new Error("test profile requires fixture providers");
  for (const [key, value] of Object.entries(providerRequirements)) if (value !== "required" && value !== "optional") throw new Error(`invalid provider requirement: ${key}`);
  const result = { profile: merged.profile, providers: providers as RuntimeConfig["providers"], providerRequirements: providerRequirements as RuntimeConfig["providerRequirements"], storage: storage as RuntimeConfig["storage"], authority: authority as RuntimeConfig["authority"], secretRefs: validateSecretRefs(merged.secretRefs ?? {}) } as RuntimeConfig;
  if (inferenceProfile) result.inferenceProfile = inferenceProfile as NonNullable<RuntimeConfig["inferenceProfile"]>;
  if (ttsProfile) result.ttsProfile = ttsProfile as NonNullable<RuntimeConfig["ttsProfile"]>;
  return result;
};

export function loadProfile(profile: Profile, profilesDirectory = new URL("./profiles/", import.meta.url)): RuntimeConfig {
  const path = new URL(`${profile}.json`, profilesDirectory);
  const profileConfig = JSON.parse(readFileSync(path, "utf8")) as ConfigInput;
  return loadConfig({ defaults: {}, profile: profileConfig, environment: {}, cli: {} });
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
};

export const redactedDigest = (config: RuntimeConfig): string => createHash("sha256").update(canonical(config)).digest("hex");
