import {randomUUID} from 'node:crypto';
import type {Database,Transaction} from './database.ts';

export type UrgentAttentionScope={principalId:string;assistantId:string;endpointId:string};
export type UrgentAttentionRule={sourceRef:string;eventClass:string;enabled:boolean;bypassQuietHours:boolean};
export type UrgentAttentionQuietHours={timeZone:string;startMinute:number;endMinute:number};
export type UrgentAttentionSettings={revision:number;rules:UrgentAttentionRule[];modality:'text'|'speech';quietHours:UrgentAttentionQuietHours|null;snoozedUntil:string|null};
export type UrgentAttentionConfiguration=Omit<UrgentAttentionSettings,'revision'>;
export type UrgentAttentionStage='queued'|'started'|'delivered'|'completed'|'cancelled'|'uncertain';
export type UrgentAttentionSpeechDisposition='notRequested'|'pending'|'speaking'|'completed'|'unavailable'|'muted'|'interrupted';
export type UrgentAttentionExpressionDisposition='notRequested'|'pending'|'observed'|'degraded'|'unavailable';
export type UrgentAttentionDegradation='speech'|'expression'|'renderer'|'playback';
export type UrgentAttentionObservation={speechDisposition?:UrgentAttentionSpeechDisposition;expressionDisposition?:UrgentAttentionExpressionDisposition;degradedDimensions?:UrgentAttentionDegradation[]};
/** Bounded foreign metadata. Producer prose, media and evidence contents are not retained here. */
export type UrgentAttentionCondition={conditionRef:string;revision:number;sourceRef:string;worldRef:string;siteRef:string;zoneRef:string;eventClass:string;sourceRevision:number;status:'open'|'resolved'|'expired';severity:'info'|'warning'|'critical';freshness:'fresh'|'stale'|'expired';basis:'observed'|'derived'|'synthetic';qualification:'qualified'|'uncertain'|'unavailable';confidence:number|null;evidenceRefs:string[];freshUntil:string;expiresAt:string;updatedAt:string};
export type UrgentAttentionConditionRecord={scope:UrgentAttentionScope;condition:UrgentAttentionCondition;baselineSeen:boolean;terminalSeen:boolean;identityConflict:boolean;reasons:string[];observedAt:string};
export type UrgentAttentionDelivery={id:string;revision:number;scope:UrgentAttentionScope;conditionRef:string;conditionRevision:number;sourceRef:string;eventClass:string;stage:UrgentAttentionStage;reason:string|null;modality:'text'|'speech';text:string;expiresAt:string;settingsRevision:number;sessionId:string;sessionRevision:number;audienceRevision:number;authorizationRevision:number;createdAt:string;updatedAt:string;deliveredAt:string|null;endpointAcceptedAt:string|null;completedAt:string|null;playbackCompletedAt:string|null;acknowledgedAt:string|null;speechDisposition:UrgentAttentionSpeechDisposition;expressionDisposition:UrgentAttentionExpressionDisposition;degradedDimensions:UrgentAttentionDegradation[]};
export type UrgentAttentionDeliveryInput=Pick<UrgentAttentionDelivery,'modality'|'text'|'expiresAt'|'settingsRevision'|'sessionId'|'sessionRevision'|'audienceRevision'|'authorizationRevision'>;
export class UrgentAttentionError extends Error {readonly code:string;constructor(code:string){super(code);this.name='UrgentAttentionError';this.code=code;}}
const fail=(code:string):never=>{throw new UrgentAttentionError(code);};
const identifier=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
export function urgentAttentionScopeKey(scope:UrgentAttentionScope):string{
 if(!scope||Object.keys(scope).sort().join(',')!=='assistantId,endpointId,principalId'||!Object.values(scope).every(identifier))return fail('invalid_scope');
 return JSON.stringify([scope.principalId,scope.assistantId,scope.endpointId]);
}
export const defaultUrgentAttentionSettings=():UrgentAttentionSettings=>({revision:0,rules:[],modality:'text',quietHours:null,snoozedUntil:null});
export function validateUrgentAttentionConfiguration(value:UrgentAttentionConfiguration):void{
 if(!value||Object.keys(value).sort().join(',')!=='modality,quietHours,rules,snoozedUntil'||!['text','speech'].includes(value.modality)||!Array.isArray(value.rules)||value.rules.length>128)return fail('invalid_settings');
 const keys=new Set<string>();for(const rule of value.rules){
  if(!rule||Object.keys(rule).sort().join(',')!=='bypassQuietHours,enabled,eventClass,sourceRef'||!identifier(rule.sourceRef)||!identifier(rule.eventClass)||typeof rule.enabled!=='boolean'||typeof rule.bypassQuietHours!=='boolean')return fail('invalid_rule');
  const key=JSON.stringify([rule.sourceRef,rule.eventClass]);if(keys.has(key))return fail('duplicate_rule');keys.add(key);
 }
 if(value.quietHours!==null){const q=value.quietHours;
  if(!q||Object.keys(q).sort().join(',')!=='endMinute,startMinute,timeZone'||!identifier(q.timeZone)||![q.startMinute,q.endMinute].every(m=>Number.isInteger(m)&&m>=0&&m<1440)||q.startMinute===q.endMinute)return fail('invalid_quiet_hours');
  try{new Intl.DateTimeFormat('en',{timeZone:q.timeZone}).format(0);}catch{return fail('invalid_quiet_hours');}
 }
 if(value.snoozedUntil!==null&&(typeof value.snoozedUntil!=='string'||value.snoozedUntil.length>64||!Number.isFinite(Date.parse(value.snoozedUntil))))return fail('invalid_snooze');
}
type Row={json:string};
const decode=<T>(row:Row|undefined):T|undefined=>row?JSON.parse(row.json) as T:undefined;
const active=(stage:UrgentAttentionStage)=>!['cancelled','uncertain'].includes(stage);
const working=(stage:UrgentAttentionStage)=>['queued','started','delivered'].includes(stage);
const identity=(c:UrgentAttentionCondition)=>JSON.stringify([c.sourceRef,c.worldRef,c.siteRef,c.zoneRef,c.eventClass]);

