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

export type LabRepresentation = "recordOriented" | "conventionOriented";
export type LabCriteria = { id: string; description: string; weight: number };
export type LabExperiment = { experimentId: string; sourceRelationshipId: string; sourceConfigurationRevision: string; representations: LabRepresentation[]; promptVariants: string[]; controlVariants: string[]; scenarioIds: string[]; heldOutScenarioIds: string[]; criteria: LabCriteria[]; repeatedRuns: number; datasetRef: string; sourceSnapshotRef: string; providerRefs: string[]; compilerVersion: string; cacheNamespace: string; grantNamespace: string; liveEffects: false; status: "prepared" | "completed" | "promoted" | "rejected" };
export type LabScenarioResult = { scenarioId: string; representation: LabRepresentation; variant: "unpersonalized" | "current" | "candidate"; run: number; output: Record<string, unknown>; latencyMs: number; tokenCount: number };
export type LabComparison = { experimentId: string; results: LabScenarioResult[]; heldOutExcluded: string[]; variability: Record<string, number>; limitations: string[] };

export function createLabExperiment(input: Omit<LabExperiment, "status" | "liveEffects">): LabExperiment {
  if (!input.experimentId || !input.sourceRelationshipId || !input.sourceConfigurationRevision || input.representations.length < 2 || new Set(input.representations).size < 2 || !input.representations.includes("recordOriented") || !input.representations.includes("conventionOriented")) throw new ReplayBlockedError("Lab requires two distinct supported representations");
  if (!input.criteria.length || input.criteria.some((criterion) => !criterion.id || !criterion.description || !Number.isFinite(criterion.weight) || criterion.weight <= 0)) throw new ReplayBlockedError("Lab criteria must be declared before comparison");
  if (!input.scenarioIds.length || input.heldOutScenarioIds.some((id) => !input.scenarioIds.includes(id)) || input.scenarioIds.some((id) => input.heldOutScenarioIds.includes(id) && input.scenarioIds.indexOf(id) < 0) || !Number.isInteger(input.repeatedRuns) || input.repeatedRuns < 2 || input.repeatedRuns > 10 || input.providerRefs.some((ref) => ref.startsWith("live:"))) throw new ReplayBlockedError("Lab manifest is not bounded or fixture-safe");
  return { ...structuredClone(input), liveEffects: false, status: "prepared" };
}

export async function runLabComparison(experiment: LabExperiment, scenarios: string[], run: (scenarioId: string, representation: LabRepresentation, variant: LabScenarioResult["variant"], repeat: number) => Promise<Omit<LabScenarioResult, "scenarioId" | "representation" | "variant" | "run">>): Promise<LabComparison> {
  if (experiment.status !== "prepared" || experiment.liveEffects || experiment.providerRefs.some((ref) => ref.startsWith("live:"))) throw new ReplayBlockedError("Lab is not prepared for isolated replay");
  const allowed = scenarios.filter((id) => experiment.scenarioIds.includes(id) && !experiment.heldOutScenarioIds.includes(id)).slice(0, 20);
  const results: LabScenarioResult[] = [];
  for (const scenarioId of allowed) for (const representation of experiment.representations) for (const variant of ["unpersonalized", "current", "candidate"] as const) for (let repeat = 0; repeat < experiment.repeatedRuns; repeat++) results.push({ scenarioId, representation, variant, run: repeat, ...(await run(scenarioId, representation, variant, repeat)) });
  const variability: Record<string, number> = {};
  for (const representation of experiment.representations) for (const variant of ["unpersonalized", "current", "candidate"] as const) { const values = results.filter((result) => result.representation === representation && result.variant === variant).map((result) => JSON.stringify(result.output)); variability[`${representation}:${variant}`] = new Set(values).size; }
  return { experimentId: experiment.experimentId, results, heldOutExcluded: [...experiment.heldOutScenarioIds], variability, limitations: ["Synthetic isolated replay only; no live tools, notifications, memory writes or canonical reinforcement.", "Quality is not inferred from latency, token count, engagement or judge scores.", "Held-out scenarios remain excluded from this comparison and Human review is required for fit."] };
}

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
