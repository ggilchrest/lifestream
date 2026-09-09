import type { RuntimeConfig } from "../config/schema.js";
import type { InferenceProvider } from "@lifestream/runtime/inference";
import { FixtureInferenceProvider } from "@lifestream/runtime/inference/fixture";
import { SglangInferenceProvider } from "@lifestream/providers-sglang";

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
  "ai5090-development": { implementation: "@lifestream/providers-sglang", revision: "319f741cce68d7914884900c138a1fbb70a42f30", status: "unavailable", fixture: false, reason: "ai5090 development service has not been probed" },
  voxcpm: { implementation: "@lifestream/providers-voxcpm", revision: "workspace", status: "unavailable", fixture: false, reason: "provider is not configured for this runtime profile" },
  pwce: { implementation: "@lifestream/providers-pwce", revision: "workspace", status: "unavailable", fixture: false, reason: "provider is not configured for this runtime profile" }
};

export class ProviderRegistry {
  readonly providers: Record<string, ProviderInstanceHealth>;
  readonly inference?: InferenceProvider;
  private readonly config: RuntimeConfig;
  constructor(config: RuntimeConfig) {
    this.config = config;
    const instances: Record<string, ProviderInstanceHealth> = {};
    for (const [id, provider] of Object.entries(config.providers)) {
      const descriptor = descriptors[provider];
      if (!descriptor) throw new Error(`unknown provider: ${provider}`);
      const providerKey = id as keyof RuntimeConfig["providers"];
      instances[id] = Object.freeze({ id, ...descriptor, required: config.providerRequirements[providerKey] === "required" });
    }
    this.providers = instances;
    if (config.providers.inference === "fixture") this.inference = new FixtureInferenceProvider();
    if (config.providers.inference === "ai5090-development" && config.inferenceProfile) this.inference = new SglangInferenceProvider({ endpoint: config.inferenceProfile.endpoint, model: config.inferenceProfile.servedModelName, ...(process.env.LIFESTREAM_INFERENCE_API_KEY ? { apiKey: process.env.LIFESTREAM_INFERENCE_API_KEY } : {}) });
  }
  async probe(timeoutMs = 2_000): Promise<void> {
    const current = this.providers.inference;
    if (!current || current.id !== "inference" || this.config.providers.inference !== "ai5090-development" || !this.config.inferenceProfile) return;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.config.inferenceProfile.endpoint.replace(/\/$/u, "")}/health`, { signal: controller.signal });
      const { reason: _previousReason, ...base } = current;
      this.providers.inference = Object.freeze({ ...base, status: response.ok ? "healthy" : "unavailable", ...(response.ok ? {} : { reason: `ai5090 health returned HTTP ${response.status}` }) });
    } catch (error) {
      this.providers.inference = Object.freeze({ ...current, status: "unavailable", reason: error instanceof Error && error.name === "AbortError" ? "ai5090 health probe timed out" : "ai5090 health probe failed" });
    } finally { clearTimeout(timer); }
  }
  get ready(): boolean { return Object.values(this.providers).every((provider) => !provider.required || provider.status === "healthy"); }
  get degraded(): boolean { return Object.values(this.providers).some((provider) => provider.status !== "healthy"); }
}

export const createProviderRegistry = (config: RuntimeConfig): ProviderRegistry => new ProviderRegistry(config);