export class UrgentAttentionRepository{
 readonly database:Database;
 constructor(database:Database){this.database=database;}
 private settingsIn(tx:Transaction,key:string):UrgentAttentionSettings{return decode<UrgentAttentionSettings>(tx.get<Row>('SELECT settings_json AS json FROM urgent_attention_settings WHERE scope_key=?',key))??defaultUrgentAttentionSettings();}
 settings(scope:UrgentAttentionScope):UrgentAttentionSettings{return decode<UrgentAttentionSettings>(this.database.connection.prepare('SELECT settings_json AS json FROM urgent_attention_settings WHERE scope_key=?').get(urgentAttentionScopeKey(scope)) as Row|undefined)??defaultUrgentAttentionSettings();}
 private saveDelivery(tx:Transaction,d:UrgentAttentionDelivery){tx.run('UPDATE urgent_attention_deliveries SET revision=?,stage=?,updated_at=?,record_json=? WHERE delivery_id=?',d.revision,d.stage,d.updatedAt,JSON.stringify(d),d.id);}
 private cancelIn(tx:Transaction,key:string,reason:string,now:string,conditionRef?:string):UrgentAttentionDelivery[]{
  const rows=conditionRef===undefined?tx.all<Row>('SELECT record_json AS json FROM urgent_attention_deliveries WHERE scope_key=?',key):tx.all<Row>('SELECT record_json AS json FROM urgent_attention_deliveries WHERE scope_key=? AND condition_ref=?',key,conditionRef);
  const cancelled:UrgentAttentionDelivery[]=[];
  for(const row of rows){const d=JSON.parse(row.json) as UrgentAttentionDelivery;if(!active(d.stage))continue;d.stage='cancelled';d.reason=reason;d.revision++;d.updatedAt=now;if(d.speechDisposition==='speaking')d.speechDisposition='interrupted';this.saveDelivery(tx,d);cancelled.push(d);}
  return cancelled;
 }
 configure(scope:UrgentAttentionScope,expectedRevision:number,configuration:UrgentAttentionConfiguration,now:string){
  validateUrgentAttentionConfiguration(configuration);const key=urgentAttentionScopeKey(scope);
  return this.database.transaction(tx=>{
   const previous=this.settingsIn(tx,key);if(!Number.isSafeInteger(expectedRevision)||previous.revision!==expectedRevision)return fail('settings_revision_conflict');
   const settings:UrgentAttentionSettings={...structuredClone(configuration),revision:previous.revision+1};tx.run('INSERT INTO urgent_attention_settings VALUES (?,?,?) ON CONFLICT(scope_key) DO UPDATE SET revision=excluded.revision,settings_json=excluded.settings_json',key,settings.revision,JSON.stringify(settings));
   return {settings,cancelled:this.cancelIn(tx,key,'settings_changed',now)};
  });
 }
 condition(scope:UrgentAttentionScope,conditionRef:string){return decode<UrgentAttentionConditionRecord>(this.database.connection.prepare('SELECT record_json AS json FROM urgent_attention_conditions WHERE scope_key=? AND condition_ref=?').get(urgentAttentionScopeKey(scope),conditionRef) as Row|undefined);}
 get(id:string){return decode<UrgentAttentionDelivery>(this.database.connection.prepare('SELECT record_json AS json FROM urgent_attention_deliveries WHERE delivery_id=?').get(id) as Row|undefined);}
 inspect(scope:UrgentAttentionScope){const key=urgentAttentionScopeKey(scope);return {
  conditions:(this.database.connection.prepare('SELECT record_json AS json FROM urgent_attention_conditions WHERE scope_key=? ORDER BY updated_at DESC,condition_ref LIMIT 100').all(key) as Row[]).map(row=>JSON.parse(row.json) as UrgentAttentionConditionRecord),
  deliveries:(this.database.connection.prepare('SELECT record_json AS json FROM urgent_attention_deliveries WHERE scope_key=? ORDER BY updated_at DESC,delivery_id LIMIT 100').all(key) as Row[]).map(row=>JSON.parse(row.json) as UrgentAttentionDelivery),
 };}
 observeCondition(scope:UrgentAttentionScope,condition:UrgentAttentionCondition,baseline:boolean,now:string,consider:(settings:UrgentAttentionSettings,record:UrgentAttentionConditionRecord)=>{reasons:string[];delivery?:UrgentAttentionDeliveryInput}){
  const key=urgentAttentionScopeKey(scope);
  return this.database.transaction(tx=>{
   const previous=decode<UrgentAttentionConditionRecord>(tx.get<Row>('SELECT record_json AS json FROM urgent_attention_conditions WHERE scope_key=? AND condition_ref=?',key,condition.conditionRef));
   if(previous&&previous.condition.revision>=condition.revision){
    // A resync can suppress an already observed episode even when its revision is unchanged.
    if(baseline&&!previous.baselineSeen){previous.baselineSeen=true;previous.reasons=['baseline'];tx.run('UPDATE urgent_attention_conditions SET record_json=? WHERE scope_key=? AND condition_ref=?',JSON.stringify(previous),key,condition.conditionRef);return {admitted:false,reasons:['baseline'],cancelled:this.cancelIn(tx,key,'baseline',now,condition.conditionRef)};}
    return {admitted:false,reasons:['duplicate_or_reordered'],cancelled:[]};
   }
   const record:UrgentAttentionConditionRecord={scope:structuredClone(scope),condition:structuredClone(condition),baselineSeen:baseline||previous?.baselineSeen===true,terminalSeen:condition.status!=='open'||previous?.terminalSeen===true,identityConflict:previous?.identityConflict===true||!!previous&&identity(previous.condition)!==identity(condition),reasons:[],observedAt:now};
   const cancelled=this.cancelIn(tx,key,'condition_changed',now,condition.conditionRef);
   const seen=tx.get<Row>('SELECT record_json AS json FROM urgent_attention_deliveries WHERE scope_key=? AND condition_ref=?',key,condition.conditionRef);
   const decision:{reasons:string[];delivery?:UrgentAttentionDeliveryInput}=record.baselineSeen?{reasons:['baseline']}:record.identityConflict?{reasons:['condition_identity_conflict']}:record.terminalSeen?{reasons:['condition_terminal']}:seen?{reasons:['already_admitted']}:consider(this.settingsIn(tx,key),record);
   record.reasons=[...decision.reasons];let delivery:UrgentAttentionDelivery|undefined;
   if(decision.delivery&&decision.reasons.length===0){const input=decision.delivery;
    delivery={...structuredClone(input),id:randomUUID(),revision:1,scope:structuredClone(scope),conditionRef:condition.conditionRef,conditionRevision:condition.revision,sourceRef:condition.sourceRef,eventClass:condition.eventClass,stage:'queued',reason:null,createdAt:now,updatedAt:now,deliveredAt:null,endpointAcceptedAt:null,completedAt:null,playbackCompletedAt:null,acknowledgedAt:null,speechDisposition:input.modality==='speech'?'pending':'notRequested',expressionDisposition:'pending',degradedDimensions:[]};
    tx.run('INSERT INTO urgent_attention_deliveries VALUES (?,?,?,?,?,?,?)',delivery.id,key,condition.conditionRef,delivery.revision,delivery.stage,now,JSON.stringify(delivery));
   }
   tx.run('INSERT INTO urgent_attention_conditions VALUES (?,?,?,?,?) ON CONFLICT(scope_key,condition_ref) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,record_json=excluded.record_json',key,condition.conditionRef,condition.revision,now,JSON.stringify(record));
   return {admitted:!!delivery,reasons:record.reasons,cancelled,...(delivery?{delivery}: {})};
  });
 }
 cancel(scope:UrgentAttentionScope,reason:string,now:string,conditionRef?:string){return this.database.transaction(tx=>this.cancelIn(tx,urgentAttentionScopeKey(scope),reason,now,conditionRef));}
 private mutate(id:string,expectedRevision:number,now:string,operation:(delivery:UrgentAttentionDelivery)=>void){return this.database.transaction(tx=>{
  const d=decode<UrgentAttentionDelivery>(tx.get<Row>('SELECT record_json AS json FROM urgent_attention_deliveries WHERE delivery_id=?',id));if(!d)return fail('delivery_not_found');if(!Number.isSafeInteger(expectedRevision)||d.revision!==expectedRevision)return fail('delivery_revision_conflict');operation(d);d.revision++;d.updatedAt=now;this.saveDelivery(tx,d);return d;
 });}
 transition(id:string,expectedRevision:number,stage:Exclude<UrgentAttentionStage,'queued'>,now:string){return this.mutate(id,expectedRevision,now,d=>{
  const allowed:Record<UrgentAttentionStage,UrgentAttentionStage[]>={queued:['started','cancelled','uncertain'],started:['delivered','cancelled','uncertain'],delivered:['completed','cancelled','uncertain'],completed:['cancelled'],cancelled:[],uncertain:[]};
  if(!allowed[d.stage].includes(stage))return fail('invalid_delivery_transition');d.stage=stage;
  if(stage==='delivered')d.deliveredAt=d.endpointAcceptedAt=now;
  if(stage==='completed'){d.completedAt=now;if(d.modality==='speech'){d.playbackCompletedAt=now;d.speechDisposition='completed';}}
  if(stage==='cancelled'||stage==='uncertain'){d.reason=stage;if(d.speechDisposition==='speaking')d.speechDisposition='interrupted';}
 });}
 cancelDelivery(id:string,expectedRevision:number,reason:string,now:string){return this.mutate(id,expectedRevision,now,d=>{
  if(!active(d.stage))return fail('invalid_delivery_transition');d.stage='cancelled';d.reason=reason;if(d.speechDisposition==='speaking')d.speechDisposition='interrupted';
 });}
 observe(id:string,expectedRevision:number,observation:UrgentAttentionObservation,now:string){return this.mutate(id,expectedRevision,now,d=>{
  // Terminal history cannot be rewritten by late provider or endpoint callbacks.
  if(!working(d.stage))return fail('invalid_delivery_observation');
  if(!observation||Object.keys(observation).some(key=>!['speechDisposition','expressionDisposition','degradedDimensions'].includes(key)))return fail('invalid_delivery_observation');
  if(observation.speechDisposition!==undefined){const value=observation.speechDisposition;if(!['notRequested','pending','speaking','completed','unavailable','muted','interrupted'].includes(value)||value==='speaking'&&!['started','delivered'].includes(d.stage)||value==='completed'&&d.stage!=='completed'||value==='interrupted'&&!['cancelled','uncertain'].includes(d.stage))return fail('invalid_delivery_observation');d.speechDisposition=value;}
  if(observation.expressionDisposition!==undefined){if(!['notRequested','pending','observed','degraded','unavailable'].includes(observation.expressionDisposition))return fail('invalid_delivery_observation');d.expressionDisposition=observation.expressionDisposition;}
  if(observation.degradedDimensions!==undefined){if(!Array.isArray(observation.degradedDimensions)||observation.degradedDimensions.length>4||new Set(observation.degradedDimensions).size!==observation.degradedDimensions.length||observation.degradedDimensions.some(v=>!['speech','expression','renderer','playback'].includes(v)))return fail('invalid_delivery_observation');d.degradedDimensions=[...observation.degradedDimensions];}
 });}
 acknowledge(scope:UrgentAttentionScope,id:string,expectedRevision:number,now:string){return this.mutate(id,expectedRevision,now,d=>{if(urgentAttentionScopeKey(d.scope)!==urgentAttentionScopeKey(scope))return fail('delivery_not_found');if(d.acknowledgedAt!==null)return fail('already_acknowledged');d.acknowledgedAt=now;});}
 recover(now:string){return this.database.transaction(tx=>{
  const changed:UrgentAttentionDelivery[]=[];for(const row of tx.all<Row>("SELECT record_json AS json FROM urgent_attention_deliveries WHERE stage IN ('queued','started','delivered')")){const d=JSON.parse(row.json) as UrgentAttentionDelivery;if(!working(d.stage))continue;d.stage='uncertain';d.reason='consumer_restarted';d.revision++;d.updatedAt=now;if(d.speechDisposition==='speaking')d.speechDisposition='interrupted';this.saveDelivery(tx,d);changed.push(d);}return changed;
 });}
 quarantine(now:string){return this.database.transaction(tx=>{
  let scopes=0,cancelledDeliveries=0;
  for(const row of tx.all<{scope_key:string;json:string}>('SELECT scope_key,settings_json AS json FROM urgent_attention_settings')){const settings=JSON.parse(row.json) as UrgentAttentionSettings;settings.revision++;settings.rules=settings.rules.map(rule=>({...rule,enabled:false,bypassQuietHours:false}));settings.snoozedUntil=null;tx.run('UPDATE urgent_attention_settings SET revision=?,settings_json=? WHERE scope_key=?',settings.revision,JSON.stringify(settings),row.scope_key);scopes++;}
  for(const row of tx.all<{scope_key:string}>('SELECT DISTINCT scope_key FROM urgent_attention_deliveries'))cancelledDeliveries+=this.cancelIn(tx,row.scope_key,'restore_quarantine',now).length;
  for(const row of tx.all<{scope_key:string;condition_ref:string;json:string}>('SELECT scope_key,condition_ref,record_json AS json FROM urgent_attention_conditions')){const c=JSON.parse(row.json) as UrgentAttentionConditionRecord;c.baselineSeen=true;c.reasons=['restore_quarantine'];tx.run('UPDATE urgent_attention_conditions SET record_json=? WHERE scope_key=? AND condition_ref=?',JSON.stringify(c),row.scope_key,row.condition_ref);}
  return {scopes,cancelledDeliveries};
 });}
}
