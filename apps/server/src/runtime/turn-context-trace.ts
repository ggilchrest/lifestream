import {createHash,randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {isFinalizedTurnRequest,type FinalizedTurn} from '@lifestream/runtime/inference/prompt';
import type {InferenceRequest} from '@lifestream/runtime/inference';
import {isVisualMemoryCandidateTrace,isVisualMemoryLifecycleTrace,isVisualMemoryCorrectionTrace,visualMemoryTraceOwnersMatch,visualMemoryCorrectionOwnersMatch,type VisualMemoryCandidateTrace,type VisualMemoryLifecycleTrace,type VisualMemoryCorrectionTrace} from './visual-memory-candidate-evidence.ts';
import type {VisualTurnReceipt} from './visual-turn-evidence.ts';

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const diagnostic=(value:string,maximum:number)=>value.length<=maximum?value:`sha256:${sha(value)}`;
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
type Revision=Readonly<{providerRef:string;revision:string;highWaterMark:null}>;
type Artifact=Readonly<{reference:string;sha256:string;mediaType:'application/json';schemaRef:string;byteLength:number}>;
type Capture=Readonly<{scope:Readonly<{assistantId:string;conversationId:string;sessionId:string;endpointId:string;environmentId:string;interactionId:string}>;
  memorySelection:Readonly<{memoryIds:readonly string[];sourceRevision:Revision}>|null;
  freshUntilMs:number;
  view:Readonly<{viewId:string;revision:number;sourceRevisions:readonly Revision[];freshness:'fresh'}>;
  sections:readonly Readonly<{reference:string;sourceRevision:Revision}>[];
  artifact:Readonly<{reference:Artifact;bytes:string}>}>;
export type TurnContextTrace=Readonly<{events:readonly Readonly<Record<string,unknown>>[];manifest:Capture['artifact'];coverage:'bounded_best_effort';complete:false;durable:false;deliveryProved:false}>;
const captures=new WeakSet<object>();
const traces=new WeakSet<object>();
function receiptSnapshot(value:unknown):VisualTurnReceipt|null {
  let nodes=0;const seen=new Set<object>();
  const copy=(v:unknown,depth=0):unknown=>{
    if(++nodes>4096||depth>16)throw Error('bound');
    if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return v;
    if(typeof v==='string'&&Buffer.byteLength(v)<=8192)return v;
    if(!v||typeof v!=='object'||types.isProxy(v)||seen.has(v))throw Error('plain');
    const array=Array.isArray(v);if(Object.getPrototypeOf(v)!==(array?Array.prototype:Object.prototype))throw Error('prototype');seen.add(v);
    const out:Record<string,unknown>|unknown[]=array?[]:{};
    for(const key of Reflect.ownKeys(v)){if(array&&key==='length')continue;if(typeof key!=='string')throw Error('key');const descriptor=Object.getOwnPropertyDescriptor(v,key)!;if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))throw Error('accessor');Object.defineProperty(out,key,{value:copy(descriptor.value,depth+1),enumerable:true,writable:true,configurable:true});}
    seen.delete(v);return out;
  };
  try{const result=copy(value);if(Buffer.byteLength(JSON.stringify(result))>32768)return null;return result as VisualTurnReceipt;}catch{return null;}
}

/** The internal nine-section manifest is explicitly different from the published
 * provider InputManifest. Its bytes contain digests/metadata, never prompt text.
 * No canonical provider request/profile/snapshot IDs are invented for it. */
