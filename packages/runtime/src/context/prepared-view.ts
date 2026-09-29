import {createHash} from 'node:crypto';
import type {InferenceRequest} from '../inference/port.ts';
import type {PreparedTurnBinding} from '../inference/prompt.ts';

// Implements the already published PreparedContextView/1.0.0. No new wire
// fields or private perception contract are exported by this projection.
type ContextKind='session'|'conversation'|'relationalMemory'|'worldContext';
type ContextSection=Readonly<{kind:ContextKind;content:string;referenceIds:readonly string[];tokenEstimate:number;trust:'runtimeState'|'assistantMemory'|'externalEvidence'|'participantContent'}>;
export type PreparedContextView=Readonly<{
  schemaVersion:'1.0.0';viewId:string;revision:number;assistantId:string;conversationId:string;sessionId:string;endpointId:string;
  builtAt:string;freshUntil:string;staleUntil:string;invalidationKey:string;
  sourceRevisions:readonly Readonly<{source:string;revision:string;freshness:'fresh'|'unavailable'}>[];
  sections:readonly ContextSection[];omissions:readonly string[];
}>;
const mappings=[['interactionState','session','runtimeState'],['preparedMemory','relationalMemory','assistantMemory'],['worldContext','worldContext','externalEvidence'],['conversation','conversation','participantContent']] as const;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const bytes=(text:string)=>Buffer.byteLength(text);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
const minted=new WeakMap<PreparedContextView,InferenceRequest>();
const invalid=()=>new Error('Canonical prepared context is unavailable or incompatible');
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}

/** Legacy/fixture identifiers and absent logical endpoints are never fabricated. */
export function hasCanonicalContextScope(binding:PreparedTurnBinding):boolean {
  return [binding.viewId,binding.scope.assistantId,binding.scope.conversationId,binding.scope.sessionId,binding.scope.endpointId].every(uuid);
}

/**
 * The frozen schema permits ordered repeated section kinds. Store lossless
 * fragments of a logical section, each <=32,000 UTF-16 code units (therefore
 * also <=32,000 Unicode characters). Concatenation adds no separators and never
 * splits a surrogate pair. The existing full-section manifest digest is retained.
 */
function fragments(content:string):string[] {
  if(!content.length)return [''];
  const result:string[]=[];
  for(let start=0;start<content.length;){
    let end=Math.min(content.length,start+32_000);
    if(end<content.length&&content.charCodeAt(end-1)>=0xD800&&content.charCodeAt(end-1)<=0xDBFF&&content.charCodeAt(end)>=0xDC00&&content.charCodeAt(end)<=0xDFFF)end--;
    result.push(content.slice(start,end));start=end;
  }
  return result;
}

/** One immutable turn-local read model; freshness never outlives supplied sources. */
export function materializePreparedContext(request:InferenceRequest,binding:PreparedTurnBinding,options:{now:number;freshUntil:number;sourceRevisions:Readonly<Record<string,string>>;unavailableSources?:readonly string[];omissions?:readonly string[]}):PreparedContextView {
  if(!hasCanonicalContextScope(binding)||request.scope.assistantId!==binding.scope.assistantId||request.scope.sessionId!==binding.scope.sessionId||request.scope.endpointId!==binding.scope.endpointId||!Number.isFinite(options.now)||!Number.isFinite(options.freshUntil)||!Number.isFinite(Date.parse(request.deadlineAt))||options.freshUntil<=options.now||options.freshUntil>Date.parse(request.deadlineAt))throw invalid();
  const sections:ContextSection[]=[];
  let totalBytes=0;
  for(const [promptKind,kind,trust]of mappings){
    const matches=request.sections.filter(section=>section.kind===promptKind);if(matches.length!==1)throw invalid();
    const section=matches[0]!;totalBytes+=bytes(section.content);if(totalBytes>131_072||sha(section.content)!==section.contentDigest)throw invalid();
    const parts=fragments(section.content);
    for(const [index,content]of parts.entries())sections.push({kind,content,referenceIds:[`prompt-section:${promptKind}`,`part:${index+1}/${parts.length}`,`sha256:${section.contentDigest}`],tokenEstimate:bytes(content),trust});
  }
  if(sections.length>16)throw invalid();
  const sources=Object.entries(options.sourceRevisions);if(!sources.length||sources.length>64||sources.some(([source,revision])=>!source||!revision||bytes(source)>256||bytes(revision)>2048))throw invalid();
  const omissions=options.omissions??[];if(omissions.length>64||omissions.some(item=>typeof item!=='string'||!item||item.length>500))throw invalid();
  const view:PreparedContextView=freeze({schemaVersion:'1.0.0',viewId:binding.viewId,revision:binding.revision,assistantId:binding.scope.assistantId,conversationId:binding.scope.conversationId,sessionId:binding.scope.sessionId,endpointId:binding.scope.endpointId!,builtAt:new Date(options.now).toISOString(),freshUntil:new Date(options.freshUntil).toISOString(),staleUntil:new Date(options.freshUntil).toISOString(),invalidationKey:binding.invalidationKey,
    // Long composite revision strings use explicitly labeled integrity digests,
    // not invented upstream revisions. The turn retains the complete inventory.
    sourceRevisions:sources.map(([source,revision])=>({source:source.length<=100?source:`source-sha256:${sha(source)}`,revision:revision.length<=300?revision:`revision-sha256:${sha(revision)}`,freshness:options.unavailableSources?.includes(source)?'unavailable':'fresh'})),
    sections,omissions:[...omissions]});
  freeze(request);minted.set(view,request);return view;
}

/** The provider consumes these cached context contents through its existing nine sections. */
export function requestFromPreparedContext(view:PreparedContextView,original:InferenceRequest):InferenceRequest {
  if(minted.get(view)!==original)throw invalid();
  const sections=original.sections.map(section=>{
    const mapping=mappings.find(([kind])=>kind===section.kind);if(!mapping)return {...section};
    const content=view.sections.filter(part=>part.kind===mapping[1]).map(part=>part.content).join('');
    if(sha(content)!==section.contentDigest||bytes(content)!==section.tokenCount)throw invalid();
    return {...section,content};
  });
  return {...original,sections};
}
