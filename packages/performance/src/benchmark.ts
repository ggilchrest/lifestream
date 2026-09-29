export type BenchmarkManifest = { hardware: string; os: string; powerMode: string; network: string; provider: string; warm: boolean; sampleCount: number; concurrency: number };
export type MilestoneSample = { acknowledged: number; firstAudio: number; result: number };
export type LatencyReport = { manifest: BenchmarkManifest; sampleCount: number; p50: MilestoneSample; p95: MilestoneSample };

export function percentile(values: number[], percentileValue: 50 | 95): number {
  if (values.length === 0) throw new Error("at least one sample is required");
  const ordered = [...values].sort((a, b) => a - b); const rank = Math.ceil((percentileValue / 100) * ordered.length) - 1; const value = ordered[rank];
  if (value === undefined) throw new Error("percentile sample is missing"); return value;
}

export function benchmark(manifest: BenchmarkManifest, samples: MilestoneSample[]): LatencyReport {
  if (!manifest.hardware || !manifest.os || !manifest.powerMode || !manifest.network || !manifest.provider) throw new Error("complete benchmark environment is required");
  if (samples.length < 20 || manifest.sampleCount !== samples.length) throw new Error("at least 20 declared samples are required for p95");
  for (const sample of samples) { if (sample.acknowledged < 0 || sample.firstAudio < sample.acknowledged || sample.result < sample.firstAudio) throw new Error("milestones must be monotonic"); }
  const project = (key: keyof MilestoneSample) => samples.map((sample) => sample[key]);
  return { manifest: structuredClone(manifest), sampleCount: samples.length, p50: { acknowledged: percentile(project("acknowledged"), 50), firstAudio: percentile(project("firstAudio"), 50), result: percentile(project("result"), 50) }, p95: { acknowledged: percentile(project("acknowledged"), 95), firstAudio: percentile(project("firstAudio"), 95), result: percentile(project("result"), 95) } };
}

export type DiscoveryCondition = "disabled" | "warm" | "background" | "cold";
export type DiscoveryEnvironment = {
  hardware: string; os: string; powerMode: string; network: string; provider: string;
  modelRevision: string; tokenizer: string; configurationDigest: string; seed: number;
  corpusRecords: 100 | 10000 | 100000;
  evidence: "fixture" | "developmentBrowser" | "physical";
};
export type DiscoverySample = {
  pairId: string;
  turnCommittedAt: number;
  preparedStartedAt: number; preparedCompletedAt: number;
  selectionStartedAt: number; selectionCompletedAt: number;
  inferenceRequestedAt: number; firstUsefulTokenAt: number;
  firstAudibleSampleAt: number | null;
  bargeInDetectedAt: number | null; audibleStoppedAt: number | null;
  enrichmentTokenUpperBound: number; selectedItems: number;
  cpuPercent: number; residentMemoryMiB: number; gpuMemoryMiB: number | null;
  providerQueueDepth: number; underruns: number; duplicateAudioOwners: number;
};
const discoveryMetrics = ["prepared", "selection", "firstUsefulToken", "firstAudibleSample", "audibleStop"] as const;
type DiscoveryMetric = typeof discoveryMetrics[number];
type Distribution = { count: number; p50: number; p95: number; minimum: number; maximum: number };
const distribution = (values: number[]): Distribution | null => values.length ? ({ count: values.length, p50: percentile(values, 50), p95: percentile(values, 95), minimum: Math.min(...values), maximum: Math.max(...values) }) : null;
const metricValue = (sample: DiscoverySample, metric: DiscoveryMetric): number | null => {
  switch (metric) {
    case "prepared": return sample.preparedCompletedAt - sample.preparedStartedAt;
    case "selection": return sample.selectionCompletedAt - sample.selectionStartedAt;
    case "firstUsefulToken": return sample.firstUsefulTokenAt - sample.turnCommittedAt;
    case "firstAudibleSample": return sample.firstAudibleSampleAt === null ? null : sample.firstAudibleSampleAt - sample.turnCommittedAt;
    case "audibleStop": return sample.bargeInDetectedAt === null || sample.audibleStoppedAt === null ? null : sample.audibleStoppedAt - sample.bargeInDetectedAt;
  }
};

