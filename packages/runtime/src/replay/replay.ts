import type { TraceEvent } from "../observability/outbox.ts";

export type ReplayManifest = {
  replayId: string;
  sourceTraceId: string;
  executionMode: "replay";
  artifactRefs: string[];
  providerRefs: string[];
  liveRoute: false;
  revocationRefs?: string[];
};

export type ReplayEvent = TraceEvent & { eventType?: string; liveEffect?: boolean; sourceEventIds?: string[] };
export type ReplayComparison = { replayId: string; sourceEventIds: string[]; replayEventIds: string[]; equal: boolean; reason?: string };
export type ReplayRunnerOptions = { idFactory?: (sourceEventId: string, index: number) => string; run?: (event: ReplayEvent) => Promise<Record<string, unknown>> };
export type DependencySnapshot = { currentRefs: string[]; revokedRefs: string[] };

export class ReplayBlockedError extends Error { constructor(message: string) { super(message); this.name = "ReplayBlockedError"; } }

export type LabRepresentation = "recordOriented" | "conventionOriented";
export type LabCriteria = { id: string; description: string; weight: number };
export type LabExperiment = { experimentId: string; sourceRelationshipId: string; sourceConfigurationRevision: string; representations: LabRepresentation[]; promptVariants: string[]; controlVariants: string[]; scenarioIds: string[]; heldOutScenarioIds: string[]; criteria: LabCriteria[]; repeatedRuns: number; datasetRef: string; sourceSnapshotRef: string; providerRefs: string[]; compilerVersion: string; cacheNamespace: string; grantNamespace: string; liveEffects: false; status: "prepared" | "running" | "partial" | "failed" | "cancelled" | "completed" | "promoted" | "rejected" };
export type LabScenarioResult = { scenarioId: string; representation: LabRepresentation; variant: "unpersonalized" | "current" | "candidate"; run: number; status?: "completed" | "failed"; error?: string; output: Record<string, unknown>; latencyMs: number; tokenCount: number };
export type LabComparison = { status: "completed" | "partial" | "failed" | "cancelled"; resultCount: number; experimentId: string; results: LabScenarioResult[]; heldOutExcluded: string[]; variability: Record<string, number>; limitations: string[] };

export function createLabExperiment(input: Omit<LabExperiment, "status" | "liveEffects">): LabExperiment {
  if (!input.experimentId || !input.sourceRelationshipId || !input.sourceConfigurationRevision || input.representations.length < 2 || new Set(input.representations).size < 2 || !input.representations.includes("recordOriented") || !input.representations.includes("conventionOriented")) throw new ReplayBlockedError("Lab requires two distinct supported representations");
  if (!input.criteria.length || input.criteria.some((criterion) => !criterion.id || !criterion.description || !Number.isFinite(criterion.weight) || criterion.weight <= 0)) throw new ReplayBlockedError("Lab criteria must be declared before comparison");
  if (!input.scenarioIds.length || input.heldOutScenarioIds.some((id) => !input.scenarioIds.includes(id)) || input.scenarioIds.some((id) => input.heldOutScenarioIds.includes(id) && input.scenarioIds.indexOf(id) < 0) || !Number.isInteger(input.repeatedRuns) || input.repeatedRuns < 2 || input.repeatedRuns > 10 || input.providerRefs.some((ref) => ref.startsWith("live:"))) throw new ReplayBlockedError("Lab manifest is not bounded or fixture-safe");
  return { ...structuredClone(input), liveEffects: false, status: "prepared" };
}

