import type { InferenceProvider, InferenceRequest, InferenceChunk, ProviderCallContext } from "./port.js";
export class FixtureInferenceProvider implements InferenceProvider {
  async *generate(request: InferenceRequest, context: ProviderCallContext): AsyncIterable<InferenceChunk> {
    if (context.signal.aborted || request.executionMode === "replay") return;
    if (request.scope.sessionId.startsWith("discovery-analysis:")) {
      let refs: string[] = [];
      try {
        const memory = JSON.parse(request.sections.find(section => section.kind === "preparedMemory")?.content ?? "{}");
        refs = Array.isArray(memory?.evidence) ? memory.evidence.map((item: { ref?: unknown }) => item?.ref).filter((ref: unknown): ref is string => typeof ref === "string" && ref.length > 0) : [];
      } catch { /* The analysis boundary performs the authoritative validation. */ }
      const support = refs[0] ?? "evidence:fixture";
      const alternate = refs[1] ?? support;
      yield { kind: "text", text: JSON.stringify({
        explanations: [
          { summary: "The supplied evidence may reflect a stated preference.", traitRefs: [], supportEvidenceRefs: [support], counterEvidenceRefs: [], boundary: "Tentative interpretation of this evidence only." },
          { summary: "The supplied evidence may reflect a bounded context rather than a stable preference.", traitRefs: [], supportEvidenceRefs: [alternate], counterEvidenceRefs: [], boundary: "This alternative remains tentative and does not establish a durable preference." }
        ],
        unknownAlternative: "The reason may be unrelated to the supplied evidence.",
        uncertainty: "The fixture preserves uncertainty and does not establish a personal motive."
      }) };
      yield { kind: "done" };
      return;
    }
    yield { kind: "text", text: `Fixture response: ${request.sections.at(-1)?.content ?? ""}` };
    yield { kind: "done" };
  }
}
