import {isDeepStrictEqual} from 'node:util';
import {capabilityInputDigest} from '@lifestream/runtime/capabilities/resolver';
import type {CapabilityProvider,CapabilityScope,CapabilityDefinition,CapabilitySnapshotRequest,CapabilityCallContext,AdmittedCapabilityInvocation,CapabilityStatusRequest,CapabilityInvocationResult} from '@lifestream/runtime/capabilities/ports';
import {TelegramPairingRepository,type Database,type TelegramBinding} from '@lifestream/storage-sqlite';
import {URGENT_AWAY_INPUT_SCHEMA,URGENT_AWAY_OUTPUT_SCHEMA,URGENT_AWAY_NOTICE,URGENT_AWAY_SIMULATION_NOTICE} from '../runtime/urgent-away.ts';
import type {TelegramBotApi} from './telegram-api.ts';

export const telegramNoticeCapability:CapabilityDefinition=Object.freeze({id:'notification.telegram',version:'1.0.0',route:'telegram-private',inputSchema:URGENT_AWAY_INPUT_SCHEMA,outputSchema:URGENT_AWAY_OUTPUT_SCHEMA,sideEffect:'irreversible',authorization:'required',idempotency:'idempotent',latencyClass:'bounded',offlineAvailable:false,simulationSupported:false});
type Row={invocation_id:string;scope_digest:string;input_digest:string;binding_digest:string;subscription_id:string;state:'sending'|'accepted'|'rejected'|'unknown'|'cancelled';message_id:number|null;updated_at:number};
const opaque=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const scopeOf=(s:CapabilityScope):CapabilityScope=>({assistantId:s.assistantId,endpointId:s.endpointId,sessionId:s.sessionId,environment:s.environment,authorityContextRef:s.authorityContextRef});
/** Shared argument validation for grant scope derivation and the last transport gate. */
export function validTelegramNoticeInput(invocation:Pick<AdmittedCapabilityInvocation,'input'|'invocationId'>,binding:TelegramBinding,now=Date.now()):boolean{
 const input=invocation.input as Record<string,unknown>|null;
 return !(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='conditionRef,destinationRef,evidenceRefs,expiresAt,message,notificationRef,schemaVersion'||input.schemaVersion!=='1.0.0'||input.destinationRef!==binding.subscriptionId||input.notificationRef!==invocation.invocationId||!opaque(input.conditionRef)||typeof input.expiresAt!=='string'||!Number.isFinite(Date.parse(input.expiresAt))||Date.parse(input.expiresAt)<=now||Date.parse(input.expiresAt)>now+600_000||![URGENT_AWAY_NOTICE,URGENT_AWAY_SIMULATION_NOTICE].includes(input.message as string)||!Array.isArray(input.evidenceRefs)||input.evidenceRefs.length);
}
/** Transport only. The existing capability resolver/authority dispatcher must
 * admit the effect; this adapter cannot create a grant or authorize a condition.
 * Only fixed redacted notices are sent, never incident refs or arbitrary text. */
