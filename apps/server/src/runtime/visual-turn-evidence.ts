import {createHash,randomUUID} from 'node:crypto';
import {captureTurnContextTrace,materializeTurnContextTrace,type TurnContextTrace} from './turn-context-trace.ts';
import {isFinalizedTurnRequest} from '@lifestream/runtime/inference/prompt';
import {types} from 'node:util';
import type {InferenceRequest} from '@lifestream/runtime/inference';
import type {FinalizedTurn,PreparedTurnBinding} from '@lifestream/runtime/inference/prompt';
import type {VisualContextSelection,VisualSelectionReason} from '@lifestream/runtime/perception/observation';

type Actor=Readonly<{principalId:string;sessionId:string;assistantId:string}>;
export type VisualTurnOutcome='completed'|'exhausted'|'failed'|'cancelled'|'invalidated'|'deadline'|'disconnected';
type EndpointOutcome='completed'|'stopped'|'timeout'|'disconnected'|'invalidated';
export type VisualPublicationLink=Readonly<{requestId:string;hostSequence:number;audienceRevision:number;leaseRevision:number;clockMappingId:string}>;
export type VisualTurnLineage=Readonly<{
  selectionReason:VisualSelectionReason;
  selected:Readonly<{requestId:string;sourceRevision:number;leaseId:string;audienceRevision:number;captureConfigurationRevision:number;
    capturedAtEarliestMs:number;capturedAtLatestMs:number;expiresAtMs:number;observationIds:readonly string[];frameIds:readonly string[]}>|null;
  publication:VisualPublicationLink|null;
}>;
type FinalizedMetadata=Readonly<{viewId:string|null;revision:number|null;invalidationKey:string|null;
  manifestDigest:string;conversationSectionDigest:string;visualIncluded:boolean;
  sections:readonly Readonly<{kind:string;contentDigest:string;tokenCount:number}>[]}>;
export type VisualTurnReceipt=Readonly<{
  interactionId:string;modality:'text'|'audio';sequence:number;occurredAtMs:number;
  stage:'finalized'|'admissionRejected'|'providerInvoked'|'generationEnded'|'outputEmitted'|'synthesisCompleted'|'playbackFenced'|'endpointSettled'|'turnEnded';
  outcome:VisualTurnOutcome|EndpointOutcome|'context_unavailable'|'provider_unavailable'|null;
  channel:'text'|'audio'|null;receivedSamples:number|null;
  lineage:VisualTurnLineage;finalized:FinalizedMetadata|null;
  /** Oldest entries may be dropped on overflow or expiry; no complete trace claim. */
  coverage:'bounded_best_effort';
  endpointAcknowledged:boolean;
}>;
export type VisualTurnRecorder=Readonly<{
  finalized:(turn:FinalizedTurn,request:InferenceRequest)=>void;
  rejected:(reason:'context_unavailable'|'provider_unavailable'|'cancelled'|'deadline')=>void;
  providerInvoked:()=>void;
  generationEnded:(outcome:VisualTurnOutcome)=>void;
  emitted:(channel:'text'|'audio')=>void;
  synthesisCompleted:()=>void;
  playbackFenced:(reason:'cancelled'|'invalidated'|'disconnected')=>void;
  endpointSettled:(outcome:EndpointOutcome,receivedSamples?:number)=>void;
  ended:(outcome:VisualTurnOutcome)=>void;
}>;
export type VisualTurnEvidenceFactory=(interactionId:string,modality:'text'|'audio')=>VisualTurnRecorder;
const noop=()=>{};
const none:VisualTurnRecorder=Object.freeze({finalized:noop,rejected:noop,providerInvoked:noop,generationEnded:noop,emitted:noop,synthesisCompleted:noop,playbackFenced:noop,endpointSettled:noop,ended:noop});
/** Observers have no authority: even a broken optional observer cannot stop a turn. */
export function startVisualTurnEvidence(factory:VisualTurnEvidenceFactory|undefined,interactionId:string,modality:'text'|'audio'):VisualTurnRecorder {
  try {
    if(!factory)return none;
    const observer=factory(interactionId,modality);
    const safe=<A extends unknown[]>(method:(...args:A)=>void)=>(...args:A)=>{try{method.apply(observer,args);}catch{/* Diagnostics never change reply authority. */}};
    return Object.freeze({finalized:safe(observer.finalized),rejected:safe(observer.rejected),providerInvoked:safe(observer.providerInvoked),generationEnded:safe(observer.generationEnded),emitted:safe(observer.emitted),synthesisCompleted:safe(observer.synthesisCompleted),playbackFenced:safe(observer.playbackFenced),endpointSettled:safe(observer.endpointSettled),ended:safe(observer.ended)});
  } catch {return none;}
}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export const visualDiagnosticId=(value:string)=>Buffer.byteLength(value)<=256?value:`sha256:${hash(value)}`;
function actorKey(actor:Actor):string|null {
  if(!actor||typeof actor!=='object'||types.isProxy(actor))return null;
  const values=['principalId','sessionId','assistantId'].map(key=>Object.getOwnPropertyDescriptor(actor,key)?.value as unknown);
  return values.every(value=>typeof value==='string'&&value.length>0&&value.length<=4096)?hash(JSON.stringify(values)):null;
}
const limit=128,lifetimeMs=60_000;
type Entry={actor:string;receipt:VisualTurnReceipt;expiresAtMs:number;expiresMono:number;capture:ReturnType<typeof captureTurnContextTrace>;monotonicMs:number;contextTrace:TurnContextTrace|null};
const outcomes=new Set<VisualTurnOutcome>(['completed','exhausted','failed','cancelled','invalidated','deadline','disconnected']);
const endpointOutcomes=new Set<EndpointOutcome>(['completed','stopped','timeout','disconnected','invalidated']);

