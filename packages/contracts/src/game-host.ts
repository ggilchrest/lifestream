import {createHash} from 'node:crypto';
import {boundedGameDataSnapshot} from './game-journal.ts';
import {createContractValidator} from './validator.ts';
import type * as G from './game-activity.ts';

/** Transport metadata never confers game, native-installation, or effect authority. */
export const GAME_HOST_PROTOCOL = 'lifestream.game-host.v1' as const;
export const GAME_HOST_NATIVE_EVIDENCE_VERSION='lifestream.native-game-evidence.v1' as const;
export const GAME_HOST_BASE_PATH = '/api/runtime/v1/game-host' as const;
export const GAME_HOST_LIMITS = Object.freeze({messageBytes:131072,pollMs:1000,attachmentMs:60000,idleMs:10000,inFlightCommands:1,pendingPolls:1});
export type GameHostRequest = G.GameObserveRequest | G.GameActionRequest | G.GameReleaseRequest;
export type GameHostResult = G.GameObserveResult | G.GameActionResult | G.GameReleaseResult;
export type GameHostAttach = {protocol:typeof GAME_HOST_PROTOCOL;hostId:string;scope:G.ActivityScope;pinsDigest:string;providerRef:string;sourceRevision:string;nativeEvidenceVersion?:typeof GAME_HOST_NATIVE_EVIDENCE_VERSION};
export type GameHostAttachment = {protocol:typeof GAME_HOST_PROTOCOL;attachmentId:string;expiresAt:string;pollMs:1000;maxMessageBytes:131072;nativeEvidenceVersion?:typeof GAME_HOST_NATIVE_EVIDENCE_VERSION};
export type GameHostNext = {protocol:typeof GAME_HOST_PROTOCOL;attachmentId:string};
export type GameHostCommand = {protocol:typeof GAME_HOST_PROTOCOL;kind:'command';attachmentId:string;commandId:string;requestDigest:string;expiresAt:string;request:GameHostRequest};
export type GameHostCancel = {protocol:typeof GAME_HOST_PROTOCOL;kind:'cancel';attachmentId:string;commandId:string;requestDigest:string;cancellationId:string;reason:'cancelled'|'deadline'|'scopeChanged'|'detached'|'shutdown'};
export type GameHostIdle = {protocol:typeof GAME_HOST_PROTOCOL;kind:'idle';attachmentId:string;expiresAt:string};
export type GameHostEvent = GameHostCommand | GameHostCancel | GameHostIdle;
export type GameHostAdmit = {protocol:typeof GAME_HOST_PROTOCOL;attachmentId:string;commandId:string;requestDigest:string};
/** admitted:true acknowledges the one-time entry CAS, never receipt success. */
export type GameHostAdmission = {protocol:typeof GAME_HOST_PROTOCOL;attachmentId:string;commandId:string;requestDigest:string;admitted:true;expiresAt:string};
export type NativeControllerUsageEvidence={schemaVersion:'1.0.0';recordType:'nativeControllerUsageEvidence';scope:G.ActivityScope;pinsDigest:string;providerRef:string;requestDigest:string;resultDigest:string;inputOwnerLeaseId:string;startedMonotonicMs:number;completedMonotonicMs:number;verifiedInputFrames:number;nativeActionDigest:string};
export type NativeShutdownEvidence={schemaVersion:'1.0.0';recordType:'nativeShutdownEvidence';scope:G.ActivityScope;pinsDigest:string;providerRef:string;actionRequestDigest:string;targetInputOwnerLeaseId:string;release:G.GameReleaseResult};
export type GameHostCompletion = {protocol:typeof GAME_HOST_PROTOCOL;attachmentId:string;commandId:string;requestDigest:string;resultDigest:string;result:GameHostResult;nativeUsage?:NativeControllerUsageEvidence|null};
export type GameHostShutdown={protocol:typeof GAME_HOST_PROTOCOL;attachmentId:string;nativeEvidenceVersion:typeof GAME_HOST_NATIVE_EVIDENCE_VERSION;evidence:NativeShutdownEvidence|null};
export type GameHostShutdownAccepted={protocol:typeof GAME_HOST_PROTOCOL;attachmentId:string;recorded:true;nativeShutdownConfirmed:boolean};
/** accepted:true acknowledges bounded ingress only. Coordinator settlement is separate. */
export type GameHostAccepted = {protocol:typeof GAME_HOST_PROTOCOL;attachmentId:string;commandId:string;resultDigest:string;accepted:true};
export type GameHostDetach = {protocol:typeof GAME_HOST_PROTOCOL;attachmentId:string};
export type GameHostDetached = {protocol:typeof GAME_HOST_PROTOCOL;attachmentId:string;fenced:true};
export type GameHostMessageName = 'attach'|'attachment'|'next'|'event'|'admit'|'admission'|'completion'|'accepted'|'detach'|'detached'|'shutdown'|'shutdownAccepted';
export type GameHostMessages = {attach:GameHostAttach;attachment:GameHostAttachment;next:GameHostNext;event:GameHostEvent;admit:GameHostAdmit;admission:GameHostAdmission;completion:GameHostCompletion;accepted:GameHostAccepted;detach:GameHostDetach;detached:GameHostDetached;shutdown:GameHostShutdown;shutdownAccepted:GameHostShutdownAccepted};

