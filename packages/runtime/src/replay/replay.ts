import type { TraceEvent } from "../observability/outbox.ts";

export type ReplayManifest = {
  replayId: string;
  sourceTraceId: string;
  executionMode: "replay";
  artifactRefs: string[];
  providerRefs: string[];
  liveRoute: false;
};

export type ReplayEvent = TraceEvent & { eventType?: string; liveEffect?: boolean; sourceEventIds?: string[] };
export type ReplayComparison = { replayId: string; sourceEventIds: string[]; replayEventIds: string[]; equal: boolean; reason?: string };
export type ReplayRunnerOptions = { idFactory?: (sourceEventId: string, index: number) => string; run?: (event: ReplayEvent) => Promise<Record<string, unknown>> };

export class ReplayBlockedError extends Error { constructor(message: string) { super(message); this.name = "ReplayBlockedError"; } }

export function createReplayManifest(input: Omit<ReplayManifest, "executionMode" | "liveRoute">): ReplayManifest {
  if (input.artifactRefs.length === 0) throw new ReplayBlockedError("replay requires pinned artifacts");
  if (input.providerRefs.some((ref) => ref.startsWith("live:"))) throw new ReplayBlockedError("replay cannot use a live provider route");
  return { ...structuredClone(input), executionMode: "replay", liveRoute: false };
}

export async function replayTrace(events: ReplayEvent[], manifest: ReplayManifest, options: ReplayRunnerOptions = {}): Promise<{ events: ReplayEvent[]; comparison: ReplayComparison }> {
  if (manifest.executionMode !== "replay" || manifest.liveRoute) throw new ReplayBlockedError("replay must be isolated from live effects");
  if (manifest.artifactRefs.length === 0 || manifest.providerRefs.some((ref) => ref.startsWith("live:"))) throw new ReplayBlockedError("replay manifest is not fixture-safe");
  const idFactory = options.idFactory ?? ((sourceId, index) => `${manifest.replayId}:${index}:${sourceId}`);
  const replayed: ReplayEvent[] = [];
  for (const [index, source] of events.entries()) {
    if (source.liveEffect || source.payload.liveRoute === true || source.payload.credential) throw new ReplayBlockedError(`live effect in event ${source.id}`);
    const payload = options.run ? await options.run(structuredClone(source)) : structuredClone(source.payload);
    replayed.push({ ...structuredClone(source), id: idFactory(source.id, index), traceId: manifest.replayId, payload, sourceEventIds: [source.id] });
  }
  const sourceOutputs = events.map((event) => JSON.stringify(event.payload));
  const replayOutputs = replayed.map((event) => JSON.stringify(event.payload));
  return { events: replayed, comparison: { replayId: manifest.replayId, sourceEventIds: events.map((event) => event.id), replayEventIds: replayed.map((event) => event.id), equal: JSON.stringify(sourceOutputs) === JSON.stringify(replayOutputs) } };
}