export function captureTurnContextTrace(turn:FinalizedTurn,request:InferenceRequest,environmentId:string|undefined):Capture|null {
  try{
    if(!isFinalizedTurnRequest(turn,request)||request.executionMode!=='live'||!uuid(environmentId)||!uuid(request.scope.interactionId)||!turn.preparedContext)return null;
    const view=turn.preparedContext;
    if(![view.assistantId,view.conversationId,view.sessionId,view.endpointId,view.viewId].every(uuid))return null;
    const bytes=JSON.stringify(request.manifest);
    if(Buffer.byteLength(bytes)>65536)return null;
    const digest=sha(bytes);
    const memorySection=request.manifest.sections[4]!;
    const capture:Capture=freeze({memorySelection:turn.selectedMemoryIds?{memoryIds:turn.selectedMemoryIds,sourceRevision:{providerRef:diagnostic(memorySection.sourceRef,500),revision:diagnostic(memorySection.sourceRevision,300),highWaterMark:null}}:null,freshUntilMs:Date.parse(view.freshUntil),scope:{assistantId:view.assistantId,conversationId:view.conversationId,sessionId:view.sessionId,endpointId:view.endpointId,environmentId,interactionId:request.scope.interactionId},
      view:{viewId:view.viewId,revision:view.revision,sourceRevisions:view.sourceRevisions.map(source=>({providerRef:diagnostic(source.source,500),revision:diagnostic(source.revision,300),highWaterMark:null})),freshness:'fresh'},
      sections:request.manifest.sections.map(section=>({reference:`urn:lifestream:prompt-section:sha256:${section.contentDigest}`,sourceRevision:{providerRef:diagnostic(section.sourceRef,500),revision:diagnostic(section.sourceRevision,300),highWaterMark:null}})),
      artifact:{reference:{reference:`urn:lifestream:runtime-turn-manifest:sha256:${digest}`,sha256:digest,mediaType:'application/json',schemaRef:'urn:lifestream:runtime-input-manifest:1.0.0',byteLength:Buffer.byteLength(bytes)},bytes}});
    captures.add(capture);return capture;
  }catch{return null;}
}

/** Called by the existing asynchronous journal drain, not a conversational
 * provider, action dispatcher, publication endpoint or durable memory owner. */
export function materializeTurnContextTrace(capture:Capture,clock:{occurredAtMs:number;processingAtMs:number;monotonicMs:number;clockId:string}):TurnContextTrace|null {
  try{
    if(!captures.has(capture)||!uuid(clock.clockId)||![clock.occurredAtMs,clock.processingAtMs,clock.monotonicMs].every(value=>Number.isFinite(value)&&value>=0)||clock.processingAtMs<clock.occurredAtMs)return null;
    const validator=createContractValidator(),{interactionId,...scope}=capture.scope;
    const payloads=[{eventType:'context.viewSelected',payload:{...capture.view,freshness:clock.occurredAtMs<capture.freshUntilMs?'fresh':'stale'}},...capture.sections.map(payload=>({eventType:'context.sourceUsed',payload})),...(capture.memorySelection?[{eventType:'memory.referencesSelected',payload:capture.memorySelection}]:[])];
    const events=payloads.map((item,sequence)=>({schemaVersion:'2.0.0',eventId:randomUUID(),traceScope:'interaction',interactionTraceId:interactionId,backgroundJobId:null,correlationId:interactionId,sequence,eventVersion:'1.0.0',eventTime:new Date(clock.occurredAtMs).toISOString(),processingTime:new Date(clock.processingAtMs).toISOString(),monotonic:{clockId:clock.clockId,milliseconds:clock.monotonicMs},...scope,executionMode:'normal',privacyClass:'restricted',causedByEventIds:[],sourceEventIds:[],...item,redactions:['prompt content omitted; section digests retained']}));
    if(events.some(event=>!validator.validate('https://lifestream.dev/contracts/interaction-trace-event/2.0.0',event).valid))return null;
    const trace:TurnContextTrace=freeze({events,manifest:capture.artifact,coverage:'bounded_best_effort',complete:false,durable:false,deliveryProved:false});
    traces.add(trace);return trace;
  }catch{return null;}
}

/** Correlate the original host trace with a retained diagnostic finalized
 * receipt. Equality explains metadata lineage, not source currency or delivery. */
