import type { RuntimeConfig } from "../config/schema.js";

export type ProviderHealthStatus = "healthy" | "degraded" | "unavailable";
export type ProviderInstanceHealth = {
  id: string;
  implementation: string;
  revision: string;
  status: ProviderHealthStatus;
  fixture: boolean;
  required: boolean;
  reason?: string;
};

type ProviderDescriptor = Omit<ProviderInstanceHealth, "id" | "required">;

const descriptors: Record<string, ProviderDescriptor> = {
  fixture: { implementation: "@lifestream/providers-fixture", revision: "workspace", status: "healthy", fixture: true },
  system: { implementation: "node:system", revision: process.version, status: "healthy", fixture: false },
  unavailable: { implementation: "unavailable-test-provider", revision: "none", status: "unavailable", fixture: false, reason: "provider is intentionally unavailable" },
  "nemo-speech": { implementation: "@lifestream/providers-nemo-speech", revision: "workspace", status: "unavailable", fixture: false, reason: "provider is not configured for this runtime profile" },
  voxcpm: { implementation: "@lifestream/providers-voxcpm", revision: "workspace", status: "unavailable", fixture: false, reason: "provider is not configured for this runtime profile" },
  pwce: { implementation: "@lifestream/providers-pwce", revision: "workspace", status: "unavailable", fixture: false, reason: "provider is not configured for this runtime profile" }
};

export class ProviderRegistry {
  readonly providers: Readonly<Record<string, ProviderInstanceHealth>>;
  constructor(config: RuntimeConfig) {
    const instances: Record<string, ProviderInstanceHealth> = {};
    for (const [id, provider] of Object.entries(config.providers)) {
      const descriptor = descriptors[provider];
      if (!descriptor) throw new Error(`unknown provider: ${provider}`);
      const providerKey = id as keyof RuntimeConfig["providers"];
      instances[id] = Object.freeze({ id, ...descriptor, required: config.providerRequirements[providerKey] === "required" });
    }
    this.providers = Object.freeze(instances);
  }
  get ready(): boolean { return Object.values(this.providers).every((provider) => !provider.required || provider.status === "healthy"); }
  get degraded(): boolean { return Object.values(this.providers).some((provider) => provider.status !== "healthy"); }
}

export const createProviderRegistry = (config: RuntimeConfig): ProviderRegistry => new ProviderRegistry(config);
