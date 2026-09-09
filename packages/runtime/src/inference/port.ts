export type InferenceSection = { kind: string; content: string; trusted: boolean; sourceRevision: string; sourceRef: string; contentDigest: string; redaction: "none" | "redacted"; tokenCount: number };
export type InferenceRequest = { sections: readonly InferenceSection[]; manifest: InputManifest; deadlineAt: string; executionMode: "live" | "replay"; scope: { assistantId: string; sessionId: string; interactionId: string; endpointId: string | null } };
export type InputManifest = { schemaVersion: "1.0.0"; sections: readonly Pick<InferenceSection, "kind" | "sourceRevision" | "sourceRef" | "contentDigest" | "redaction" | "tokenCount">[]; tokenizer: string };
export type ProviderCallContext = { signal: AbortSignal };
export type InferenceChunk = { kind: "text" | "capabilityRequest" | "done" | "error"; text?: string; capability?: { name: string; input: Record<string, unknown>; effect: "read-only" } ; error?: { code: string; message: string } };
export interface InferenceProvider { generate(request: InferenceRequest, context: ProviderCallContext): AsyncIterable<InferenceChunk>; }