/** Seeded paired bootstrap of the difference in p95s, for offline uncertainty reporting. */
export function pairedP95Interval(pairs: readonly (readonly [number, number])[], seed: number): { lower: number; upper: number; resamples: 500; method: string } {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const differences: number[] = [];
  for (let run = 0; run < 500; run++) {
    const baseline: number[] = [], enabled: number[] = [];
    for (let index = 0; index < pairs.length; index++) { const pair = pairs[Math.floor(random() * pairs.length)]!; baseline.push(pair[0]); enabled.push(pair[1]); }
    differences.push(percentile(enabled, 95) - percentile(baseline, 95));
  }
  differences.sort((a, b) => a - b);
  return { lower: differences[12]!, upper: differences[487]!, resamples: 500, method: "paired-percentile-bootstrap-95pct-v1" };
}

/** This evaluates supplied measurements; it does not turn fixture clocks into physical evidence. */
export function benchmarkDiscovery(environment: DiscoveryEnvironment, runs: Record<DiscoveryCondition, readonly DiscoverySample[]>) {
  for (const field of ["hardware", "os", "powerMode", "network", "provider", "modelRevision", "tokenizer", "configurationDigest"] as const) if (!environment[field]?.trim()) throw new Error("complete pinned discovery environment required");
  if (!Number.isSafeInteger(environment.seed) || ![100, 10000, 100000].includes(environment.corpusRecords)) throw new Error("invalid discovery experiment boundary");
  const conditions = ["disabled", "warm", "background", "cold"] as const;
  const expectedIds = runs.disabled.map(sample => sample.pairId);
  if (expectedIds.length < 200 || new Set(expectedIds).size !== expectedIds.length || expectedIds.some(id => !id)) throw new Error("at least 200 unique paired turns required");
  const gates: { condition: DiscoveryCondition; metric: string; status: "pass" | "fail" | "unverified"; detail: string }[] = [];
  const reports: Partial<Record<DiscoveryCondition, Record<DiscoveryMetric, Distribution | null>>> = {};
  const limits: Record<DiscoveryMetric, readonly [number, number]> = { prepared: [15, 40], selection: [5, 10], firstUsefulToken: [450, 800], firstAudibleSample: [900, 1500], audibleStop: [150, 250] };
  for (const condition of conditions) {
    const samples = runs[condition];
    if (samples.length !== expectedIds.length || samples.some((sample, index) => sample.pairId !== expectedIds[index])) throw new Error("conditions must use the same ordered paired turns");
    for (const sample of samples) {
      const ordered = [sample.turnCommittedAt, sample.preparedStartedAt, sample.selectionStartedAt, sample.selectionCompletedAt, sample.preparedCompletedAt, sample.inferenceRequestedAt, sample.firstUsefulTokenAt];
      if (ordered.some((value, index) => !Number.isFinite(value) || value < 0 || index > 0 && value < ordered[index - 1]!)) throw new Error("discovery milestones must be finite and monotonic");
      if (sample.firstAudibleSampleAt !== null && (!Number.isFinite(sample.firstAudibleSampleAt) || sample.firstAudibleSampleAt < sample.firstUsefulTokenAt)) throw new Error("invalid audible milestone");
      if ((sample.bargeInDetectedAt === null) !== (sample.audibleStoppedAt === null)
          || sample.bargeInDetectedAt !== null && (!Number.isFinite(sample.bargeInDetectedAt) || sample.firstAudibleSampleAt === null || sample.bargeInDetectedAt < sample.firstAudibleSampleAt || !Number.isFinite(sample.audibleStoppedAt) || sample.audibleStoppedAt! < sample.bargeInDetectedAt)) throw new Error("invalid barge-in milestones");
      for (const field of ["enrichmentTokenUpperBound", "selectedItems", "residentMemoryMiB", "providerQueueDepth", "underruns", "duplicateAudioOwners", "cpuPercent"] as const) if (!Number.isFinite(sample[field]) || sample[field] < 0) throw new Error("invalid resource measurement");
      if (sample.gpuMemoryMiB !== null && (!Number.isFinite(sample.gpuMemoryMiB) || sample.gpuMemoryMiB < 0)) throw new Error("invalid GPU measurement");
      if (![sample.enrichmentTokenUpperBound,sample.selectedItems,sample.providerQueueDepth,sample.underruns,sample.duplicateAudioOwners].every(Number.isInteger)) throw new Error("resource counts must be integers");
    }
    const report = {} as Record<DiscoveryMetric, Distribution | null>;
    for (const metric of discoveryMetrics) {
      const values = samples.map(sample => metricValue(sample, metric)).filter((value): value is number => value !== null);
      const summary = distribution(values); report[metric] = summary;
      const complete = values.length === samples.length;
      gates.push({ condition, metric, status: !complete || !summary ? "unverified" : summary.p50 <= limits[metric][0] && summary.p95 <= limits[metric][1] ? "pass" : "fail", detail: `${values.length}/${samples.length} observed; absolute p50/p95 limits ${limits[metric].join("/")} ms` });
    }
    reports[condition] = report;
    const bounds = samples.every(sample => sample.enrichmentTokenUpperBound <= 1024 && sample.selectedItems <= 8 && (condition !== "disabled" || sample.enrichmentTokenUpperBound === 0 && sample.selectedItems === 0));
    gates.push({ condition, metric: "enrichmentBounds", status: bounds ? "pass" : "fail", detail: "Hard maxima 1024 token upper bound / 8 items; disabled contributes zero" });
    gates.push({ condition, metric: "audioContinuity", status: samples.some(sample => sample.firstAudibleSampleAt === null) ? "unverified" : samples.some(sample => sample.underruns > 0 || sample.duplicateAudioOwners > 0) ? "fail" : "pass", detail: "No underruns or duplicate audio owners; missing audible milestones remain unverified" });
  }
  const comparisons: { condition: DiscoveryCondition; metric: DiscoveryMetric; p95Delta: number; pairedDelta: Distribution; uncertainty: ReturnType<typeof pairedP95Interval> }[] = [];
  const addedLimits: Partial<Record<DiscoveryMetric, number>> = { firstUsefulToken: 50, firstAudibleSample: 75, audibleStop: 10 };
  for (const condition of ["warm", "background", "cold"] as const) {
    for (const metric of discoveryMetrics) {
      const pairs = runs.disabled.map((sample, index) => [metricValue(sample, metric), metricValue(runs[condition][index]!, metric)] as const);
      if (pairs.some(pair => pair[0] === null || pair[1] === null)) { if (metric in addedLimits) gates.push({ condition, metric: `added:${metric}`, status: "unverified", detail: "missing paired milestones" }); continue; }
      const completePairs = pairs as (readonly [number,number])[];
      const p95Delta = reports[condition]![metric]!.p95 - reports.disabled![metric]!.p95;
      const uncertainty = pairedP95Interval(completePairs, environment.seed);
      comparisons.push({ condition, metric, p95Delta, pairedDelta: distribution(completePairs.map(pair => pair[1] - pair[0]))!, uncertainty });
      const limit = addedLimits[metric];
      if (limit !== undefined) gates.push({ condition, metric: `added:${metric}`, status: p95Delta > limit ? "fail" : uncertainty.upper > limit ? "unverified" : "pass", detail: `added p95 <=${limit} ms; upper bootstrap bound ${uncertainty.upper} ms` });
    }
  }
  return { environment: structuredClone(environment), sampleCountPerCondition: expectedIds.length, percentileMethod: "nearest-rank", gates, distributions: reports, comparisons, raw: structuredClone(runs), status: gates.some(gate => gate.status === "fail") ? "failedObjectives" : gates.some(gate => gate.status === "unverified") ? "incompleteEvidence" : "passedMeasuredObjectives", claimBoundary: environment.evidence === "fixture" ? "Fixture measurements only; no real provider, physical or Human acceptance" : "Named environment measurements only; Human acceptance remains separate" };
}

