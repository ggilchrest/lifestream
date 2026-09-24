import type {PwceCondition} from '@lifestream/providers-pwce';
import {UrgentAttentionRepository,UrgentAttentionError,urgentAttentionScopeKey,validateUrgentAttentionConfiguration,type Database,type UrgentAttentionScope,type UrgentAttentionSettings,type UrgentAttentionConfiguration,type UrgentAttentionCondition,type UrgentAttentionConditionRecord,type UrgentAttentionDelivery,type UrgentAttentionStage,type UrgentAttentionObservation} from '@lifestream/storage-sqlite';
export type {UrgentAttentionScope,UrgentAttentionSettings,UrgentAttentionDelivery,UrgentAttentionObservation} from '@lifestream/storage-sqlite';

export type UrgentAttentionBinding={sourceRef:string;eventClass:string;worldRef:string;siteRef:string;zoneRef:string;label:string};
export type UrgentAttentionFacts={scope:UrgentAttentionScope;sessionId:string|null;sessionRevision:number;audienceRevision:number;authorizationRevision:number;authorized:boolean;privateAudience:boolean;attentionSuitable:boolean;outputReady:boolean;quiet?:boolean};
export type UrgentAttentionControl={action:'acknowledge';deliveryId:string;expectedRevision:number}|{action:'snooze';until:string;expectedRevision:number}|{action:'disable';expectedRevision:number};
export type UrgentAttentionOptions={bindings:UrgentAttentionBinding[];now?:()=>Date;allowSynthetic?:boolean;onCancel?:(delivery:UrgentAttentionDelivery)=>void};
const fail=(code:string):never=>{throw new UrgentAttentionError(code);};
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const bindingKey=(value:{sourceRef:string;eventClass:string})=>JSON.stringify([value.sourceRef,value.eventClass]);
const sameScope=(a:UrgentAttentionScope,b:UrgentAttentionScope)=>urgentAttentionScopeKey(a)===urgentAttentionScopeKey(b);
const working=(stage:UrgentAttentionStage)=>['queued','started','delivered'].includes(stage);
const date=(value:unknown)=>typeof value==='string'&&value.length<=64&&Number.isFinite(Date.parse(value));
const revision=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
const reasonsValid=(reason:string)=>/^[a-z][a-z0-9_]{0,79}$/.test(reason);

function projection(value:PwceCondition):UrgentAttentionCondition{
 const fields=['conditionRef','revision','sourceRef','worldRef','siteRef','zoneRef','eventClass','sourceRevision','status','transition','severity','summary','occurredAt','receivedAt','updatedAt','freshUntil','expiresAt','freshness','basis','qualification'];
 if(!value||typeof value!=='object'||Object.keys(value).length!==fields.length||Object.keys(value).some(key=>!fields.includes(key))||!['conditionRef','sourceRef','worldRef','siteRef','zoneRef','eventClass'].every(key=>id(value[key as keyof PwceCondition]))||!Number.isSafeInteger(value.revision)||value.revision<1||!Number.isSafeInteger(value.sourceRevision)||value.sourceRevision<1
  ||!['open','resolved','expired'].includes(value.status)||!['info','warning','critical'].includes(value.severity)||!['fresh','stale','expired'].includes(value.freshness)||!['observed','derived','synthetic'].includes(value.basis)||typeof value.summary!=='string'||value.summary.length<1||value.summary.length>1024
  ||![value.occurredAt,value.receivedAt,value.updatedAt,value.freshUntil,value.expiresAt].every(date)||Date.parse(value.freshUntil)>Date.parse(value.expiresAt)
  ||value.status==='open'&&!['open','update'].includes(value.transition)||value.status==='resolved'&&value.transition!=='resolve'||value.status==='expired'&&value.transition!=='expire')return fail('invalid_condition');
 const q=value.qualification;
 if(!q||Object.keys(q).sort().join(',')!=='confidence,evidenceRefs,limitations,state'||!['qualified','uncertain','unavailable'].includes(q.state)||(q.confidence!==null&&(!Number.isFinite(q.confidence)||q.confidence<0||q.confidence>1))
  ||!Array.isArray(q.limitations)||q.limitations.length>8||new Set(q.limitations).size!==q.limitations.length||!q.limitations.every(item=>typeof item==='string'&&item.length<=256)
  ||!Array.isArray(q.evidenceRefs)||q.evidenceRefs.length>16||new Set(q.evidenceRefs).size!==q.evidenceRefs.length||!q.evidenceRefs.every(item=>typeof item==='string'&&item.length>=1&&item.length<=128))return fail('invalid_condition');
 return {conditionRef:value.conditionRef,revision:value.revision,sourceRef:value.sourceRef,worldRef:value.worldRef,siteRef:value.siteRef,zoneRef:value.zoneRef,eventClass:value.eventClass,sourceRevision:value.sourceRevision,status:value.status,severity:value.severity,freshness:value.freshness,basis:value.basis,qualification:q.state,confidence:q.confidence,evidenceRefs:[...q.evidenceRefs],freshUntil:value.freshUntil,expiresAt:value.expiresAt,updatedAt:value.updatedAt};
}
function scheduledQuiet(settings:UrgentAttentionSettings,now:Date){
 const quiet=settings.quietHours;if(!quiet)return false;
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:quiet.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
 const minute=Number(parts.find(part=>part.type==='hour')?.value)*60+Number(parts.find(part=>part.type==='minute')?.value);
 return quiet.startMinute<quiet.endMinute?minute>=quiet.startMinute&&minute<quiet.endMinute:minute>=quiet.startMinute||minute<quiet.endMinute;
}