export class TelegramNoticeProvider implements CapabilityProvider {
 private readonly db:Database;private readonly pairs:TelegramPairingRepository;
 private readonly api:Pick<TelegramBotApi,'send'>;private readonly scope:CapabilityScope;private readonly binding:TelegramBinding;
 private readonly allowed:()=>boolean;private readonly scopeDigest:string;private readonly bindingDigest:string;
 constructor(options:{database:Database;api:Pick<TelegramBotApi,'send'>;scope:CapabilityScope;binding:TelegramBinding;allowed:()=>boolean}){
  this.db=options.database;this.pairs=new TelegramPairingRepository(this.db);this.api=options.api;this.scope=structuredClone(options.scope);this.binding=structuredClone(options.binding);this.allowed=options.allowed;
  if(this.scope.assistantId!==this.binding.assistantId||!this.binding.alertsEnabled||![this.scope.assistantId,this.scope.endpointId,this.scope.sessionId,this.scope.environment,this.scope.authorityContextRef?.contextId,this.scope.authorityContextRef?.providerRef].every(opaque)||!Number.isSafeInteger(this.scope.authorityContextRef?.revision))throw Error('Telegram notice binding invalid');
  this.scopeDigest=capabilityInputDigest(this.scope);this.bindingDigest=capabilityInputDigest(this.binding);
  this.db.connection.prepare("UPDATE telegram_notice_deliveries SET state='unknown',updated_at=? WHERE subscription_id=? AND state='sending'").run(Date.now(),this.binding.subscriptionId);
 }
 private current(request:CapabilityScope,context:CapabilityCallContext){try{return context.executionMode==='live'&&!context.signal.aborted&&Date.parse(context.deadlineAt)>Date.now()&&context.isCurrent()&&this.allowed()&&this.pairs.current(this.binding)&&isDeepStrictEqual(scopeOf(request),this.scope);}catch{return false;}}
 private result(row:Row):CapabilityInvocationResult{
  return {invocationId:row.invocation_id,lifecycle:row.state==='accepted'?'succeeded':row.state==='sending'||row.state==='unknown'?'outcomeUnknown':'failed',...(row.state==='accepted'?{output:{schemaVersion:'1.0.0',accepted:true,receiptRef:'telegram.message:'+row.message_id}}:{}),reason:row.state==='accepted'?'provider_accepted':row.state==='unknown'||row.state==='sending'?'provider_unknown':'provider_not_accepted'};
 }
 async getSnapshot(request:CapabilitySnapshotRequest,context:CapabilityCallContext){if(!this.current(request,context))throw Error('Telegram notice unavailable');return {...structuredClone(this.scope),snapshotId:'telegram-notice:'+this.binding.subscriptionId,revision:this.binding.revision,expiresAt:new Date(Math.min(Date.now()+10_000,Date.parse(context.deadlineAt))).toISOString(),capabilities:[telegramNoticeCapability]};}
 async getInvocation(request:CapabilityStatusRequest,context:CapabilityCallContext){if(!this.current(request,context)||!opaque(request.invocationId))throw Error('Telegram notice unavailable');const row=this.db.connection.prepare('SELECT * FROM telegram_notice_deliveries WHERE invocation_id=?').get(request.invocationId) as Row|undefined;if(row&&(row.scope_digest!==this.scopeDigest||row.binding_digest!==this.bindingDigest))throw Error('Telegram notice unavailable');return row?this.result(row):undefined;}
 async invoke(invocation:AdmittedCapabilityInvocation,capability:CapabilityDefinition,context:CapabilityCallContext):Promise<CapabilityInvocationResult>{
  const denied=():CapabilityInvocationResult=>({invocationId:invocation.invocationId,lifecycle:'denied',reason:'telegram_notice_scope_or_authority_unavailable'});
  if(!this.current(invocation,context)||!opaque(invocation.invocationId)||invocation.idempotencyKey!==invocation.invocationId||invocation.capabilityId!==telegramNoticeCapability.id||invocation.capabilityVersion!==telegramNoticeCapability.version||invocation.snapshotId!=='telegram-notice:'+this.binding.subscriptionId||invocation.snapshotRevision!==this.binding.revision||!isDeepStrictEqual(capability,telegramNoticeCapability)||invocation.dispatchReceipt?.status!=='admitted'||invocation.dispatchReceipt.invocationId!==invocation.invocationId||!Number.isSafeInteger(invocation.dispatchReceipt.grantRevision)||invocation.dispatchReceipt.grantRevision<0)return denied();
  if(!validTelegramNoticeInput(invocation,this.binding))return denied();
  const input=invocation.input as {expiresAt:string;message:string};
  const inputDigest=capabilityInputDigest(input),previous=this.db.connection.prepare('SELECT * FROM telegram_notice_deliveries WHERE invocation_id=?').get(invocation.invocationId) as Row|undefined;
  if(previous)return previous.scope_digest===this.scopeDigest&&previous.binding_digest===this.bindingDigest&&previous.input_digest===inputDigest?this.result(previous):denied();
  if(Number(this.db.connection.prepare('SELECT count(*) AS n FROM telegram_notice_deliveries').get()!.n)>=4096)return {...denied(),reason:'telegram_notice_journal_capacity'};
  this.db.connection.prepare("INSERT INTO telegram_notice_deliveries VALUES(?,?,?,?,?,'sending',NULL,?)").run(invocation.invocationId,this.scopeDigest,inputDigest,this.bindingDigest,this.binding.subscriptionId,Date.now());
  let state:Row['state']='cancelled',messageId:number|null=null;
  if(this.current(invocation,context)&&Date.parse(input.expiresAt)>Date.now()){
   const controller=new AbortController(),deadline=AbortSignal.timeout(Math.max(1,Math.min(Date.parse(context.deadlineAt),Date.parse(input.expiresAt))-Date.now())),signal=AbortSignal.any([controller.signal,deadline,context.signal]);
   const guard=setInterval(()=>{if(!this.current(invocation,context))controller.abort();},100);guard.unref();
   try{const result=await this.api.send(this.binding.chatId,input.message as string,signal);state=result.status==='accepted'?'accepted':result.status==='unknown'?'unknown':result.status==='notStarted'?'cancelled':'rejected';if(result.status==='accepted')messageId=result.messageId;}
   catch{state='unknown';}finally{clearInterval(guard);controller.abort();}
  }
  this.db.connection.prepare('UPDATE telegram_notice_deliveries SET state=?,message_id=?,updated_at=? WHERE invocation_id=?').run(state,messageId,Date.now(),invocation.invocationId);
  return this.result(this.db.connection.prepare('SELECT * FROM telegram_notice_deliveries WHERE invocation_id=?').get(invocation.invocationId) as Row);
 }
}
