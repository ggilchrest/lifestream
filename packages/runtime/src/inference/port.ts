export type InferenceRequest = { sections: readonly { kind: string; content: string; trusted: boolean }[]; deadlineMs?: number };
export type InferenceChunk = { kind: "text" | "done"; text?: string };
export interface InferenceProvider { infer(request: InferenceRequest, signal?: AbortSignal): AsyncIterable<InferenceChunk>; }
