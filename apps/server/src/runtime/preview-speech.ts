import { SpeechSafeSegmenter } from "@lifestream/runtime/voice/segmenter";
import type { VoxCpmProvider } from "@lifestream/providers-voxcpm";

type Request = Parameters<VoxCpmProvider["synthesize"]>[0];
type Event = ReturnType<VoxCpmProvider["synthesize"]> extends AsyncIterable<infer T> ? T : never;
type Terminal = Extract<Event, { kind: "terminal" }>;

// A preview is an operation containing canonical speech segments, not one
// arbitrarily long model prompt. Preserve each segment identity, but expose
// one ordered preview stream and one aggregate terminal to the browser.
export async function* synthesizePreview(provider: Pick<VoxCpmProvider, "synthesize">, request: Request, signal?: AbortSignal): AsyncGenerator<Event> {
  const segmenter = new SpeechSafeSegmenter(360);
  const segments = segmenter.push(request.text);
  segments.push(...segmenter.flush());
  let sequence = 0, samples = 0, frames = 0, mappingRevision = "unknown";
  const degraded = new Set<string>();
  const terminal = (outcome: Terminal["outcome"], disposition: Terminal["disposition"]): Terminal => ({ kind: "terminal", sequence: sequence++, segmentId: request.segmentId, outcome, disposition, outputSamples: samples, frameCount: frames, mappingRevision, degradedDimensions: [...degraded] });
  try {
    for (const [index, segment] of segments.entries()) {
      if (Date.now() >= Date.parse(request.deadlineAt)) { yield terminal("timedOut", "timedOut"); return; }
      if (signal?.aborted) { yield terminal("cancelled", "cancelled"); return; }
      const segmentId = `${request.segmentId}:${index}`;
      let succeeded = false, segmentSamples = 0;
      const input = { ...request, text: segment.text, segmentId, delivery: { ...request.delivery, segmentId }, deadlineAt: new Date(Math.min(Date.parse(request.deadlineAt), Date.now() + 45_000)).toISOString() };
      for await (const event of provider.synthesize(input, signal)) {
        if (mappingRevision !== "unknown" && mappingRevision !== event.mappingRevision) throw new Error("preview mapping changed");
        mappingRevision = event.mappingRevision;
        if (event.kind === "preAudio") { for (const dimension of event.degradedDimensions) degraded.add(dimension); yield { ...event, sequence: sequence++ }; }
        else if (event.kind === "data") {
          if (samples + event.frame.sampleCount > 48_000 * 180) throw new Error("preview audio limit exceeded");
          yield { ...event, sequence: sequence++, frame: { ...event.frame, sequence: frames++, sampleOffset: samples } };
          samples += event.frame.sampleCount; segmentSamples += event.frame.sampleCount;
        } else {
          if (event.outcome !== "succeeded") { yield terminal(event.outcome, event.disposition); return; }
          succeeded = true;
        }
      }
      if (!succeeded || !segmentSamples) throw new Error("preview segment did not produce complete audio");
    }
    if (!samples) throw new Error("preview has no audio");
    yield terminal("succeeded", degraded.size ? "partiallyApplied" : "fullyApplied");
  } catch {
    const timedOut = Date.now() >= Date.parse(request.deadlineAt);
    yield terminal(timedOut ? "timedOut" : signal?.aborted ? "cancelled" : "failed", timedOut ? "timedOut" : signal?.aborted ? "cancelled" : "providerFailure");
  }
}