const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const digest=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const time=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const ref=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=500;
const closed=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const requestDefinitions = {'GameActivityAdapter.observe':'GameObserveRequest','GameActivityAdapter.applyController':'GameActionRequest','GameActivityAdapter.releaseControls':'GameReleaseRequest'} as const;
const resultDefinitions = {'GameActivityAdapter.observe':'GameObserveResult','GameActivityAdapter.applyController':'GameActionResult','GameActivityAdapter.releaseControls':'GameReleaseResult'} as const;
function gameMessage(v:unknown,result:boolean):boolean{
 if(!v||typeof v!=='object'||!('operation' in v)||typeof v.operation!=='string')return false;
 const definitions=result?resultDefinitions:requestDefinitions;
 return Object.hasOwn(definitions,v.operation)&&(result||'executionMode' in v&&v.executionMode==='normal')&&validator.validate(schema+definitions[v.operation as keyof typeof definitions],v).valid;
}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function canonical(v:unknown):string{
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 if(v&&typeof v==='object')return '{'+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}';
 return JSON.stringify(v);
}
/** SHA-256 of lossless bounded JSON, recursively lexicographically sorted keys. */
export function gameHostDigest(input:unknown):string{
 const v=boundedGameDataSnapshot(input,GAME_HOST_LIMITS.messageBytes);
 if(v===null)throw new Error('invalid_game_host_data');
 return createHash('sha256').update(canonical(v),'utf8').digest('hex');
}
/** Closed, cloned and deeply immutable envelope; null on unsupported operations. */
export function gameHostMessage<N extends GameHostMessageName>(name:N,input:unknown):GameHostMessages[N]|null{
 const snapshot=boundedGameDataSnapshot(input,GAME_HOST_LIMITS.messageBytes);
 if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))return null;
 const v=snapshot as Record<string,unknown>;
 if(v.protocol!==GAME_HOST_PROTOCOL)return null;
 const attachment=()=>uuid(v.attachmentId),command=()=>attachment()&&uuid(v.commandId)&&digest(v.requestDigest);
 let valid=false;
 switch(name){
  case 'attach':valid=closed(v,['protocol','hostId','scope','pinsDigest','providerRef','sourceRevision',...(Object.hasOwn(v,'nativeEvidenceVersion')?['nativeEvidenceVersion']:[])])&&(!Object.hasOwn(v,'nativeEvidenceVersion')||v.nativeEvidenceVersion===GAME_HOST_NATIVE_EVIDENCE_VERSION)&&uuid(v.hostId)&&digest(v.pinsDigest)&&ref(v.providerRef)&&digest(v.sourceRevision)&&validator.validate(schema+'ActivityScope',v.scope).valid;break;
  case 'attachment':valid=closed(v,['protocol','attachmentId','expiresAt','pollMs','maxMessageBytes',...(Object.hasOwn(v,'nativeEvidenceVersion')?['nativeEvidenceVersion']:[])])&&(!Object.hasOwn(v,'nativeEvidenceVersion')||v.nativeEvidenceVersion===GAME_HOST_NATIVE_EVIDENCE_VERSION)&&attachment()&&time(v.expiresAt)&&v.pollMs===1000&&v.maxMessageBytes===131072;break;
  case 'next':case 'detach':valid=closed(v,['protocol','attachmentId'])&&attachment();break;
  case 'admit':valid=closed(v,['protocol','attachmentId','commandId','requestDigest'])&&command();break;
  case 'admission':valid=closed(v,['protocol','attachmentId','commandId','requestDigest','admitted','expiresAt'])&&command()&&v.admitted===true&&time(v.expiresAt);break;
  case 'completion':valid=closed(v,['protocol','attachmentId','commandId','requestDigest','resultDigest','result',...(Object.hasOwn(v,'nativeUsage')?['nativeUsage']:[])])&&command()&&digest(v.resultDigest)&&gameMessage(v.result,true)&&gameHostDigest(v.result)===v.resultDigest&&(!Object.hasOwn(v,'nativeUsage')||((v.result as GameHostResult).operation==='GameActivityAdapter.applyController'&&(v.nativeUsage===null||nativeUsageEvidence(v.nativeUsage))));break;
  case 'shutdown':valid=closed(v,['protocol','attachmentId','nativeEvidenceVersion','evidence'])&&attachment()&&v.nativeEvidenceVersion===GAME_HOST_NATIVE_EVIDENCE_VERSION&&(v.evidence===null||nativeShutdownEvidence(v.evidence));break;
  case 'shutdownAccepted':valid=closed(v,['protocol','attachmentId','recorded','nativeShutdownConfirmed'])&&attachment()&&v.recorded===true&&typeof v.nativeShutdownConfirmed==='boolean';break;
  case 'accepted':valid=closed(v,['protocol','attachmentId','commandId','resultDigest','accepted'])&&attachment()&&uuid(v.commandId)&&digest(v.resultDigest)&&v.accepted===true;break;
  case 'detached':valid=closed(v,['protocol','attachmentId','fenced'])&&attachment()&&v.fenced===true;break;
  case 'event':
   if(v.kind==='command')valid=closed(v,['protocol','kind','attachmentId','commandId','requestDigest','expiresAt','request'])&&command()&&time(v.expiresAt)&&gameMessage(v.request,false)&&gameHostDigest(v.request)===v.requestDigest;
   else if(v.kind==='cancel')valid=closed(v,['protocol','kind','attachmentId','commandId','requestDigest','cancellationId','reason'])&&command()&&uuid(v.cancellationId)&&['cancelled','deadline','scopeChanged','detached','shutdown'].includes(v.reason as string);
   else if(v.kind==='idle')valid=closed(v,['protocol','kind','attachmentId','expiresAt'])&&attachment()&&time(v.expiresAt);
   break;
 }
 return valid?freeze(snapshot as GameHostMessages[N]):null;
}
/** Cross-message correlation only; schema validity/authenticated ingress is not qualification. */
export function gameHostCompletionMatches(command:GameHostCommand,completion:GameHostCompletion):boolean{
 return completion.attachmentId===command.attachmentId&&completion.commandId===command.commandId&&completion.requestDigest===command.requestDigest&&completion.result.operation===command.request.operation&&completion.result.requestId===command.request.requestId&&completion.result.correlationId===command.request.correlationId&&gameHostDigest(completion.result)===completion.resultDigest;
}