/** Optional consumer output policy. No prompt, memory, provider or producer mutation. */
export class UrgentAttentionRuntime{
 private readonly repository:UrgentAttentionRepository;
 private readonly bindings:UrgentAttentionBinding[];
 private readonly now:()=>Date;
 private readonly synthetic:boolean;
 private readonly onCancel:((delivery:UrgentAttentionDelivery)=>void)|undefined;
 constructor(database:Database,options:UrgentAttentionOptions){
  if(!options||!Array.isArray(options.bindings)||options.bindings.length>128)throw new UrgentAttentionError('invalid_bindings');
  const keys=new Set<string>();for(const b of options.bindings){if(!b||Object.keys(b).sort().join(',')!=='eventClass,label,siteRef,sourceRef,worldRef,zoneRef'||!Object.values(b).every(id)||b.label.length>128||keys.has(bindingKey(b)))throw new UrgentAttentionError('invalid_bindings');keys.add(bindingKey(b));}
  this.repository=new UrgentAttentionRepository(database);this.bindings=structuredClone(options.bindings);this.now=options.now??(()=>new Date());this.synthetic=options.allowSynthetic===true;this.onCancel=options.onCancel;
  this.notify(this.repository.recover(this.time().toISOString()));
 }
 private time(){const now=this.now();if(!(now instanceof Date)||!Number.isFinite(now.getTime()))return fail('invalid_clock');return now;}
 private notify(deliveries:UrgentAttentionDelivery[]){let failed=false;for(const d of deliveries)try{this.onCancel?.(structuredClone(d));}catch{failed=true;}if(failed)return fail('cancel_callback_failed');}
 settings(scope:UrgentAttentionScope):UrgentAttentionSettings{
  const settings=this.repository.settings(scope);return {...settings,rules:this.bindings.map(b=>settings.rules.find(rule=>bindingKey(rule)===bindingKey(b))??{sourceRef:b.sourceRef,eventClass:b.eventClass,enabled:false,bypassQuietHours:false})};
 }
 configure(scope:UrgentAttentionScope,input:UrgentAttentionConfiguration&{expectedRevision:number}){
  if(!input||Object.keys(input).sort().join(',')!=='expectedRevision,modality,quietHours,rules,snoozedUntil')return fail('invalid_settings');
  const {expectedRevision,...configuration}=input;validateUrgentAttentionConfiguration(configuration);
  if(configuration.rules.some(rule=>!this.bindings.some(b=>bindingKey(b)===bindingKey(rule))))return fail('unknown_rule');
  const now=this.time();if(configuration.snoozedUntil!==null&&Date.parse(configuration.snoozedUntil)>now.getTime()+86400000)return fail('invalid_snooze');
  const result=this.repository.configure(scope,expectedRevision,configuration,now.toISOString());this.notify(result.cancelled);return this.settings(scope);
 }
 private eligible(scope:UrgentAttentionScope,condition:UrgentAttentionCondition,settings:UrgentAttentionSettings,facts:UrgentAttentionFacts,now:Date):string[]{
  const reasons:string[]=[];const binding=this.bindings.find(b=>bindingKey(b)===bindingKey(condition));
  if(!binding||binding.worldRef!==condition.worldRef||binding.siteRef!==condition.siteRef||binding.zoneRef!==condition.zoneRef)reasons.push('source_binding');
  if(!facts||!sameScope(scope,facts.scope))reasons.push('scope_changed');
  if(facts?.authorized!==true)reasons.push('authority_unavailable');if(facts?.privateAudience!==true)reasons.push('audience_restricted');
  if(facts?.attentionSuitable!==true)reasons.push('attention_unsuitable');if(facts?.outputReady!==true)reasons.push('output_unavailable');
  if(!facts||!id(facts.sessionId)||![facts.sessionRevision,facts.audienceRevision,facts.authorizationRevision].every(revision))reasons.push('session_unavailable');
  if(condition.status!=='open')reasons.push('condition_terminal');if(condition.severity!=='critical')reasons.push('not_critical');
  if(condition.qualification!=='qualified')reasons.push('source_unqualified');
  if(condition.freshness!=='fresh'||Date.parse(condition.freshUntil)<=now.getTime()||Date.parse(condition.expiresAt)<=now.getTime()||Date.parse(condition.updatedAt)>now.getTime())reasons.push('condition_not_current');
  if(condition.basis==='synthetic'&&!this.synthetic)reasons.push('synthetic_not_enabled');
  const rule=settings.rules.find(rule=>bindingKey(rule)===bindingKey(condition));if(!rule?.enabled)reasons.push('rule_disabled');
  if(settings.snoozedUntil!==null&&Date.parse(settings.snoozedUntil)>now.getTime())reasons.push('snoozed');
  if((facts?.quiet===true||scheduledQuiet(settings,now))&&rule?.bypassQuietHours!==true)reasons.push('quiet_hours');
  return reasons;
 }
 ingest(scope:UrgentAttentionScope,condition:PwceCondition,facts:UrgentAttentionFacts,options:{baseline?:boolean}={}){
  urgentAttentionScopeKey(scope);if(!options||Object.keys(options).some(key=>key!=='baseline')||options.baseline!==undefined&&typeof options.baseline!=='boolean')return fail('invalid_ingest_options');
  const current=projection(condition),now=this.time();
  const result=this.repository.observeCondition(scope,current,options.baseline===true,now.toISOString(),(settings,record)=>{
   const reasons=this.eligible(scope,record.condition,settings,facts,now);if(reasons.length)return {reasons};
   const binding=this.bindings.find(b=>bindingKey(b)===bindingKey(current))!;
   const text=(current.basis==='synthetic'?'Simulation. ':'')+`Critical alert: ${binding.label}. A qualified source reports an unresolved condition.`;
   return {reasons,delivery:{modality:settings.modality,text,expiresAt:new Date(Math.min(Date.parse(current.freshUntil),Date.parse(current.expiresAt))).toISOString(),settingsRevision:settings.revision,sessionId:facts.sessionId!,sessionRevision:facts.sessionRevision,audienceRevision:facts.audienceRevision,authorizationRevision:facts.authorizationRevision}};
  });
  this.notify(result.cancelled);return {admitted:result.admitted,reasons:result.reasons,...(result.delivery?{delivery:result.delivery}:{})};
 }
 private retained(d:UrgentAttentionDelivery,now:Date):{reasons:string[];condition?:UrgentAttentionConditionRecord;settings:UrgentAttentionSettings}{
  const condition=this.repository.condition(d.scope,d.conditionRef),settings=this.repository.settings(d.scope),reasons:string[]=[];
  if(Date.parse(d.expiresAt)<=now.getTime())reasons.push('condition_expired');
  if(settings.revision!==d.settingsRevision)reasons.push('settings_changed');
  if(!condition||condition.condition.revision!==d.conditionRevision||condition.baselineSeen||condition.terminalSeen||condition.identityConflict)reasons.push('condition_changed');
  return {reasons,settings,...(condition?{condition}:{})};
 }
 current(deliveryId:string,facts:UrgentAttentionFacts):{current:boolean;reasons:string[];delivery?:UrgentAttentionDelivery}{
  const d=this.repository.get(deliveryId);if(!d||!facts||!sameScope(d.scope,facts.scope))return {current:false,reasons:['delivery_not_found']};
  if(!working(d.stage))return {current:false,reasons:['delivery_terminal'],delivery:d};
  const now=this.time(),retained=this.retained(d,now),reasons=[...retained.reasons];
  if(retained.condition)reasons.push(...this.eligible(d.scope,retained.condition.condition,retained.settings,facts,now));
  if(d.sessionId!==facts.sessionId||d.sessionRevision!==facts.sessionRevision)reasons.push('session_changed');
  if(d.audienceRevision!==facts.audienceRevision)reasons.push('audience_changed');if(d.authorizationRevision!==facts.authorizationRevision)reasons.push('authority_changed');
  if(reasons.length){const cancelled=this.repository.cancelDelivery(d.id,d.revision,reasons[0]!,now.toISOString());this.notify([cancelled]);return {current:false,reasons:[...new Set(reasons)],delivery:cancelled};}
  return {current:true,reasons:[],delivery:d};
 }
 transition(id:string,expectedRevision:number,stage:Exclude<UrgentAttentionStage,'queued'>){
  if(!['started','delivered','completed','cancelled','uncertain'].includes(stage))return fail('invalid_delivery_transition');
  const now=this.time(),d=this.repository.get(id);if(!d)return fail('delivery_not_found');
  if(!['cancelled','uncertain'].includes(stage)&&this.retained(d,now).reasons.length){this.cancel(id,expectedRevision,'delivery_stale');return fail('delivery_stale');}
  const result=this.repository.transition(id,expectedRevision,stage,now.toISOString());if(stage==='cancelled'||stage==='uncertain')this.notify([result]);return result;
 }
 observe(id:string,expectedRevision:number,observation:UrgentAttentionObservation){return this.repository.observe(id,expectedRevision,observation,this.time().toISOString());}
 cancel(id:string,expectedRevision:number,reason:string){if(!reasonsValid(reason))return fail('invalid_reason');const result=this.repository.cancelDelivery(id,expectedRevision,reason,this.time().toISOString());this.notify([result]);return result;}
 invalidate(scope:UrgentAttentionScope,reason:string){if(!reasonsValid(reason))return fail('invalid_reason');const result=this.repository.cancel(scope,reason,this.time().toISOString());this.notify(result);return result;}
 inspect(scope:UrgentAttentionScope){return {settings:this.settings(scope),bindings:structuredClone(this.bindings),...this.repository.inspect(scope)};}
 control(scope:UrgentAttentionScope,input:UrgentAttentionControl):{settings:UrgentAttentionSettings;delivery?:UrgentAttentionDelivery}{
  if(!input||typeof input!=='object')return fail('invalid_control');
  if(input.action==='acknowledge'){
   if(Object.keys(input).sort().join(',')!=='action,deliveryId,expectedRevision')return fail('invalid_control');
   const delivery=this.repository.acknowledge(scope,input.deliveryId,input.expectedRevision,this.time().toISOString());return {settings:this.settings(scope),delivery};
  }
  const settings=this.settings(scope);let configuration:UrgentAttentionConfiguration={rules:settings.rules,modality:settings.modality,quietHours:settings.quietHours,snoozedUntil:settings.snoozedUntil};
  if(input.action==='disable'){if(Object.keys(input).sort().join(',')!=='action,expectedRevision')return fail('invalid_control');configuration={...configuration,rules:settings.rules.map(rule=>({...rule,enabled:false,bypassQuietHours:false})),snoozedUntil:null};}
  else if(input.action==='snooze'){if(Object.keys(input).sort().join(',')!=='action,expectedRevision,until'||!date(input.until)||Date.parse(input.until)<=this.time().getTime()||Date.parse(input.until)>this.time().getTime()+86400000)return fail('invalid_snooze');configuration.snoozedUntil=input.until;}
  else return fail('invalid_control');
  return {settings:this.configure(scope,{...configuration,expectedRevision:input.expectedRevision})};
 }
}
