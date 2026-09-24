import {randomUUID} from 'node:crypto';
import {PwceConditionClient,type PwceConditionOptions,type PwceConditionIdentity,type PwceConditionResponse} from '@lifestream/providers-pwce';
import type {Database} from '@lifestream/storage-sqlite';
import {UrgentAttentionRuntime,type UrgentAttentionBinding,type UrgentAttentionScope,type UrgentAttentionFacts} from './urgent-attention.ts';
import type {OutputOnlySpeech} from './audio.ts';

type Source=Pick<PwceConditionClient,'snapshot'|'changes'>;
type Delivery=NonNullable<ReturnType<UrgentAttentionRuntime['current']>['delivery']>;
export type UrgentAttentionOptions=PwceConditionOptions&{bindings:UrgentAttentionBinding[];pollIntervalMs?:number};
export type UrgentAttentionConnection={
 scope:UrgentAttentionScope;identity:PwceConditionIdentity;facts:()=>UrgentAttentionFacts;
 send:(event:string,payload:Record<string,unknown>)=>boolean;end:()=>void;
 interrupt:(signal:AbortSignal,current:()=>boolean)=>Promise<void>;
 speak?:(input:OutputOnlySpeech)=>Promise<unknown>;
};
type Connection=UrgentAttentionConnection&{boundary:string;controller:AbortController;cursor:number|null;poll?:ReturnType<typeof setTimeout>;guard:ReturnType<typeof setInterval>;closed:boolean};
type Job={connection:Connection;delivery:Delivery;token:string;controller:AbortController;ready:()=>void;readyPromise:Promise<void>;accepted:()=>void;acceptedPromise:Promise<void>;readyReceived:boolean;timer:ReturnType<typeof setTimeout>};
const scopeKey=(scope:UrgentAttentionScope)=>JSON.stringify([scope.principalId,scope.assistantId,scope.endpointId]);
const sameScope=(a:UrgentAttentionScope,b:UrgentAttentionScope)=>scopeKey(a)===scopeKey(b);
const boundary=(f:UrgentAttentionFacts)=>JSON.stringify([f.scope,f.sessionId,f.sessionRevision,f.audienceRevision,f.authorizationRevision]);

/** A live session is an output destination, not a durable notification route.
 * Each connection starts with a non-emitting baseline. Gaps or transport loss
 * retire the connection; reconnecting cannot replay old condition episodes. */
