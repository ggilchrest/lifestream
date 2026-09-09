import type { InferenceProvider, InferenceRequest, InferenceChunk, ProviderCallContext } from "./port.js";
export class FixtureInferenceProvider implements InferenceProvider {
  async *generate(request: InferenceRequest, context: ProviderCallContext): AsyncIterable<InferenceChunk> { if (context.signal.aborted || request.executionMode === "replay") return; yield { kind: "text", text: `Fixture response: ${request.sections.at(-1)?.content ?? ""}` }; yield { kind: "done" }; }
}
