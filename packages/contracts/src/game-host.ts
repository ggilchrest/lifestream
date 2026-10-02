import {createHash} from 'node:crypto';
import {boundedGameDataSnapshot} from './game-journal.ts';
import {createContractValidator} from './validator.ts';
import type * as G from './game-activity.ts';

/** Transport metadata never confers game, native-installation, or effect authority. */
export const GAME_HOST_PROTOCOL = 'lifestream.game-host.v1' as const;
export const GAME_HOST_BASE_PATH = '/api/runtime/v1/game-host' as const;
export const GAME_HOST_LIMITS = Object.freeze({messageBytes:131072,pollMs:1000,attachmentMs:60000,idleMs:10000,inFlightCommands:1,pendingPolls:1});
export type GameHostRequest = G.GameObserveRequest | G.GameActionRequest | G.GameReleaseRequest;
export type GameHostResult = G.GameObserveResult | G.GameActionResult | G.GameReleaseResult;
export type GameHostAttach = {protocol:typeof GAME_HOST_PROTOCOL;hostId:string;scope:G.ActivityScope;pinsDigest:string;providerRef:string;sourceRevision:string};
export type GameHostAttachment = {protocol:typeof GAME_HOST_PROTOCOL;attachmentId:string;expiresAt:string;pollMs:1000;maxMessageBytes:131072};
export type GameHostNext = {protocol:typeof GAME_HOST_PROTOCOL;attachmentId:string};
export type GameHostCommand = {protocol:typeof GAME_HOST_PROTOCOL;kind:'command';attachmentId:string;commandId:string;requestDigest:string;expiresAt:string;request:GameHostRequest};
export type GameHostCancel = {protocol:typeof GAME_HOST_PROTOCOL;kind:'cancel';attachmentId:string;commandId:string;requestDigest:string;cancellationId:string;reason:'cancelled'|'deadline'|'scopeChanged'|'detached'|'shutdown'};
export type GameHostIdle = {protocol:typeof GAME_HOST_PROTOCOL;kind:'idle';attachmentId:string;expiresAt:string};
export type GameHostEvent = GameHostCommand | GameHostCancel | GameHostIdle;
export type GameHostAdmit = {protocol:typeof GAME_HOST_PROTOCOL;attachmentId:string;commandId:string;requestDigest:string};
/** admitted:true acknowledges the one-time entry CAS, never receipt success. */
export type GameHostAdmission = {protocol:typeof GAME_HOST_PROTOCOL;attachmentId:string;commandId:string;requestDigest:string;admitted:true;expiresAt:string};
export type GameHostCompletion = {protocol:typeof GAME_HOST_PROTOCOL;attachmentId:string;commandId:string;requestDigest:string;resultDigest:string;result:GameHostResult};
/** accepted:true acknowledges bounded ingress only. Coordinator settlement is separate. */
export type GameHostAccepted = {protocol:typeof GAME_HOST_PROTOCOL;attachmentId:string;commandId:string;resultDigest:string;accepted:true};
export type GameHostDetach = {protocol:typeof GAME_HOST_PROTOCOL;attachmentId:string};
export type GameHostDetached = {protocol:typeof GAME_HOST_PROTOCOL;attachmentId:string;fenced:true};
export type GameHostMessageName = 'attach'|'attachment'|'next'|'event'|'admit'|'admission'|'completion'|'accepted'|'detach'|'detached';
export type GameHostMessages = {attach:GameHostAttach;attachment:GameHostAttachment;next:GameHostNext;event:GameHostEvent;admit:GameHostAdmit;admission:GameHostAdmission;completion:GameHostCompletion;accepted:GameHostAccepted;detach:GameHostDetach;detached:GameHostDetached};

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
  case 'attach':valid=closed(v,['protocol','hostId','scope','pinsDigest','providerRef','sourceRevision'])&&uuid(v.hostId)&&digest(v.pinsDigest)&&ref(v.providerRef)&&digest(v.sourceRevision)&&validator.validate(schema+'ActivityScope',v.scope).valid;break;
  case 'attachment':valid=closed(v,['protocol','attachmentId','expiresAt','pollMs','maxMessageBytes'])&&attachment()&&time(v.expiresAt)&&v.pollMs===1000&&v.maxMessageBytes===131072;break;
  case 'next':case 'detach':valid=closed(v,['protocol','attachmentId'])&&attachment();break;
  case 'admit':valid=closed(v,['protocol','attachmentId','commandId','requestDigest'])&&command();break;
  case 'admission':valid=closed(v,['protocol','attachmentId','commandId','requestDigest','admitted','expiresAt'])&&command()&&v.admitted===true&&time(v.expiresAt);break;
  case 'completion':valid=closed(v,['protocol','attachmentId','commandId','requestDigest','resultDigest','result'])&&command()&&digest(v.resultDigest)&&gameMessage(v.result,true)&&gameHostDigest(v.result)===v.resultDigest;break;
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
