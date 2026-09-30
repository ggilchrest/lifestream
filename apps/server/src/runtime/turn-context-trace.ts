import {createHash,randomUUID} from 'node:crypto';
import {createContractValidator} from '@lifestream/contracts';
import {isFinalizedTurnRequest,type FinalizedTurn} from '@lifestream/runtime/inference/prompt';
import type {InferenceRequest} from '@lifestream/runtime/inference';

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const diagnostic=(value:string,maximum:number)=>value.length<=maximum?value:`sha256:${sha(value)}`;
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
type Revision=Readonly<{providerRef:string;revision:string;highWaterMark:null}>;
type Artifact=Readonly<{reference:string;sha256:string;mediaType:'application/json';schemaRef:string;byteLength:number}>;
type Capture=Readonly<{scope:Readonly<{assistantId:string;conversationId:string;sessionId:string;endpointId:string;environmentId:string;interactionId:string}>;
  freshUntilMs:number;
  view:Readonly<{viewId:string;revision:number;sourceRevisions:readonly Revision[];freshness:'fresh'}>;
  sections:readonly Readonly<{reference:string;sourceRevision:Revision}>[];
  artifact:Readonly<{reference:Artifact;bytes:string}>}>;
export type TurnContextTrace=Readonly<{events:readonly Readonly<Record<string,unknown>>[];manifest:Capture['artifact'];coverage:'bounded_best_effort';complete:false;durable:false;deliveryProved:false}>;
const captures=new WeakSet<object>();

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
    const capture:Capture=freeze({freshUntilMs:Date.parse(view.freshUntil),scope:{assistantId:view.assistantId,conversationId:view.conversationId,sessionId:view.sessionId,endpointId:view.endpointId,environmentId,interactionId:request.scope.interactionId},
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
    const payloads=[{eventType:'context.viewSelected',payload:{...capture.view,freshness:clock.occurredAtMs<capture.freshUntilMs?'fresh':'stale'}},...capture.sections.map(payload=>({eventType:'context.sourceUsed',payload}))];
    const events=payloads.map((item,sequence)=>({schemaVersion:'2.0.0',eventId:randomUUID(),traceScope:'interaction',interactionTraceId:interactionId,backgroundJobId:null,correlationId:interactionId,sequence,eventVersion:'1.0.0',eventTime:new Date(clock.occurredAtMs).toISOString(),processingTime:new Date(clock.processingAtMs).toISOString(),monotonic:{clockId:clock.clockId,milliseconds:clock.monotonicMs},...scope,executionMode:'normal',privacyClass:'restricted',causedByEventIds:[],sourceEventIds:[],...item,redactions:['prompt content omitted; section digests retained']}));
    if(events.some(event=>!validator.validate('https://lifestream.dev/contracts/interaction-trace-event/2.0.0',event).valid))return null;
    return freeze({events,manifest:capture.artifact,coverage:'bounded_best_effort',complete:false,durable:false,deliveryProved:false});
  }catch{return null;}
}
