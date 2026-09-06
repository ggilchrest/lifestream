import { createHash } from "node:crypto";
import type { RuntimeConfig, SecretRef } from "./schema.js";

type ConfigInput = Partial<RuntimeConfig> & { [key: string]: unknown };
type ConfigSources = { defaults: ConfigInput; profile: ConfigInput; environment: ConfigInput; cli: ConfigInput };

const keys = new Set(["profile", "providers", "storage", "authority", "secretRefs"]);
const providerKeys = new Set(["inference", "memory", "stt", "tts", "world", "capability", "renderer", "clock"]);
const storageKeys = new Set(["databasePath", "artifactDirectory"]);
const authorityKeys = new Set(["provider", "authentication"]);
const isProfile = (value: unknown): value is RuntimeConfig["profile"] => value === "test" || value === "local-dev";

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
  if (!isProfile(merged.profile)) throw new Error("profile must be test or local-dev");
  const providers = assertObject(merged.providers, "providers");
  assertKeys(providers, providerKeys, "providers");
  const storage = assertObject(merged.storage, "storage");
  assertKeys(storage, storageKeys, "storage");
  const authority = assertObject(merged.authority, "authority");
  assertKeys(authority, authorityKeys, "authority");
  for (const [key, value] of Object.entries(providers)) if (typeof value !== "string" || value.length === 0) throw new Error(`invalid provider: ${key}`);
  for (const [key, value] of Object.entries(storage)) if (typeof value !== "string" || value.length === 0) throw new Error(`invalid storage value: ${key}`);
  for (const [key, value] of Object.entries(authority)) if (typeof value !== "string" || value.length === 0) throw new Error(`invalid authority value: ${key}`);
  if (merged.profile === "test" && Object.values(providers).some((value) => value !== "fixture")) throw new Error("test profile requires fixture providers");
  return { profile: merged.profile, providers: providers as RuntimeConfig["providers"], storage: storage as RuntimeConfig["storage"], authority: authority as RuntimeConfig["authority"], secretRefs: validateSecretRefs(merged.secretRefs ?? {}) };
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
};

export const redactedDigest = (config: RuntimeConfig): string => createHash("sha256").update(canonical(config)).digest("hex");
