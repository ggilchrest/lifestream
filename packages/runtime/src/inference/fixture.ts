import type { InferenceProvider, InferenceRequest, InferenceChunk } from "./port.js";
export class FixtureInferenceProvider implements InferenceProvider { async *infer(request: InferenceRequest, signal?: AbortSignal): AsyncIterable<InferenceChunk> { if (signal?.aborted) return; yield { kind: "text", text: request.sections.map((s) => s.content).join(" ") }; yield { kind: "done" }; } }