export type DiscoveryLookupSample = {
  pairId: string; preparedStartedAt: number; selectionStartedAt: number;
  selectionCompletedAt: number; preparedCompletedAt: number;
  lookupMs: number; innerSelectionMs: number; threadCpuMicroseconds: number | null;
  residentMemoryMiB: number; selectedItems: number; enrichmentTokenUpperBound: number;
  disposition: string; expectedDetailPresent: boolean;
};
export type DiscoveryLookupEnvironment = {
  hardware: string; os: string; powerMode: string; sourceRevision: string;
  configurationDigest: string; cachePolicy: string; backgroundWork: string;
  seed: number; corpusRecords: 100 | 10000 | 100000;
};
/** Actual local measurements can be useful before inference/audio measurements exist.
 * Missing stages are explicit; this report never supplies fabricated provider milestones. */
export function benchmarkDiscoveryLookup(environment: DiscoveryLookupEnvironment, runs: Record<DiscoveryCondition, readonly DiscoveryLookupSample[]>) {
  for (const field of ['hardware','os','powerMode','sourceRevision','configurationDigest','cachePolicy','backgroundWork'] as const)
    if (!environment[field]?.trim()) throw new Error('complete local lookup environment required');
  if (!Number.isSafeInteger(environment.seed) || ![100,10000,100000].includes(environment.corpusRecords)) throw new Error('invalid local corpus experiment');
  const ids=runs.disabled.map(sample=>sample.pairId);
  if(ids.length<200||new Set(ids).size!==ids.length||ids.some(id=>!id))throw new Error('at least 200 unique paired lookups required');
  const conditions=['disabled','warm','background','cold'] as const;
  const distributions={} as Record<DiscoveryCondition,{prepared:Distribution;selection:Distribution;lookup:Distribution;innerSelection:Distribution}>;
  const gates:{condition:DiscoveryCondition;metric:string;status:'pass'|'fail';count?:number}[]=[];
  for(const condition of conditions){
    const samples=runs[condition];
    if(samples.length!==ids.length||samples.some((sample,i)=>sample.pairId!==ids[i]))throw new Error('same ordered paired lookups required');
    for(const sample of samples){
      const times=[sample.preparedStartedAt,sample.selectionStartedAt,sample.selectionCompletedAt,sample.preparedCompletedAt];
      if(times.some((time,i)=>!Number.isFinite(time)||time<0||i>0&&time<times[i-1]!))throw new Error('finite monotonic local milestones required');
      if([sample.lookupMs,sample.innerSelectionMs,sample.residentMemoryMiB].some(value=>!Number.isFinite(value)||value<0)
        ||sample.threadCpuMicroseconds!==null&&(!Number.isFinite(sample.threadCpuMicroseconds)||sample.threadCpuMicroseconds<0))throw new Error('invalid local resource measurement');
      if(![sample.selectedItems,sample.enrichmentTokenUpperBound].every(value=>Number.isSafeInteger(value)&&value>=0)
        ||typeof sample.expectedDetailPresent!=='boolean'||!['included','disabled','deadline','boundaryChanged','empty'].includes(sample.disposition))throw new Error('invalid local selection observation');
    }
    const prepared=distribution(samples.map(s=>s.preparedCompletedAt-s.preparedStartedAt))!,selection=distribution(samples.map(s=>s.selectionCompletedAt-s.selectionStartedAt))!;
    distributions[condition]={prepared,selection,lookup:distribution(samples.map(s=>s.lookupMs))!,innerSelection:distribution(samples.map(s=>s.innerSelectionMs))!};
    gates.push({condition,metric:'preparedLatency',status:prepared.p50<=15&&prepared.p95<=40?'pass':'fail'},
      {condition,metric:'selectionLatency',status:selection.p50<=5&&selection.p95<=10?'pass':'fail'});
    const missing=samples.filter(s=>condition==='disabled'?s.expectedDetailPresent:!s.expectedDetailPresent).length;
    gates.push({condition,metric:'expectedDetail',status:missing?'fail':'pass',count:missing});
    const bad=samples.filter(s=>s.selectedItems>8||s.enrichmentTokenUpperBound>1024||
      (condition==='disabled'||s.disposition!=='included')&&(s.selectedItems!==0||s.enrichmentTokenUpperBound!==0||s.expectedDetailPresent)).length;
    gates.push({condition,metric:'boundedFailClosedSelection',status:bad?'fail':'pass',count:bad});
  }
  const comparisons=(['warm','background','cold'] as const).map(condition=>{
    const pairs=runs.disabled.map((s,i)=>[s.selectionCompletedAt-s.selectionStartedAt,runs[condition][i]!.selectionCompletedAt-runs[condition][i]!.selectionStartedAt] as const);
    return {condition,p95Delta:distributions[condition].selection.p95-distributions.disabled.selection.p95,uncertainty:pairedP95Interval(pairs,environment.seed)};
  });
  return {environment:structuredClone(environment),sampleCountPerCondition:ids.length,distributions,comparisons,gates,
    deadlineMisses:Object.fromEntries(conditions.map(condition=>[condition,runs[condition].filter(s=>s.disposition==='deadline').length])),
    status:gates.some(g=>g.status==='fail')?'failedLocalObjectives':'passedLocalObjectives',qualification:'incompleteEvidence',
    unmeasured:['model output','first useful token','first audible sample','barge-in stop','audio continuity','GPU/provider pressure','Human quality'],
    claimBoundary:'Synthetic local SQLite and prepared-input measurements only. Connection-cold is not OS-cache-cold or model-cold. No provider, physical or Human qualification.',raw:structuredClone(runs)};
}