function nativeUsageEvidence(raw:unknown):raw is NativeControllerUsageEvidence{
 const p=raw as NativeControllerUsageEvidence;
 return !!p&&typeof p==='object'&&closed(p as unknown as Record<string,unknown>,['schemaVersion','recordType','scope','pinsDigest','providerRef','requestDigest','resultDigest','inputOwnerLeaseId','startedMonotonicMs','completedMonotonicMs','verifiedInputFrames','nativeActionDigest'])&&p.schemaVersion==='1.0.0'&&p.recordType==='nativeControllerUsageEvidence'&&validator.validate(schema+'ActivityScope',p.scope).valid&&[p.pinsDigest,p.requestDigest,p.resultDigest,p.nativeActionDigest].every(digest)&&ref(p.providerRef)&&uuid(p.inputOwnerLeaseId)&&Number.isFinite(p.startedMonotonicMs)&&p.startedMonotonicMs>=0&&Number.isFinite(p.completedMonotonicMs)&&p.completedMonotonicMs>=p.startedMonotonicMs&&Number.isSafeInteger(p.verifiedInputFrames)&&p.verifiedInputFrames>=0;
}
function nativeShutdownEvidence(raw:unknown):raw is NativeShutdownEvidence{
 const p=raw as NativeShutdownEvidence,r=p?.release,payload=r?.outcome.payload;
 return !!p&&typeof p==='object'&&closed(p as unknown as Record<string,unknown>,['schemaVersion','recordType','scope','pinsDigest','providerRef','actionRequestDigest','targetInputOwnerLeaseId','release'])&&p.schemaVersion==='1.0.0'&&p.recordType==='nativeShutdownEvidence'&&validator.validate(schema+'ActivityScope',p.scope).valid&&digest(p.pinsDigest)&&digest(p.actionRequestDigest)&&ref(p.providerRef)&&uuid(p.targetInputOwnerLeaseId)&&gameMessage(r,true)&&r.operation==='GameActivityAdapter.releaseControls'&&r.providerRef===p.providerRef&&r.outcome.status==='succeeded'&&payload?.targetInputOwnerLeaseId===p.targetInputOwnerLeaseId&&payload.disposition==='neutralizedAndPaused'&&payload.emulatorPaused===true&&payload.buttonsNeutralized===true&&payload.confirmationSource==='adapterObserved'&&Number.isSafeInteger(payload.pauseFrameNumber)&&Number(payload.pauseFrameNumber)>=0&&payload.pauseFrameNumber===payload.verifiedFrameNumber&&Number.isFinite(payload.pauseConfirmedMonotonicMs)&&Number(payload.pauseConfirmedMonotonicMs)>=0&&Number.isFinite(payload.verifiedMonotonicMs)&&Number(payload.verifiedMonotonicMs)>=Number(payload.pauseConfirmedMonotonicMs);
}
/** Correlation/arithmetic are necessary evidence checks, never source authority. */
export function gameHostUsageMatches(request:G.GameActionRequest,result:G.GameActionResult,evidence:NativeControllerUsageEvidence):boolean{
 try{
  const p=evidence,receipt=result.outcome.payload;
  return nativeUsageEvidence(p)&&result.operation===request.operation&&result.requestId===request.requestId&&result.correlationId===request.correlationId&&result.outcome.status==='succeeded'&&!!receipt&&gameHostDigest(p.scope)===gameHostDigest(request.scope)&&p.pinsDigest===request.payload.expectedPinsDigest&&p.providerRef===result.providerRef&&p.requestDigest===gameHostDigest(request)&&p.resultDigest===gameHostDigest(result)&&p.inputOwnerLeaseId===request.payload.inputOwnerLeaseId&&p.completedMonotonicMs-p.startedMonotonicMs<=request.payload.proposal.maxWallMs&&p.verifiedInputFrames===receipt.framesApplied&&receipt.buttonsNeutralized===true&&receipt.actionId===request.payload.actionId&&receipt.proposalId===request.payload.proposal.proposalId&&receipt.idempotencyKey===request.idempotencyKey&&receipt.inputDigest===request.payload.admission.inputDigest&&receipt.admissionId===request.payload.admission.admissionId&&gameHostDigest(receipt.scope)===gameHostDigest(request.scope)&&receipt.beforeFrame===request.payload.expectedFrameNumber&&receipt.afterFrame!==null&&receipt.framesApplied===receipt.afterFrame-receipt.beforeFrame!&&p.nativeActionDigest===gameHostDigest({requestId:request.requestId,correlationId:request.correlationId,inputOwnerLeaseId:p.inputOwnerLeaseId,startedMonotonicMs:p.startedMonotonicMs,completedMonotonicMs:p.completedMonotonicMs,verifiedInputFrames:p.verifiedInputFrames,requestedButtons:request.payload.buttonVector,receipt});
 }catch{return false;}
}
export function gameHostShutdownMatches(binding:Omit<GameHostAttach,'protocol'>,action:G.GameActionRequest,evidence:NativeShutdownEvidence):boolean{
 try{return nativeShutdownEvidence(evidence)&&gameHostDigest(evidence.scope)===gameHostDigest(binding.scope)&&gameHostDigest(action.scope)===gameHostDigest(binding.scope)&&evidence.pinsDigest===binding.pinsDigest&&evidence.providerRef===binding.providerRef&&evidence.actionRequestDigest===gameHostDigest(action)&&evidence.targetInputOwnerLeaseId===action.payload.inputOwnerLeaseId;}catch{return false;}
}

