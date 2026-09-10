import type { RuntimeConfig } from "../config/schema.js";
import type { InferenceProvider } from "@lifestream/runtime/inference";
import { FixtureInferenceProvider } from "@lifestream/runtime/inference/fixture";
import { MoonshineSpeechProvider } from "@lifestream/providers-moonshine";
import { OllamaInferenceProvider } from "@lifestream/providers-ollama";
import { SglangInferenceProvider } from "@lifestream/providers-sglang";
import { VoxCpmProvider } from "@lifestream/providers-voxcpm";

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
  unavailable: { implementation: "none", revision: "none", status: "unavailable", fixture: false, reason: "provider is explicitly unavailable in the selected profile" },
  "nemo-speech": { implementation: "@lifestream/providers-nemo-speech", revision: "workspace", status: "unavailable", fixture: false, reason: "provider is not configured for this runtime profile" },
  "moonshine-mlx": { implementation: "@lifestream/providers-moonshine", revision: "390624ed33d594443aa4aa221f5b9f283b545b5a", status: "unavailable", fixture: false, reason: "local Moonshine model has not been probed" },
  "ai5090-development": { implementation: "@lifestream/providers-sglang", revision: "319f741cce68d7914884900c138a1fbb70a42f30", status: "unavailable", fixture: false, reason: "ai5090 development service has not been probed" },
  "ollama-mac-local": { implementation: "@lifestream/providers-ollama", revision: "sha256:124a03c347777e8e4e5955c33610ae01d9d90d8c2a718bfba069c498d5c7f3c9", status: "unavailable", fixture: false, reason: "local Ollama model has not been probed" },
  voxcpm: { implementation: "@lifestream/providers-voxcpm", revision: "workspace", status: "unavailable", fixture: false, reason: "provider is not configured for this runtime profile" },
  pwce: { implementation: "@lifestream/providers-pwce", revision: "workspace", status: "unavailable", fixture: false, reason: "provider is not configured for this runtime profile" }
};