export const visualPerformanceConditions = ['disabled','warm','sceneChanging','saturated','hung','optionalMemory'] as const;
export type VisualPerformanceCondition = typeof visualPerformanceConditions[number];
export type VisualPerformanceEnvironment = {
  hardware:string;os:string;powerMode:string;network:string;sourceRevision:string;
  speechProviderRevision:string;perceptionProviderRevision:string;configurationDigest:string;clockMappingRevision:string;
  evidence:'fixture'|'developmentEndpoint'|'physical';seed:number;
};
export type VisualPerformanceTrial = {
  pairId:string;temperature:'warm'|'cold';status:'completed'|'failed'|'timedOut'|'cancelled';
  turnCommittedAt:number;preparedStartedAt:number|null;preparedCompletedAt:number|null;
  firstAudioAt:number|null;firstAudioKind:'requestedSpeech'|'acknowledgment'|'none';
  bargeInDetectedAt:number|null;audibleStoppedAt:number|null;
  underruns:number;duplicateAudioOwners:number;
  visualBatches:readonly {batchId:string;admitted:boolean;capturedAt:number;usableAt:number|null;
    outcome:'usable'|'deferred'|'dropped'|'failed'|'timedOut'|'expired'}[];
};
type VisualMetric='preparedRead'|'firstSpokenWord'|'audibleStop';
type VisualBatchSummary={attempts:number;admitted:number;outcomes:Record<VisualPerformanceTrial['visualBatches'][number]['outcome'],number>;captureToUsable:Distribution|null;lateUsable:number};
const visualTime=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const visualId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value;
const visualKeys=(value:unknown,keys:readonly string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===[...keys].sort().join('|');
const visualMetric=(trial:VisualPerformanceTrial,metric:VisualMetric):number|null=>{
  if(trial.status!=='completed')return null;
  if(metric==='preparedRead')return trial.preparedStartedAt===null||trial.preparedCompletedAt===null?null:trial.preparedCompletedAt-trial.preparedStartedAt;
  if(metric==='firstSpokenWord')return trial.firstAudioKind!=='requestedSpeech'||trial.firstAudioAt===null?null:trial.firstAudioAt-trial.turnCommittedAt;
  return trial.bargeInDetectedAt===null||trial.audibleStoppedAt===null?null:trial.audibleStoppedAt-trial.bargeInDetectedAt;
};

/** Offline evaluator of supplied observations, not a measurement collector.
 * All attempted turns remain in denominators; cold trials never fill warm pairs.
 * Caller evidence labels do not authenticate hardware, playback or providers. */
export function benchmarkVisualConversation(environment:VisualPerformanceEnvironment,runs:Record<VisualPerformanceCondition,readonly VisualPerformanceTrial[]>) {
  if(!visualKeys(environment,['hardware','os','powerMode','network','sourceRevision','speechProviderRevision','perceptionProviderRevision','configurationDigest','clockMappingRevision','evidence','seed'])||!visualKeys(runs,visualPerformanceConditions))throw new Error('closed visual measurement envelope required');
  for(const key of ['hardware','os','powerMode','network','sourceRevision','speechProviderRevision','perceptionProviderRevision','configurationDigest','clockMappingRevision'] as const)
    if(!visualId(environment[key]))throw new Error('complete pinned visual experiment required');
  if(!/^[a-f0-9]{64}$/u.test(environment.configurationDigest)||!Number.isSafeInteger(environment.seed)||environment.seed<0||environment.seed>0xffffffff||!['fixture','developmentEndpoint','physical'].includes(environment.evidence))throw new Error('invalid visual experiment identity');
  const gates:{condition:VisualPerformanceCondition;metric:string;status:'pass'|'fail'|'unverified';detail:string}[]=[];
  const warm={} as Record<VisualPerformanceCondition,VisualPerformanceTrial[]>;
  const reports={} as Record<VisualPerformanceCondition,{
    attempts:number;completed:number;failed:number;timedOut:number;cancelled:number;
    cold:{attempts:number;completed:number;failed:number;timedOut:number;cancelled:number;underruns:number;duplicateAudioOwners:number;metrics:Record<VisualMetric,Distribution|null>;visual:VisualBatchSummary};
    underruns:number;duplicateAudioOwners:number;
    metrics:Record<VisualMetric,Distribution|null>;
    visual:VisualBatchSummary;
  }>;
  const metrics=['preparedRead','firstSpokenWord','audibleStop'] as const;
  const limits:Record<VisualMetric,readonly [number,number]>={preparedRead:[15,40],firstSpokenWord:[900,1500],audibleStop:[150,250]};
  const counts=(trials:readonly VisualPerformanceTrial[])=>({attempts:trials.length,completed:trials.filter(t=>t.status==='completed').length,failed:trials.filter(t=>t.status==='failed').length,timedOut:trials.filter(t=>t.status==='timedOut').length,cancelled:trials.filter(t=>t.status==='cancelled').length});
  const resources=(trials:readonly VisualPerformanceTrial[])=>({underruns:trials.reduce((sum,t)=>sum+t.underruns,0),duplicateAudioOwners:trials.reduce((sum,t)=>sum+t.duplicateAudioOwners,0)});
  const summarize=(trials:readonly VisualPerformanceTrial[])=>Object.fromEntries(metrics.map(metric=>[metric,distribution(trials.map(t=>visualMetric(t,metric)).filter((v):v is number=>v!==null))])) as Record<VisualMetric,Distribution|null>;
  const visualSummary=(trials:readonly VisualPerformanceTrial[]):VisualBatchSummary=>{
    const batches=trials.flatMap(t=>t.visualBatches),usable=batches.filter(b=>b.outcome==='usable');
    const outcomes={usable:0,deferred:0,dropped:0,failed:0,timedOut:0,expired:0};for(const b of batches)outcomes[b.outcome]++;
    return {attempts:batches.length,admitted:batches.filter(b=>b.admitted).length,outcomes,captureToUsable:distribution(usable.map(b=>b.usableAt!-b.capturedAt)),lateUsable:usable.filter(b=>b.usableAt!-b.capturedAt>=6000).length};
  };
  for(const condition of visualPerformanceConditions){
    const trials=runs[condition];if(!Array.isArray(trials)||trials.length>5000)throw new Error('bounded trials required for every visual condition');
    const ids=new Set<string>(),batchIds=new Set<string>();
    for(const trial of trials){
      if(!visualKeys(trial,['pairId','temperature','status','turnCommittedAt','preparedStartedAt','preparedCompletedAt','firstAudioAt','firstAudioKind','bargeInDetectedAt','audibleStoppedAt','underruns','duplicateAudioOwners','visualBatches']))throw new Error('closed visual trial required');
      if(!trial||!visualId(trial.pairId)||!['warm','cold'].includes(trial.temperature)||!['completed','failed','timedOut','cancelled'].includes(trial.status)||ids.has(trial.temperature+':'+trial.pairId))throw new Error('unique explicit visual trial identities required');
      ids.add(trial.temperature+':'+trial.pairId);
      if(!visualTime(trial.turnCommittedAt)||![trial.preparedStartedAt,trial.preparedCompletedAt,trial.firstAudioAt,trial.bargeInDetectedAt,trial.audibleStoppedAt].every(v=>v===null||visualTime(v)))throw new Error('finite visual performance times required');
      if([trial.preparedStartedAt,trial.preparedCompletedAt,trial.bargeInDetectedAt,trial.audibleStoppedAt].some(v=>v!==null&&v<trial.turnCommittedAt)||trial.preparedStartedAt!==null&&trial.preparedCompletedAt!==null&&trial.preparedCompletedAt<trial.preparedStartedAt)throw new Error('invalid prepared-read milestones');
      if(!['requestedSpeech','acknowledgment','none'].includes(trial.firstAudioKind)||(trial.firstAudioAt===null)!==(trial.firstAudioKind==='none')||trial.firstAudioAt!==null&&trial.firstAudioAt<trial.turnCommittedAt)throw new Error('invalid audio evidence');
      if(trial.firstAudioKind==='requestedSpeech'&&trial.firstAudioAt!==null&&trial.preparedCompletedAt!==null&&trial.firstAudioAt<trial.preparedCompletedAt)throw new Error('speech precedes prepared context');
      if(trial.bargeInDetectedAt!==null&&trial.audibleStoppedAt!==null&&(trial.firstAudioKind!=='requestedSpeech'||trial.firstAudioAt===null||trial.bargeInDetectedAt<trial.firstAudioAt||trial.audibleStoppedAt<trial.bargeInDetectedAt))throw new Error('invalid audible-stop milestones');
      if(![trial.underruns,trial.duplicateAudioOwners].every(v=>Number.isSafeInteger(v)&&v>=0)||!Array.isArray(trial.visualBatches)||trial.visualBatches.length>16)throw new Error('invalid visual resource observations');
      for(const batch of trial.visualBatches){
        if(!visualKeys(batch,['batchId','admitted','capturedAt','usableAt','outcome']))throw new Error('closed visual batch required');
        if(!batch||!visualId(batch.batchId)||batchIds.has(batch.batchId)||typeof batch.admitted!=='boolean'||!visualTime(batch.capturedAt)||!(batch.usableAt===null||visualTime(batch.usableAt))||!['usable','deferred','dropped','failed','timedOut','expired'].includes(batch.outcome))throw new Error('invalid or duplicate visual batch');
        batchIds.add(batch.batchId);
        if((batch.outcome==='usable')!==(batch.usableAt!==null)||batch.usableAt!==null&&(!batch.admitted||batch.usableAt<batch.capturedAt))throw new Error('invalid usable-context milestone');
      }
      if(condition==='disabled'&&trial.visualBatches.length)throw new Error('disabled baseline cannot perform visual work');
    }
    warm[condition]=trials.filter(t=>t.temperature==='warm');const cold=trials.filter(t=>t.temperature==='cold'),sample=warm[condition],summary=summarize(sample);
    const visual=visualSummary(sample),coldVisual=visualSummary(cold),capture=visual.captureToUsable;
    reports[condition]={...counts(sample),...resources(sample),cold:{...counts(cold),...resources(cold),metrics:summarize(cold),visual:coldVisual},metrics:summary,visual};
    for(const metric of metrics){const report=summary[metric],complete=report!==null&&report.count===sample.length&&report.count>=200;
      gates.push({condition,metric,status:report&&(report.p50>limits[metric][0]||report.p95>limits[metric][1])?'fail':complete?'pass':'unverified',detail:`${report?.count??0}/${sample.length} warm attempts measured; require 200 completed observations and p50/p95 <= ${limits[metric].join('/')} ms`});}
    gates.push({condition,metric:'foregroundCompletion',status:trials.some(t=>t.status==='failed'||t.status==='timedOut')?'fail':sample.length<200||trials.some(t=>t.status!=='completed')?'unverified':'pass',detail:'All warm and cold foreground failures retained; cold trials never fill warm sample counts and cancellation does not become success.'});
    gates.push({condition,metric:'audioContinuity',status:trials.some(t=>t.underruns>0||t.duplicateAudioOwners>0)?'fail':summary.firstSpokenWord?.count===sample.length&&sample.length>=200?'pass':'unverified',detail:'Requested warm speech required; no observed warm or cold underruns or duplicate audio owners. Cold resource totals remain separate.'});
    if(condition!=='disabled'){
      gates.push({condition,metric:'captureToUsable',status:capture&&capture.p95>3000?'fail':capture&&visual.outcomes.usable===visual.admitted?'pass':'unverified',detail:`${visual.outcomes.usable}/${visual.attempts} warm batches usable; admitted ${visual.admitted}. Admitted batches without usable milestones cannot be removed to qualify p95 <= 3000 ms; pre-admission deferrals and other outcomes remain separate.`});
      gates.push({condition,metric:'captureFreshness',status:visual.lateUsable+coldVisual.lateUsable?'fail':visual.attempts+coldVisual.attempts?'pass':'unverified',detail:'No warm or cold context declared usable at or beyond its 6000 ms expiry, regardless of percentile.'});
    }
  }
  const baseline=new Map(warm.disabled.map(t=>[t.pairId,t]));
  const comparisons=[] as {condition:VisualPerformanceCondition;matchedAttempts:number;completedSpeechPairs:number;p95Delta:number|null;pairedDelta:Distribution|null;uncertainty:ReturnType<typeof pairedP95Interval>|null}[];
  for(const condition of visualPerformanceConditions.filter(c=>c!=='disabled')){
    const trials=warm[condition],ids=new Set(trials.map(t=>t.pairId));
    const completeIds=baseline.size===ids.size&&[...baseline.keys()].every(id=>ids.has(id));
    const pairs:([number,number])[]=[];let matchedAttempts=0;
    for(const trial of trials){const base=baseline.get(trial.pairId);if(!base)continue;matchedAttempts++;const a=visualMetric(base,'firstSpokenWord'),b=visualMetric(trial,'firstSpokenWord');if(a!==null&&b!==null)pairs.push([a,b]);}
    const p95Delta=pairs.length?percentile(pairs.map(p=>p[1]),95)-percentile(pairs.map(p=>p[0]),95):null;
    const complete=completeIds&&pairs.length>=200&&pairs.length===baseline.size;
    const uncertainty=complete?pairedP95Interval(pairs,environment.seed):null;
    comparisons.push({condition,matchedAttempts,completedSpeechPairs:pairs.length,p95Delta,pairedDelta:distribution(pairs.map(p=>p[1]-p[0])),uncertainty});
    gates.push({condition,metric:'pairedSpeechOverhead',status:p95Delta!==null&&p95Delta>50?'fail':!complete||!uncertainty||uncertainty.upper>50?'unverified':'pass',detail:`${pairs.length}/${baseline.size} complete paired warm speech turns; same pair set required, added p95 <= 50 ms. Missing and failed attempts cannot be pooled out.`});
  }
  return {environment:structuredClone(environment),percentileMethod:'nearest-rank',reports,comparisons,gates,status:gates.some(g=>g.status==='fail')?'failedObjectives':gates.some(g=>g.status==='unverified')?'incompleteEvidence':'passedMeasuredObjectives',qualification:environment.evidence==='fixture'?'fixtureOnly':'suppliedMeasurementsOnly',claimBoundary:'Offline scoring only. No provider, endpoint, physical or Human acceptance is established by a supplied evidence label. Cold starts and all failed/timeout/cancelled attempts remain separate and retained.',raw:structuredClone(runs)};
}