/** Dedicated owned-PNG lane. Ordinary control messages retain their original
 * bound. This path supplies no source, actor, disclosure or controller grant. */
export const GAME_HOST_FRAME_LIMITS=Object.freeze({pngBytes:2097152,longEdge:1024,ageMs:30000});
export function parseGameHostFramePath(input:unknown):Readonly<{attachmentId:string;commandId:string;requestDigest:string;mediaRef:string}>|null{
 if(typeof input!=='string'||!input.startsWith(GAME_HOST_BASE_PATH+'/frame/'))return null;
 const parts=input.slice((GAME_HOST_BASE_PATH+'/frame/').length).split('/');
 if(parts.length!==4||!uuid(parts[0])||!uuid(parts[1])||!digest(parts[2])||!uuid(parts[3]))return null;
 return Object.freeze({attachmentId:parts[0]!,commandId:parts[1]!,requestDigest:parts[2]!,mediaRef:parts[3]!});
}
export function gameHostFramePath(command:GameHostCommand,mediaRef:string):string{
 const checked=gameHostMessage('event',command);
 if(!checked||checked.kind!=='command'||checked.request.operation!=='GameActivityAdapter.observe'||!uuid(mediaRef))throw Error('invalid_game_host_frame');
 return GAME_HOST_BASE_PATH+'/frame/'+[checked.attachmentId,checked.commandId,checked.requestDigest,mediaRef].join('/');
}
export function gameHostFrameAccepted(input:unknown):boolean{
 const value=boundedGameDataSnapshot(input,GAME_HOST_LIMITS.messageBytes);
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&closed(value as Record<string,unknown>,['accepted'])&&(value as Record<string,unknown>).accepted===true;
}