export class UrgentAttentionHost{
 readonly runtime:UrgentAttentionRuntime;
 private readonly source:Source|undefined;
 private readonly interval:number;
 private readonly connections=new Map<string,Connection>();
 private readonly jobs=new Map<string,Job>();
 private closed=false;
 constructor(database:Database,options?:UrgentAttentionOptions,source?:Source){
  this.source=source??(options?new PwceConditionClient(options):undefined);
  this.interval=options?.pollIntervalMs??1000;
  if(!Number.isInteger(this.interval)||this.interval<250||this.interval>30000)throw Error('Invalid condition polling interval');
  this.runtime=new UrgentAttentionRuntime(database,{bindings:options?.bindings??[],allowSynthetic:options?.replay===true,onCancel:delivery=>this.cancel(delivery)});
 }
 get configured(){return !!this.source&&!this.closed;}
 inspect(scope:UrgentAttentionScope){return {...this.runtime.inspect(scope),configured:this.configured,connected:this.connections.has(scopeKey(scope)),remoteDelivery:'notConfigured',humanAcceptance:false};}
 private facts(c:Connection){try{return c.facts();}catch{return undefined;}}
 private valid(c:Connection){const f=this.facts(c);return !this.closed&&!c.closed&&!c.controller.signal.aborted&&!!f&&sameScope(f.scope,c.scope)&&boundary(f)===c.boundary&&f.authorized&&f.privateAudience&&f.sessionId!==null;}
 subscribe(input:UrgentAttentionConnection):()=>void{
  const key=scopeKey(input.scope);
  if(!this.configured)throw Error('Urgent conditions are not configured');
  if(this.connections.has(key)||this.connections.size>=8)throw Error('This destination already has an active condition connection');
  const c:Connection={...input,send:(event,payload)=>{try{return input.send(event,payload);}catch{return false;}},boundary:boundary(input.facts()),scope:structuredClone(input.scope),identity:structuredClone(input.identity),controller:new AbortController(),cursor:null,closed:false,guard:setInterval(()=>this.reconcile(),250)};
  c.guard.unref();this.connections.set(key,c);
  if(!this.valid(c)){this.disconnect(c,'scope_unavailable');throw Error('Urgent condition scope is unavailable');}
  c.send('urgent.status',{state:'synchronizing',replay:false});void this.poll(c);
  return ()=>this.disconnect(c,'destination_disconnected');
 }
 private async poll(c:Connection):Promise<void>{
  if(!this.valid(c)){this.disconnect(c,'scope_changed');return;}
  try{
   const baseline=c.cursor===null;
   const result:PwceConditionResponse=baseline?await this.source!.snapshot(c.identity,()=>this.valid(c),c.controller.signal):await this.source!.changes(c.cursor!,c.identity,()=>this.valid(c),c.controller.signal);
   if(!this.valid(c))throw Error('Scope changed');
   if(result.status==='resyncRequired'){this.disconnect(c,'source_resync_required');return;}
   for(const condition of result.conditions){
    if(!this.valid(c))throw Error('Scope changed');
    const facts=c.facts(),occupied=[...this.jobs.values()].some(job=>job.connection===c&&job.delivery.conditionRef!==condition.conditionRef&&['queued','started','delivered'].includes(job.delivery.stage));
    const admitted=this.runtime.ingest(c.scope,condition,{...facts,outputReady:facts.outputReady&&!occupied},{baseline});
    if(admitted.admitted&&admitted.delivery)void this.deliver(c,admitted.delivery);
   }
   c.cursor=result.nextCursor;
   if(!c.send('urgent.status',{state:'connected',replay:result.replay,baseline,conditions:result.conditions.length}))throw Error('Output connection closed');
   c.poll=setTimeout(()=>void this.poll(c),result.hasMore?Math.min(250,this.interval):this.interval);c.poll.unref();
  }catch{this.disconnect(c,'source_unavailable');}
 }
 private current(job:Job):boolean{
  if(!this.valid(job.connection)||job.controller.signal.aborted)return false;
  const result=this.runtime.current(job.delivery.id,job.connection.facts());if(result.delivery)job.delivery=result.delivery;
  return result.current;
 }
 private async waitReceipt(job:Job,promise:Promise<void>):Promise<void>{
  let abort=()=>{};let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([promise,new Promise<never>((_,reject)=>{abort=()=>reject(Error('Destination not ready'));job.controller.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,5000);if(job.controller.signal.aborted)abort();})]);}
  finally{if(timer)clearTimeout(timer);job.controller.signal.removeEventListener('abort',abort);}
 }
 private async deliver(c:Connection,delivery:Delivery):Promise<void>{
  let ready=()=>{},accepted=()=>{};const readyPromise=new Promise<void>(resolve=>{ready=resolve;}),acceptedPromise=new Promise<void>(resolve=>{accepted=resolve;});
  const job:Job={connection:c,delivery,token:randomUUID(),controller:new AbortController(),ready,readyPromise,accepted,acceptedPromise,readyReceived:false,timer:setTimeout(()=>this.stopJob(delivery.id,'condition_expired'),Math.max(1,Date.parse(delivery.expiresAt)-Date.now()))};job.timer.unref();this.jobs.set(delivery.id,job);
  try{
   if(!this.current(job))throw Error('Admission expired');
   // The endpoint explicitly prepares its existing output before any speech.
   if(!c.send('urgent.prepare',{id:delivery.id,receiptToken:job.token,modality:delivery.modality,expiresAt:delivery.expiresAt}))throw Error('Destination closed');
   await this.waitReceipt(job,job.readyPromise);if(!this.current(job))throw Error('Destination scope changed');
   await c.interrupt(job.controller.signal,()=>this.current(job));if(!this.current(job))throw Error('Prior output did not settle');
   job.delivery=this.runtime.transition(delivery.id,job.delivery.revision,'started');
   job.delivery=this.runtime.observe(delivery.id,job.delivery.revision,{expressionDisposition:delivery.modality==='speech'?'pending':'degraded',degradedDimensions:['renderer',...(delivery.modality==='text'?['expression' as const]:[])]});
   if(!c.send('urgent.delivery',{id:delivery.id,interactionId:delivery.id,receiptToken:job.token,text:delivery.text,modality:delivery.modality,expiresAt:delivery.expiresAt,conditionRef:delivery.conditionRef,sourceRef:delivery.sourceRef,eventClass:delivery.eventClass,urgency:'critical'}))throw Error('Destination closed');
   if(delivery.modality==='speech'){
    if(!c.speak)throw Error('Speech destination unavailable');
    await c.speak({assistantId:c.scope.assistantId,text:delivery.text,interactionId:delivery.id,endpointId:c.scope.endpointId,deadlineAt:delivery.expiresAt,urgency:'critical',warmth:0,signal:job.controller.signal,current:()=>this.current(job),beforeEmission:()=>{if(!this.current(job))throw Error('Output admission changed');},emitted:()=>{},expressionObserved:observation=>{
     if(!this.current(job))return;
     job.delivery=this.runtime.observe(delivery.id,job.delivery.revision,{speechDisposition:observation.speechStage==='providerReported'?'pending':'speaking',expressionDisposition:'degraded',degradedDimensions:['renderer',...(observation.degradedDimensions.length?['expression' as const]:[])]});
    }});
    await this.waitReceipt(job,job.acceptedPromise);
    if(!this.current(job)||job.delivery.stage!=='delivered')throw Error('Endpoint acceptance unavailable');
    job.delivery=this.runtime.transition(delivery.id,job.delivery.revision,'completed');
    c.send('urgent.completed',{id:delivery.id,playbackCompleted:true,humanAcknowledged:false});
   }
  }catch{this.stopJob(delivery.id,'delivery_unavailable');}
 }
 /** The receipt is unguessable and bound to the original stream and session.
  * Human acknowledgment uses the separate durable policy control endpoint. */
 receipt(scope:UrgentAttentionScope,sessionId:string,body:Record<string,unknown>):void{
  if(Object.keys(body).some(k=>!['operation','deliveryId','receiptToken','stage'].includes(k))||typeof body.deliveryId!=='string'||typeof body.receiptToken!=='string'||typeof body.stage!=='string'||!['ready','endpointAccepted','stopped'].includes(body.stage))throw Error('Invalid delivery receipt');
  const job=this.jobs.get(body.deliveryId);
  if(!job||!sameScope(scope,job.delivery.scope)||job.delivery.sessionId!==sessionId||job.token!==body.receiptToken||!this.current(job))throw Error('Delivery receipt is no longer current');
  if(body.stage==='stopped'){this.stopJob(job.delivery.id,'endpoint_stopped');return;}
  if(body.stage==='ready'){if(!job.readyReceived){job.readyReceived=true;job.ready();}return;}
  if(!job.readyReceived||!['started','delivered','completed'].includes(job.delivery.stage))throw Error('Delivery was not emitted');
  if(job.delivery.stage==='started')job.delivery=this.runtime.transition(job.delivery.id,job.delivery.revision,'delivered');
  job.accepted();
  if(job.delivery.modality==='text'&&job.delivery.stage==='delivered')job.delivery=this.runtime.transition(job.delivery.id,job.delivery.revision,'completed');
 }
 private cancel(delivery:Delivery){const job=this.jobs.get(delivery.id);if(!job)return;job.delivery=delivery;job.controller.abort();clearTimeout(job.timer);this.jobs.delete(delivery.id);job.connection.send('urgent.cancel',{id:delivery.id,reason:delivery.reason??'cancelled'});}
 private stopJob(id:string,reason:string){const job=this.jobs.get(id);if(!job)return;try{const latest=this.runtime.current(id,job.connection.facts()).delivery;if(latest)job.delivery=latest;if(['queued','started','delivered','completed'].includes(job.delivery.stage))this.runtime.cancel(id,job.delivery.revision,reason);}finally{if(this.jobs.has(id))this.cancel(job.delivery);}}
 reconcile(){for(const c of this.connections.values())if(!this.valid(c))this.disconnect(c,'scope_changed');for(const job of this.jobs.values())if(job.delivery.stage!=='completed'&&!this.current(job))this.stopJob(job.delivery.id,'scope_changed');}
 private disconnect(c:Connection,reason:string){if(c.closed)return;c.closed=true;c.controller.abort();clearInterval(c.guard);if(c.poll)clearTimeout(c.poll);this.connections.delete(scopeKey(c.scope));this.runtime.invalidate(c.scope,reason);for(const job of this.jobs.values())if(job.connection===c)this.cancel(job.delivery);c.send('urgent.status',{state:'unavailable',reason});c.end();}
 close(){if(this.closed)return;this.closed=true;for(const c of this.connections.values())this.disconnect(c,'host_stopped');}
}
