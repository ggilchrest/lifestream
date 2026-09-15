import type { PwceProfile, RuntimeConfig, SecretRef } from "./schema.ts";
const fields = new Set(["endpoint", "worldRef", "executionEnvironmentRef", "siteRefs", "principalRef", "lifestreamEnvironmentId", "tokenSecretRef", "timeoutMs", "maximumPromptBytes"]);
export function validatePwceProfile(value: unknown, providers: Record<string, unknown>, authority: Record<string, unknown>, secretRefs: Record<string, SecretRef>): PwceProfile | undefined {
  if (providers.world !== "pwce") {
    if (value !== undefined) throw new Error("PWCE configuration requires explicit world-provider selection");
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Selected PWCE world provider requires a profile");
  const profile = structuredClone(value) as Record<string, unknown>;
  if (Object.keys(profile).some(key => !fields.has(key))) throw new Error("Unknown PWCE profile field");
  for (const key of ["worldRef", "principalRef", "lifestreamEnvironmentId", "tokenSecretRef"]) if (typeof profile[key] !== "string" || !profile[key] || (profile[key] as string).length > 128) throw new Error("PWCE profile references must be bounded strings");
  let url: URL; try { url = new URL(String(profile.endpoint)); } catch { throw new Error("PWCE endpoint is invalid"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("PWCE endpoint cannot contain credentials, query or fragment");
  if (!["normal", "live", "test", "replay", "simulation", "dry-run"].includes(String(profile.executionEnvironmentRef))) throw new Error("PWCE execution environment is invalid");
  if (!Array.isArray(profile.siteRefs) || profile.siteRefs.length < 1 || profile.siteRefs.length > 8 || profile.siteRefs.some(value => typeof value !== "string" || !value || value.length > 128) || new Set(profile.siteRefs).size !== profile.siteRefs.length) throw new Error("PWCE sites must be a bounded unique list");
  const secret = secretRefs[String(profile.tokenSecretRef)];
  if (!secret || secret.kind !== "env" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret.name)) throw new Error("PWCE requires an explicit environment secret reference");
  if (providers.capability !== "pwce" || authority.provider !== "pwce") throw new Error("PWCE selection cannot fall back to standalone capability grants");
  profile.timeoutMs ??= 1000; profile.maximumPromptBytes ??= 4096;
  if (!Number.isInteger(profile.timeoutMs) || Number(profile.timeoutMs) < 1 || Number(profile.timeoutMs) > 5000) throw new Error("PWCE preparation deadline must be 1 to 5000 ms");
  if (!Number.isInteger(profile.maximumPromptBytes) || Number(profile.maximumPromptBytes) < 512 || Number(profile.maximumPromptBytes) > 16_384) throw new Error("PWCE prompt budget must be 512 to 16384 bytes");
  return profile as RuntimeConfig["pwceProfile"];
}