export function correlateTurnContextTrace(trace:TurnContextTrace,receipt:VisualTurnReceipt){
  try{
    if(!traces.has(trace))return null;
    const snapshot=receiptSnapshot(receipt);if(!snapshot)return null;receipt=snapshot;
    const first=trace.events[0]!,view=first.payload as Capture['view'],f=receipt.finalized;
    if(receipt.stage!=='finalized'||receipt.interactionId!==first.interactionTraceId||receipt.occurredAtMs!==Date.parse(first.eventTime as string)||!f||f.viewId!==view.viewId||f.revision!==view.revision||f.manifestDigest!==trace.manifest.reference.sha256)return null;
    const manifest=JSON.parse(trace.manifest.bytes) as InferenceRequest['manifest'];
    if(f.sections.length!==9||f.sections.some((s,i)=>s.kind!==manifest.sections[i]!.kind||s.contentDigest!==manifest.sections[i]!.contentDigest||s.tokenCount!==manifest.sections[i]!.tokenCount)||f.conversationSectionDigest!==manifest.sections[7]!.contentDigest)return null;
    return freeze({state:'joined' as const,interactionDigest:sha(receipt.interactionId),viewDigest:sha(view.viewId),manifestDigest:trace.manifest.reference.sha256,conversationSectionDigest:f.conversationSectionDigest,sourceEventDigests:trace.events.map(e=>sha(e.eventId as string)),coverage:'bounded_best_effort' as const,sourceCurrencyProved:false as const,deliveryProved:false as const,learningAuthority:false as const,effectAuthority:false as const});
  }catch{return null;}
}

/** A pure semantic replay of the genuine retained context bundle. There is no
 * callback, provider route, storage handle, media or effect executor. Virtual
 * monotonic values preserve the original timeline with an explicit clock map. */
export function replayTurnContextTrace(trace:TurnContextTrace){
  try{
    if(!traces.has(trace))return null;
    const replayId=randomUUID(),environmentId=randomUUID(),clockId=randomUUID(),processingTime=new Date().toISOString();
    const first=trace.events[0]!,sourceClock=(first.monotonic as {clockId:string}).clockId;
    const events=trace.events.map(event=>({...event,eventId:randomUUID(),interactionTraceId:replayId,correlationId:replayId,environmentId,executionMode:'replay',processingTime,monotonic:{...(event.monotonic as {milliseconds:number}),clockId},causedByEventIds:[],sourceEventIds:[event.eventId as string]}));
    const validator=createContractValidator();if(events.some(event=>!validator.validate('https://lifestream.dev/contracts/interaction-trace-event/2.0.0',event).valid))return null;
    return freeze({replayId,environmentId,executionMode:'replay' as const,timeline:'source-relative-virtual' as const,sourceTraceId:first.interactionTraceId,sourceEnvironmentId:first.environmentId,clockMapping:{sourceClockId:sourceClock,replayClockId:clockId},manifest:trace.manifest,events,complete:false as const,rawMediaAvailable:false as const,perceptionReplayed:false as const,liveEffects:false as const,durableReinforcement:false as const,sourceCurrencyProved:false as const,deliveryProved:false as const});
  }catch{return null;}
}

/** Join genuine recorded candidate creation to exact finalized memory selection.
 * Cross-session use remains historical. This cannot prove current eligibility,
 * owner equivalence, provider admission, delivery or durable reinforcement. */
export function correlateVisualMemoryCandidate(candidate:VisualMemoryCandidateTrace,context:TurnContextTrace){
 try{
  if(!isVisualMemoryCandidateTrace(candidate)||!traces.has(context))return null;
  const source=candidate.event,selected=context.events.find(event=>event.eventType==='memory.referencesSelected');if(!selected)return null;
  const memoryId=(source.payload as {memoryId:string}).memoryId,selection=selected.payload as {memoryIds:readonly string[];sourceRevision:Revision};
  if(source.assistantId!==selected.assistantId||!selection.memoryIds.includes(memoryId)||Date.parse(source.eventTime as string)>Date.parse(selected.eventTime as string))return null;
  return freeze({state:'joined' as const,sourceCandidateEventId:source.eventId,selectedMemoryEventId:selected.eventId,memoryId,artifactDigest:candidate.artifact.reference.sha256,preparedMemorySourceRevision:selection.sourceRevision,sourceEnvironmentId:source.environmentId,selectedEnvironmentId:selected.environmentId,crossSession:source.sessionId!==selected.sessionId,coverage:'bounded_best_effort' as const,complete:false as const,sourceCurrencyProved:false as const,ownerEquivalenceProved:false as const,deliveryProved:false as const,learningAuthority:false as const,effectAuthority:false as const});
 }catch{return null;}
}