export async function runLabComparison(experiment: LabExperiment, scenarios: string[], run: (scenarioId: string, representation: LabRepresentation, variant: LabScenarioResult["variant"], repeat: number) => Promise<Omit<LabScenarioResult, "scenarioId" | "representation" | "variant" | "run">>, options: { signal?: AbortSignal; phase?: "comparison"|"heldOut"; initialResults?: LabScenarioResult[]; onResult?: (result: LabScenarioResult) => void; maximumDurationMs?: number } = {}): Promise<LabComparison> {
  if (!["prepared","partial"].includes(experiment.status) || experiment.liveEffects || experiment.providerRefs.some(ref=>ref.startsWith("live:"))) throw new ReplayBlockedError("Lab is not prepared for isolated execution");
  const phase=options.phase??"comparison",allowed=[...new Set(scenarios)].filter(id=>experiment.scenarioIds.includes(id)&&(phase==="heldOut"?experiment.heldOutScenarioIds.includes(id):!experiment.heldOutScenarioIds.includes(id)));
  if(!allowed.length||allowed.length*experiment.representations.length*3*experiment.repeatedRuns>48)throw new ReplayBlockedError("Lab execution exceeds the declared 48-result bound");
  const results:LabScenarioResult[]=structuredClone(options.initialResults??[]),started=performance.now();let stopped=false;
  const identities=new Set<string>();for(const result of results){const key=`${result.scenarioId}:${result.representation}:${result.variant}:${result.run}`;if(!allowed.includes(result.scenarioId)||!experiment.representations.includes(result.representation)||!["unpersonalized","current","candidate"].includes(result.variant)||!Number.isInteger(result.run)||result.run<0||result.run>=experiment.repeatedRuns||identities.has(key))throw new ReplayBlockedError("Resume results do not match the pinned scenario boundary");identities.add(key);}
  outer:for(const scenarioId of allowed)for(const representation of experiment.representations)for(const variant of ["unpersonalized","current","candidate"] as const)for(let repeat=0;repeat<experiment.repeatedRuns;repeat++){
    if(results.some(r=>r.scenarioId===scenarioId&&r.representation===representation&&r.variant===variant&&r.run===repeat))continue;
    if(options.signal?.aborted||performance.now()-started>(options.maximumDurationMs??120000)){stopped=true;break outer;}
    const at=performance.now();let result:LabScenarioResult;
    try{result={scenarioId,representation,variant,run:repeat,status:"completed",...(await run(scenarioId,representation,variant,repeat))};}
    catch(error){if(options.signal?.aborted){stopped=true;break outer;}result={scenarioId,representation,variant,run:repeat,status:"failed",error:error instanceof Error?error.message:"Bounded provider execution failed",output:{},latencyMs:performance.now()-at,tokenCount:0};}
    if(options.signal?.aborted){stopped=true;break outer;}results.push(result);options.onResult?.(structuredClone(result));
  }
  const completed=results.filter(r=>r.status!=="failed"),variability:Record<string,number>={};
  // Compare repeated outputs within the same scenario, never scenario identity or timing.
  for(const scenarioId of allowed)for(const representation of experiment.representations)for(const variant of ["unpersonalized","current","candidate"] as const){const values=completed.filter(r=>r.scenarioId===scenarioId&&r.representation===representation&&r.variant===variant).map(r=>JSON.stringify(r.output.text??r.output));variability[`${scenarioId}:${representation}:${variant}`]=Math.max(0,new Set(values).size-1);}
  const status=options.signal?.aborted?"cancelled":stopped?"partial":results.some(r=>r.status==="failed")?(completed.length?"partial":"failed"):"completed";
  return {experimentId:experiment.experimentId,status,resultCount:completed.length,results,heldOutExcluded:phase==="comparison"?[...experiment.heldOutScenarioIds]:[],variability,limitations:["Isolated inference only; no tools, notifications, speech delivery, live memory writes or canonical reinforcement.","Variability is distinct repeated text outputs minus one within each scenario/representation/variant; deterministic observations have zero variation. Quality is separate from latency and token estimates.","Held-out scenarios use a separate frozen evaluation phase; Human review remains required for subjective fit."]};
}

export function createReplayManifest(input: Omit<ReplayManifest, "executionMode" | "liveRoute">): ReplayManifest {
  if (input.artifactRefs.length === 0) throw new ReplayBlockedError("replay requires pinned artifacts");
  if (input.providerRefs.some((ref) => ref.startsWith("live:"))) throw new ReplayBlockedError("replay cannot use a live provider route");
  return { ...structuredClone(input), executionMode: "replay", liveRoute: false };
}
export function assertCurrentReplayDependencies(manifest: ReplayManifest, snapshot: DependencySnapshot): void { const revoked = new Set(snapshot.revokedRefs); if ((manifest.revocationRefs ?? []).some((ref) => revoked.has(ref)) || (manifest.artifactRefs ?? []).some((ref) => revoked.has(ref))) throw new ReplayBlockedError("replay dependencies are revoked or stale"); if ((manifest.revocationRefs ?? []).some((ref) => !snapshot.currentRefs.includes(ref))) throw new ReplayBlockedError("replay dependencies are not current"); }

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