/** Internal, volatile diagnostics, not the canonical trace envelope or an export
 * sink. At most 128 pending + 128 retained records. Expiry is lazy on reads/writes;
 * this does not promise idle erasure, perceived output, a visual mention or memory. */
export class VisualTurnEvidence {
  private readonly clockId=randomUUID();
  private readonly pending:Entry[]=[];
  private readonly journal:Entry[]=[];
  private queued=false;
  private closed=false;
  private epoch=0;
  private lastUtc=-Infinity;
  private lastMono=-Infinity;
  private readonly clocks:{utcMs:()=>number;monotonicMs:()=>number};
  constructor(clocks:{utcMs:()=>number;monotonicMs:()=>number}={utcMs:Date.now,monotonicMs:()=>performance.now()}){this.clocks=clocks;}
  private time():{utc:number;mono:number}|null {
    try {
      const utc=this.clocks.utcMs(),mono=this.clocks.monotonicMs();
      if(!Number.isFinite(utc)||!Number.isFinite(mono)||utc<this.lastUtc||mono<this.lastMono)throw Error('clock');
      this.lastUtc=utc;this.lastMono=mono;
      for(const entries of [this.pending,this.journal])for(let i=entries.length-1;i>=0;i--)if(utc>=entries[i]!.expiresAtMs||mono>=entries[i]!.expiresMono)entries.splice(i,1);
      return {utc,mono};
    }catch{this.pending.length=0;this.journal.length=0;this.epoch++;this.queued=false;return null;}
  }
  receipts(actor:Actor):readonly VisualTurnReceipt[] {
    try {if(this.closed||!this.time())return Object.freeze([]);const key=actorKey(actor);return Object.freeze(this.journal.filter(entry=>entry.actor===key).map(entry=>entry.receipt));}
    catch{return Object.freeze([]);}
  }
  /** Same actor boundary, expiry and eviction as the existing turn journal.
   * Partial canonical context events grant no currency, learning or effects. */
  contextTraces(actor:Actor):readonly TurnContextTrace[] {
    try{if(this.closed||!this.time())return Object.freeze([]);const key=actorKey(actor);return Object.freeze(this.journal.filter(entry=>entry.actor===key&&entry.contextTrace).map(entry=>entry.contextTrace!));}catch{return Object.freeze([]);}
  }
  close():void{this.closed=true;this.epoch++;this.pending.length=0;this.journal.length=0;}
  reset():void{this.epoch++;this.queued=false;this.pending.length=0;this.journal.length=0;}
  /** Called only by the host after it authenticates the selected store view. */
  observer(actor:Actor,selection:VisualContextSelection,binding:PreparedTurnBinding|undefined,publication:VisualPublicationLink|null,environmentId?:string):VisualTurnEvidenceFactory|undefined {
    try {
      const key=actorKey(actor),opened=this.time();if(!key||!opened||this.closed)return undefined;
      if(binding&&(binding.scope.principalId!==actor.principalId||binding.scope.sessionId!==actor.sessionId||binding.scope.assistantId!==actor.assistantId))return undefined;
      const view=selection.view;
      if(view&&(!binding||view.scope.principalId!==actor.principalId||view.scope.sessionId!==actor.sessionId||view.scope.assistantId!==actor.assistantId||view.scope.conversationId!==binding.scope.conversationId||view.scope.relationshipId!==binding.scope.relationshipId||view.scope.endpointId!==binding.scope.endpointId||view.viewId!==binding.viewId||view.revision!==binding.revision||view.invalidationKey!==binding.invalidationKey))return undefined;
      const selected=view?Object.freeze({requestId:visualDiagnosticId(view.requestId),sourceRevision:view.sourceRevision,leaseId:visualDiagnosticId(view.leaseId),audienceRevision:view.scope.audienceRevision,captureConfigurationRevision:view.scope.captureConfigurationRevision,
        capturedAtEarliestMs:view.capturedAtEarliestMs,capturedAtLatestMs:view.capturedAtLatestMs,expiresAtMs:view.expiresAtMs,
        observationIds:Object.freeze(view.observations.map(item=>visualDiagnosticId(item.observationId))),frameIds:Object.freeze([...new Set(view.observations.flatMap(item=>item.frameIds))].map(visualDiagnosticId))}):null;
      const lineage:VisualTurnLineage=Object.freeze({selectionReason:selection.reason,selected,publication:publication?Object.freeze({...publication}):null});
      const bindingRef=binding?new WeakRef(binding):null,conversationDigest=view?.conversationSectionDigest??null;
      const expectedScope={assistantId:actor.assistantId,sessionId:actor.sessionId,endpointId:binding?.scope.endpointId??null};
      const epoch=this.epoch;
      let started=false;
      return (interactionId,modality)=>{
        if(started||typeof interactionId!=='string'||!interactionId||interactionId.length>256||!['text','audio'].includes(modality))return none;
        started=true;
        let sequence=0,metadata:FinalizedMetadata|null=null,invoked=false,generationEnded=false,ended=false,rejected=false,synthesized=false,settled=false,fenced=false;
        const emitted=new Set<string>();
        const append=(stage:VisualTurnReceipt['stage'],outcome:VisualTurnReceipt['outcome']=null,channel:VisualTurnReceipt['channel']=null,receivedSamples:number|null=null,capture:ReturnType<typeof captureTurnContextTrace>=null)=>{
          try {
            if(this.closed||epoch!==this.epoch)return;
            const time=this.time();if(!time||epoch!==this.epoch)return;
            const receipt:VisualTurnReceipt=Object.freeze({interactionId,modality,sequence:++sequence,occurredAtMs:time.utc,stage,outcome,channel,receivedSamples,lineage,finalized:metadata,coverage:'bounded_best_effort',endpointAcknowledged:stage==='endpointSettled'&&(outcome==='completed'||outcome==='stopped')});
            this.pending.push({actor:key,receipt,expiresAtMs:time.utc+lifetimeMs,expiresMono:time.mono+lifetimeMs,capture,monotonicMs:time.mono,contextTrace:null});
            if(this.pending.length>limit)this.pending.shift();
            if(!this.queued){this.queued=true;const drainEpoch=this.epoch;queueMicrotask(()=>{if(drainEpoch!==this.epoch)return;this.queued=false;const processing=this.time();if(this.closed||!processing)return;const entries=this.pending.splice(0);for(const entry of entries){if(entry.capture)entry.contextTrace=materializeTurnContextTrace(entry.capture,{occurredAtMs:entry.receipt.occurredAtMs,processingAtMs:processing.utc,monotonicMs:entry.monotonicMs,clockId:this.clockId});entry.capture=null;}this.journal.push(...entries);if(this.journal.length>limit)this.journal.splice(0,this.journal.length-limit);});}
          }catch{/* No diagnostic failure can change the ordinary path. */}
        };
        return Object.freeze({
          finalized:(turn,request)=>{
            if(metadata||invoked||rejected||ended)return;
            // Call-site receives the authentic finalizer result. Require its exact
            // frozen manifest and bound scope; never retain either prompt object.
            if(!isFinalizedTurnRequest(turn,request)||!Object.isFrozen(turn)||!Object.isFrozen(request)||turn.sections!==request.manifest.sections||turn.binding!==(bindingRef?.deref()??null)||request.scope.interactionId!==interactionId||request.scope.assistantId!==expectedScope.assistantId||request.scope.sessionId!==expectedScope.sessionId||request.scope.endpointId!==expectedScope.endpointId)return;
            const conversation=request.sections.find(section=>section.kind==='conversation');
            if(request.sections.length!==9||!conversation||conversationDigest!==null&&conversation.contentDigest!==conversationDigest)return;
            metadata=Object.freeze({viewId:turn.binding?visualDiagnosticId(turn.binding.viewId):null,revision:turn.binding?.revision??null,invalidationKey:turn.binding?visualDiagnosticId(turn.binding.invalidationKey):null,
              manifestDigest:hash(JSON.stringify(request.manifest)),conversationSectionDigest:conversation.contentDigest,visualIncluded:selected!==null,
              sections:Object.freeze(request.manifest.sections.map(section=>Object.freeze({kind:section.kind,contentDigest:section.contentDigest,tokenCount:section.tokenCount})))});
            append('finalized',null,null,null,captureTurnContextTrace(turn,request,view&&view.scope.environmentId!==environmentId?undefined:environmentId));
          },
          rejected:reason=>{if(invoked||rejected||ended||!['context_unavailable','provider_unavailable','cancelled','deadline'].includes(reason))return;rejected=true;append('admissionRejected',reason);},
          providerInvoked:()=>{if(!metadata||invoked||rejected||ended)return;invoked=true;append('providerInvoked');},
          generationEnded:outcome=>{if(!invoked||generationEnded||!outcomes.has(outcome))return;generationEnded=true;append('generationEnded',outcome);},
          emitted:channel=>{if(!invoked||ended||emitted.has(channel)||!['text','audio'].includes(channel))return;emitted.add(channel);append('outputEmitted',null,channel);},
          synthesisCompleted:()=>{if(modality!=='audio'||!invoked||synthesized||ended)return;synthesized=true;append('synthesisCompleted');},
          playbackFenced:reason=>{if(modality!=='audio'||!invoked||fenced||!['cancelled','invalidated','disconnected'].includes(reason))return;fenced=true;append('playbackFenced',reason);},
          endpointSettled:(outcome,receivedSamples)=>{if(modality!=='audio'||!invoked||settled||!endpointOutcomes.has(outcome)||receivedSamples!==undefined&&(!Number.isSafeInteger(receivedSamples)||receivedSamples<0)||outcome==='completed'&&(fenced||!synthesized||!emitted.has('audio')))return;settled=true;append('endpointSettled',outcome,null,receivedSamples??null);},
          ended:outcome=>{if(ended||!outcomes.has(outcome))return;ended=true;append('turnEnded',outcome);}
        } satisfies VisualTurnRecorder);
      };
    }catch{return undefined;}
  }
}