/** Pure replay of a genuine joined metadata path. Neither stored artifact is
 * executable or available to a provider. No storage/media/effect callbacks. */
export function replayVisualMemoryContextJoin(candidate:VisualMemoryCandidateTrace,context:TurnContextTrace){
 try{
  const joined=correlateVisualMemoryCandidate(candidate,context);if(!joined)return null;
  const replay=replayTurnContextTrace(context);if(!replay)return null;
  const source=candidate.event;
  const event={...source,eventId:randomUUID(),backgroundJobId:randomUUID(),correlationId:replay.replayId,environmentId:replay.environmentId,executionMode:'replay',processingTime:new Date().toISOString(),monotonic:null,sourceEventIds:[source.eventId],causedByEventIds:[]};
  if(!createContractValidator().validate('https://lifestream.dev/contracts/interaction-trace-event/2.0.0',event).valid)return null;
  return freeze({...replay,events:[event,...replay.events],candidateArtifact:candidate.artifact,sourceCandidateEventId:source.eventId,sourceCandidateMonotonicClockAvailable:false as const,join:joined,ownerEquivalenceProved:false as const,learningAuthority:false as const,effectAuthority:false as const});
 }catch{return null;}
}

/** Exact candidate -> original-owner activation -> final rendered selection.
 * Metadata lineage is historical; context owner/current-use/delivery remain
 * independently qualified. A missing lifecycle source is never filled in. */
export function correlateVisualMemoryLifecycle(candidate:VisualMemoryCandidateTrace,lifecycle:VisualMemoryLifecycleTrace,context:TurnContextTrace){
 try{
  const joined=correlateVisualMemoryCandidate(candidate,context);if(!joined||!isVisualMemoryLifecycleTrace(lifecycle)||!visualMemoryTraceOwnersMatch(candidate,lifecycle))return null;
  const payload=lifecycle.event.payload as {memoryId:string;lifecycleEventId:string;oldRevision:number;newRevision:number},source=lifecycle.sourceMutation;
  const metadata=JSON.parse(candidate.artifact.bytes),validation=JSON.parse(lifecycle.artifact.bytes),selected=context.events.find(event=>event.eventType==='memory.referencesSelected')!;
  if(payload.memoryId!==joined.memoryId||payload.lifecycleEventId!==source.eventId||payload.oldRevision!==source.oldRevision||payload.newRevision!==source.newRevision||payload.newRevision!==payload.oldRevision+1||metadata.recordDigest!==validation.candidateRecordDigest||metadata.sourceEpisodeId!==validation.episodeId||metadata.sourceEpisodeRevision!==validation.episodeRevision||metadata.sourceDigest!==validation.sourceDigest||Date.parse(candidate.event.eventTime as string)>Date.parse(lifecycle.event.eventTime as string)||Date.parse(lifecycle.event.eventTime as string)>Date.parse(selected.eventTime as string))return null;
  return freeze({...joined,sourceLifecycleEventId:source.eventId,traceLifecycleEventId:lifecycle.event.eventId,activationArtifactDigest:lifecycle.artifact.reference.sha256,memorySourcesOwnerMatched:true as const,oldRevision:payload.oldRevision,newRevision:payload.newRevision});
 }catch{return null;}
}

/** Isolated semantic replay of the three genuine retained metadata bundles.
 * Source canonical mutation is historical evidence, never an executable command. */