export class ProviderRegistry {
  readonly providers: Record<string, ProviderInstanceHealth>;
  readonly inference?: InferenceProvider;
  readonly stt?: MoonshineSpeechProvider;
  readonly tts?: VoxCpmProvider;
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
    if (config.providers.inference === "ollama-mac-local" && config.inferenceProfile) this.inference = new OllamaInferenceProvider({ endpoint: config.inferenceProfile.endpoint, model: config.inferenceProfile.servedModelName, contextLength: config.inferenceProfile.contextLength });
    if (config.providers.stt === "moonshine-mlx" && config.sttProfile) this.stt = new MoonshineSpeechProvider({ baseUrl: config.sttProfile.endpoint, runtimeRevision: config.sttProfile.runtimeVersion, modelRevision: config.sttProfile.modelRevision, modelArtifactDigest: config.sttProfile.modelArtifactDigest, mappingRevision: config.sttProfile.mappingRevision });
    if (config.providers.tts === "voxcpm" && config.ttsProfile) this.tts = new VoxCpmProvider({ baseUrl: config.ttsProfile.endpoint, voiceBundleKey: config.ttsProfile.voiceBundleKey, voiceBundleRevision: config.ttsProfile.voiceBundleRevision, runtimeRevision: config.ttsProfile.runtimeVersion, modelRevision: config.ttsProfile.modelRevision, mappingRevision: config.ttsProfile.mappingRevision });
  }
  async probe(timeoutMs = 2_000): Promise<void> {
    await Promise.all([this.probeInference(timeoutMs), this.probeStt(timeoutMs), this.probeTts(timeoutMs)]);
  }
  private async probeStt(timeoutMs: number): Promise<void> {
    const current = this.providers.stt;
    if (!current || current.id !== "stt" || this.config.providers.stt !== "moonshine-mlx" || !this.config.sttProfile) return;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.config.sttProfile.endpoint.replace(/\/$/u, "")}/readyz`, { signal: controller.signal });
      const payload = response.ok ? await response.json() as { runtimeRevision?: string; modelRevision?: string; modelArtifactDigest?: string; mappingRevision?: string } : {};
      const healthy = response.ok && payload.runtimeRevision === this.config.sttProfile.runtimeVersion && payload.modelRevision === this.config.sttProfile.modelRevision && payload.modelArtifactDigest === this.config.sttProfile.modelArtifactDigest && payload.mappingRevision === this.config.sttProfile.mappingRevision;
      const { reason: _previousReason, ...base } = current;
      this.providers.stt = Object.freeze({ ...base, status: healthy ? "healthy" : "unavailable", ...(healthy ? {} : { reason: response.ok ? "Moonshine runtime identity changed" : `Moonshine readiness returned HTTP ${response.status}` }) });
    } catch (error) {
      this.providers.stt = Object.freeze({ ...current, status: "unavailable", reason: error instanceof Error && error.name === "AbortError" ? "Moonshine readiness probe timed out" : "Moonshine readiness probe failed" });
    } finally { clearTimeout(timer); }
  }
  private async probeInference(timeoutMs: number): Promise<void> {
    const current = this.providers.inference;
    if (!current || current.id !== "inference" || !this.config.inferenceProfile || !["ai5090-development", "ollama-mac-local"].includes(this.config.providers.inference)) return;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const ollama = this.config.providers.inference === "ollama-mac-local";
      const response = await fetch(`${this.config.inferenceProfile.endpoint.replace(/\/$/u, "")}${ollama ? "/api/tags" : "/health"}`, { signal: controller.signal });
      let healthy = response.ok;
      if (healthy && ollama) {
        const payload = await response.json() as { models?: Array<{ name?: string; model?: string; digest?: string }> };
        const expectedDigest = this.config.inferenceProfile.modelRevision.replace(/^sha256:/u, "");
        healthy = payload.models?.some((model) => (model.name === this.config.inferenceProfile?.servedModelName || model.model === this.config.inferenceProfile?.servedModelName) && model.digest === expectedDigest) === true;
      }
      const { reason: _previousReason, ...base } = current;
      this.providers.inference = Object.freeze({ ...base, status: healthy ? "healthy" : "unavailable", ...(healthy ? {} : { reason: ollama && response.ok ? "configured Ollama model identity changed or is not installed" : `inference health returned HTTP ${response.status}` }) });
    } catch (error) {
      this.providers.inference = Object.freeze({ ...current, status: "unavailable", reason: error instanceof Error && error.name === "AbortError" ? "inference health probe timed out" : "inference health probe failed" });
    } finally { clearTimeout(timer); }
  }
  private async probeTts(timeoutMs: number): Promise<void> {
    const current = this.providers.tts;
    if (!current || current.id !== "tts" || this.config.providers.tts !== "voxcpm" || !this.config.ttsProfile) return;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.config.ttsProfile.endpoint.replace(/\/$/u, "")}/readyz`, { signal: controller.signal });
      const payload = response.ok ? await response.json() as { runtimeRevision?: string; modelRevision?: string; mappingRevision?: string } : {};
      const healthy = response.ok && payload.runtimeRevision === this.config.ttsProfile.runtimeVersion && payload.modelRevision === this.config.ttsProfile.modelRevision && payload.mappingRevision === this.config.ttsProfile.mappingRevision;
      const { reason: _previousReason, ...base } = current;
      this.providers.tts = Object.freeze({ ...base, status: healthy ? "healthy" : "unavailable", ...(healthy ? {} : { reason: response.ok ? "VoxCPM runtime identity changed" : `VoxCPM readiness returned HTTP ${response.status}` }) });
    } catch (error) {
      this.providers.tts = Object.freeze({ ...current, status: "unavailable", reason: error instanceof Error && error.name === "AbortError" ? "VoxCPM readiness probe timed out" : "VoxCPM readiness probe failed" });
    } finally { clearTimeout(timer); }
  }
  get ready(): boolean { return Object.values(this.providers).every((provider) => !provider.required || provider.status === "healthy"); }
  get degraded(): boolean { return Object.values(this.providers).some((provider) => provider.status !== "healthy"); }
}

export const createProviderRegistry = (config: RuntimeConfig): ProviderRegistry => new ProviderRegistry(config);