export function replayVisualMemoryLifecycleJoin(candidate:VisualMemoryCandidateTrace,lifecycle:VisualMemoryLifecycleTrace,context:TurnContextTrace){
 try{
  const join=correlateVisualMemoryLifecycle(candidate,lifecycle,context);if(!join)return null;
  const replay=replayVisualMemoryContextJoin(candidate,context);if(!replay)return null;
  const source=lifecycle.event,event={...source,eventId:randomUUID(),backgroundJobId:(replay.events[0]! as Readonly<Record<string,unknown>>).backgroundJobId,correlationId:replay.replayId,environmentId:replay.environmentId,executionMode:'replay',processingTime:new Date().toISOString(),monotonic:null,sourceEventIds:[source.eventId],causedByEventIds:[]};
  if(!createContractValidator().validate('https://lifestream.dev/contracts/interaction-trace-event/2.0.0',event).valid)return null;
  return freeze({...replay,events:[replay.events[0]!,event,...replay.events.slice(1)],activationArtifact:lifecycle.artifact,sourceMutation:lifecycle.sourceMutation,sourceLifecycleMonotonicClockAvailable:false as const,join});
 }catch{return null;}
}

/** Historical original-source linkage only. A correction retires the scene's
 * eligibility; it does not establish a new verified fact or complete history. */
export function correlateVisualMemoryCorrection(candidate:VisualMemoryCandidateTrace,correction:VisualMemoryCorrectionTrace){
 try{
  if(!visualMemoryCorrectionOwnersMatch(candidate,correction))return null;
  const source=correction.sourceReceipt,payload=correction.event.payload as {memoryId:string;lifecycleEventId:string;oldRevision:number;newRevision:number};
  const proposed=JSON.parse(candidate.artifact.bytes),changed=JSON.parse(correction.artifact.bytes);
  if(source.memoryId!==proposed.memoryId||payload.memoryId!==source.memoryId||payload.lifecycleEventId!==source.eventId||payload.oldRevision!==source.oldRevision||payload.newRevision!==source.newRevision||source.newRevision!==source.oldRevision+1||candidate.event.assistantId!==correction.event.assistantId||proposed.sourceEpisodeId!==changed.episodeId||proposed.sourceDigest!==changed.sourceDigest||changed.episodeRevision<=proposed.sourceEpisodeRevision||Date.parse(candidate.event.eventTime as string)>Date.parse(correction.event.eventTime as string))return null;
  return freeze({state:'joined' as const,memoryId:source.memoryId,sourceCandidateEventId:candidate.event.eventId,traceCorrectionEventId:correction.event.eventId,sourceMutationEventId:source.eventId,humanEntryId:source.humanEntryId,memorySourcesOwnerMatched:true as const,candidateArtifactDigest:candidate.artifact.reference.sha256,correctionArtifactDigest:correction.artifact.reference.sha256,oldRevision:source.oldRevision,newRevision:source.newRevision,intermediateHistoryComplete:false as const,currentEligibilityProved:false as const,correctedFactProved:false as const,replyFencingProved:false as const,learningAuthority:false as const,effectAuthority:false as const});
 }catch{return null;}
}

/** Pure isolated replay of genuine retained diagnostic bundles. Original entry
 * and mutation identity remain historical, without a canonical operation. */
export function replayVisualMemoryCorrection(candidate:VisualMemoryCandidateTrace,correction:VisualMemoryCorrectionTrace){
 try{
  const join=correlateVisualMemoryCorrection(candidate,correction);if(!join||!isVisualMemoryCorrectionTrace(correction))return null;
  const replayId=randomUUID(),environmentId=randomUUID(),producerId=randomUUID(),processingTime=new Date().toISOString();
  const events=[candidate.event,correction.event].map((source,sequence)=>({...source,eventId:randomUUID(),backgroundJobId:producerId,correlationId:replayId,sequence,environmentId,executionMode:'replay',processingTime,monotonic:null,sourceEventIds:[source.eventId],causedByEventIds:[]}));
  const validator=createContractValidator();if(events.some(event=>!validator.validate('https://lifestream.dev/contracts/interaction-trace-event/2.0.0',event).valid))return null;
  return freeze({replayId,environmentId,executionMode:'replay' as const,events,candidateArtifact:candidate.artifact,correctionArtifact:correction.artifact,sourceReceipt:correction.sourceReceipt,join,sourceMonotonicClockAvailable:false as const,complete:false as const,rawMediaAvailable:false as const,perceptionReplayed:false as const,liveEffects:false as const,durableReinforcement:false as const,learningAuthority:false as const,effectAuthority:false as const});
 }catch{return null;}
}
