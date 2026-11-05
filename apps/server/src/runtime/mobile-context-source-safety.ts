import {types} from 'node:util';
import {unifiedDesktopSnapshot} from '@lifestream/contracts/unified-desktop-contracts';
import {calendarSettingsCanonical,calendarControlRequest,calendarControlRequestDigest,calendarControlReservationDigest,calendarControlProjection} from '@lifestream/contracts/mobile-context-calendar-settings-control';
import type{CalendarEnrollment}from'@lifestream/contracts/mobile-context-calendar-delivery';
import {mobileInterpretationDigest} from '@lifestream/contracts/mobile-context-interpretation';
import {randomUUID} from 'node:crypto';
import {mobileControlSelection,mobileControlProjection} from '@lifestream/storage-sqlite';
import {mobileControlRequest,mobileControlRequestDigest} from '@lifestream/contracts/mobile-context-control';
import type {Database,MobileAccess,MobileEnrollment,MobileGovernance,MobilePolicyCapture,CalendarAccess,CalendarGovernance} from '@lifestream/storage-sqlite';
import type {RecoveryJournal,SourceRecoveryScope,SourceRecoveryIntent} from '../admin/recovery-journal.ts';

/** Policy remains owned elsewhere. These ports cannot be replaced by source
 * selections or by this deny-only adapter; missing authority must deny use. */
export type MobileSourcePolicy = Pick<MobileGovernance,'allowed'|'retention'|'recordCurrent'|'invalidate'>&Required<Pick<MobileGovernance,'capturePolicy'>>;
type SourceActor=Pick<MobileAccess,'principalId'|'endpointId'|'current'>;
type SourceEnrollmentScope={principalId:string;collector:SourceRecoveryScope['collector'];sourceNamespace:string|null};
export type MobileSourceSafety=Pick<MobileGovernance,'controlFence'|'controlPhase'|'controlFamily'|'interpretationEvidence'>&{current:(a:SourceActor)=>boolean;suppressed:(a:SourceActor,key:string)=>boolean;suppressedBatch:(a:SourceActor,keys:readonly string[],e:SourceEnrollmentScope)=>boolean;remove:(a:SourceActor,keys:readonly string[],e:SourceEnrollmentScope,reason?:'sourceRemoved'|'recordDeleted'|'retentionExpired')=>void;removalEvidence:(a:SourceActor,e:SourceEnrollmentScope)=>{epoch:number}|null};
export type CalendarSourcePolicy=Pick<CalendarGovernance,'capturePolicy'|'allowed'|'retention'|'invalidate'|'recordCurrent'|'captureSyncScope'|'acceptedRecord'>&Readonly<{captureConsentReadFence?:(a:CalendarAccess)=>Readonly<{current:()=>boolean}>|null}>;

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

// Missing or corrupt SQL originals cannot erase independently remembered
// admission. This is a conservative same-human collection/use hold, never a grant.
function controlOriginalsCurrent(journal:RecoveryJournal,database:Database,a:SourceActor,quota:number,withInterpretation:boolean):boolean{
 try{for(const c of journal.sourceSnapshot().controls??[]){if(c.principalId!==a.principalId)continue;if(c.phaseVersion!=='1.0.0')return false;
  const row=database.connection.prepare(`SELECT request_digest,state,attempt_started,CASE WHEN length(CAST(selection_json AS BLOB))<=? THEN selection_json ELSE NULL END AS selection_json,CASE WHEN length(CAST(outcome_json AS BLOB))<=262144 THEN outcome_json ELSE NULL END AS outcome_json,${withInterpretation?"CASE WHEN length(CAST(interpretation_json AS BLOB))<=32768 THEN interpretation_json ELSE NULL END AS interpretation_json,interpretation_json IS NOT NULL AS interpretation_present":"NULL AS interpretation_json,0 AS interpretation_present"},(selection_json IS NULL OR length(CAST(selection_json AS BLOB))<=?) AND (outcome_json IS NULL OR length(CAST(outcome_json AS BLOB))<=262144) AS bounded,CASE WHEN length(CAST(request_json AS BLOB))<=262144 THEN request_json ELSE NULL END AS original FROM mobile_context_control_operations WHERE principal_id=? AND operation_id=?`).get(c.family==='calendarControl'?262144:quota*256+2,c.family==='calendarControl'?262144:quota*256+2,c.principalId,c.operationId);
  if(!row||Number(row.bounded)!==1||row.request_digest!==c.requestDigest||typeof row.original!=='string')return false;if(c.family==='calendarControl'){const original=calendarControlRequest(JSON.parse(row.original));if(!original||original.target.principalId!==a.principalId||original.operationId!==c.operationId||calendarControlRequestDigest(original)!==c.requestDigest)return false;const projection=calendarControlProjection(original,row as unknown as Parameters<typeof calendarControlProjection>[1]);if(projection.phase==='reserved'?!!(c.preparedDigest||c.terminalDigest)||c.reservationDigest!==projection.digest:projection.phase==='prepared'?!!c.terminalDigest||c.preparedDigest!==projection.digest:c.terminalDigest!==projection.digest)return false;continue;}const original=mobileControlRequest(JSON.parse(row.original));if(!original||original.target.principalId!==a.principalId||original.operationId!==c.operationId||mobileControlRequestDigest(original)!==c.requestDigest)return false;
  const projection=mobileControlProjection(original,row as Parameters<typeof mobileControlProjection>[1],quota);if(projection.phase==='reserved'?!!(c.preparedDigest||c.terminalDigest)||c.reservationDigest!==undefined&&c.reservationDigest!==projection.digest:projection.phase==='prepared'?!!c.terminalDigest||c.preparedDigest!==projection.digest:c.terminalDigest!==projection.digest)return false;
 }return true;}catch{return false;}
}
/** Existing independent safety owner only; no policy, consent, retention or
 * classification defaults and no second journal/store. All selected hashes are
 * denied together before the caller may delete SQLite rows or issue a receipt.
 */
export function mobileSourceSafety(journal:RecoveryJournal,database:Database,maximumRecordsPerHuman:number):MobileSourceSafety{
 if(!Number.isSafeInteger(maximumRecordsPerHuman)||maximumRecordsPerHuman<1||maximumRecordsPerHuman>100000)throw Error('Explicit bounded mobile quota required');
 const withInterpretation=database.connection.prepare('PRAGMA table_info(mobile_context_control_operations)').all().some(row=>row.name==='interpretation_json');
 const current=(a:SourceActor)=>{try{return uuid(a.principalId)&&uuid(a.endpointId)&&a.current()===true&&journal.sourceCurrent();}catch{return false;}};

 const scope=(a:SourceActor,e:SourceEnrollmentScope):SourceRecoveryScope=>{if(!current(a)||e.principalId!==a.principalId||!uuid(e.sourceNamespace)||!['healthKit','healthConnect','eventKit','androidCalendar','googleTasks'].includes(e.collector))throw Error('Current bound mobile source safety scope required');return {principalId:a.principalId,collector:e.collector,sourceNamespace:e.sourceNamespace};};
 // The existing durable control row freezes the selected hashes before any
 // effect. Hold those records even when independent denial admission fails;
 // this hold is never counted as committed suppression or a removal receipt.
 const pending=(a:SourceActor,key:string)=>{
  // Bound each stored value before bringing it into JS; iterate rather than
  // materializing all pending selections. Corruption conservatively holds use.
  const rows=database.connection.prepare("SELECT operation_id,request_digest,selection_json IS NOT NULL AS selection_present,CASE WHEN length(CAST(request_json AS BLOB))<=262144 THEN request_json ELSE NULL END AS original,CASE WHEN length(CAST(selection_json AS BLOB))<=? THEN selection_json ELSE NULL END AS selection_json FROM mobile_context_control_operations WHERE principal_id=? AND state='pending' AND attempt_started=1").iterate(maximumRecordsPerHuman*256+2,a.principalId);
  for(const row of rows){try{
   if(typeof row.original!=='string')return true;const original=mobileControlRequest(JSON.parse(row.original));
   if(!original||original.operationId!==row.operation_id||original.target.principalId!==a.principalId||mobileControlRequestDigest(original)!==row.request_digest)return true;
   if(original.action.kind!=='remove'){if(Number(row.selection_present)!==0)return true;continue;}
   if(mobileControlSelection(row.selection_json as string|null,maximumRecordsPerHuman).some(item=>item.source_key===key||item.suppression_key===key))return true;
  }catch{return true;}}
  return false;
 };
 return Object.freeze({
  current,
  interpretationEvidence:(a:MobileAccess,e:MobileEnrollment)=>{try{
   if(!uuid(a.principalId)||!uuid(a.endpointId)||e.principalId!==a.principalId||!uuid(e.sourceNamespace)||!['healthKit','healthConnect','eventKit','androidCalendar','googleTasks'].includes(e.collector)||!controlOriginalsCurrent(journal,database,a,maximumRecordsPerHuman,withInterpretation))return null;const snapshot=journal.sourceSnapshot(),rows=database.connection.prepare("SELECT operation_id,request_digest,CASE WHEN length(CAST(selection_json AS BLOB))<=? THEN selection_json ELSE NULL END AS selection_json FROM mobile_context_control_operations WHERE principal_id=? AND state='pending' AND attempt_started=1 AND selection_json IS NOT NULL ORDER BY operation_id").iterate(maximumRecordsPerHuman*256+2,a.principalId),pending:Array<[string,string,string]>=[];
   for(const row of rows){if(typeof row.operation_id!=='string'||typeof row.request_digest!=='string'||typeof row.selection_json!=='string')return null;pending.push([row.operation_id,row.request_digest,row.selection_json]);if(pending.length>10000)return null;}
   const digest=mobileInterpretationDigest({intents:snapshot.intents.filter(i=>i.scope.principalId===a.principalId),pending});return journal.sourceCurrent()?{epoch:snapshot.epoch,digest}:null;
  }catch{return null;}},
  controlFamily:(a:MobileAccess,r:Parameters<NonNullable<MobileGovernance['controlFamily']>>[1])=>{
   if(!current(a)||r.target.principalId!==a.principalId)return null;
   const entry=journal.sourceSnapshot().controls?.find(c=>c.principalId===a.principalId&&c.operationId===r.operationId);
   if(!entry||entry.phaseVersion!=='1.0.0'||entry.family!=='ordinaryControl'||entry.requestDigest!==mobileControlRequestDigest(r)||!entry.reservationDigest)return null;
   const result={family:'ordinaryControl' as const,reservationDigest:entry.reservationDigest,...(entry.preparedDigest?{preparedDigest:entry.preparedDigest}:{}),...(entry.terminalDigest?{terminalDigest:entry.terminalDigest}:{})};
   // This captured operation check is deliberately pure: no caller-supplied
   // authority callback may run after the repository publication guard.
   const proofCurrent=()=>{try{if(!journal.sourceCurrent())return false;const now=journal.sourceSnapshot().controls?.find(c=>c.principalId===a.principalId&&c.operationId===r.operationId);return !!now&&now.phaseVersion==='1.0.0'&&now.family===result.family&&now.requestDigest===mobileControlRequestDigest(r)&&now.reservationDigest===result.reservationDigest&&now.preparedDigest===result.preparedDigest&&now.terminalDigest===result.terminalDigest;}catch{return false;}};
   return current(a)?{...result,current:proofCurrent}:null;
  },
  controlPhase:(a:MobileAccess,r:Parameters<NonNullable<MobileGovernance['controlPhase']>>[1],phase:Parameters<NonNullable<MobileGovernance['controlPhase']>>[2],digest:string,admit:boolean)=>{if(!current(a)||r.target.principalId!==a.principalId)throw Error('Current control owner required');return journal.sourceControlPhase({principalId:a.principalId,operationId:r.operationId,requestDigest:mobileControlRequestDigest(r)!},phase,digest,admit);},
  controlFence:(a:MobileAccess,r:Parameters<NonNullable<MobileGovernance['controlFence']>>[1],admit:boolean,reservationDigest?:string,family?:'ordinaryControl')=>{if(!current(a)||r.target.principalId!==a.principalId)throw Error('Current control owner required');return journal.sourceControl({principalId:a.principalId,operationId:r.operationId,requestDigest:mobileControlRequestDigest(r)!,...(reservationDigest?{reservationDigest}:{}),...(family?{family}:{})},admit);},
  // Keys already include principal+collector/namespace (source key) or stable
  // principal+collector/upstream identity (suppression key). Do not invent a
  // relationship scope or lose stable suppression when an enrollment changes.
  suppressed:(a:SourceActor,key:string)=>!current(a)||!controlOriginalsCurrent(journal,database,a,maximumRecordsPerHuman,withInterpretation)||!hash(key)||pending(a,key)||journal.sourceSnapshot().intents.some(i=>i.scope.principalId===a.principalId&&i.sourceKeys.includes(key)),
  suppressedBatch:(a:SourceActor,keys:readonly string[],e:SourceEnrollmentScope)=>{try{const selected=scope(a,e);if(!Array.isArray(keys)||keys.length>maximumRecordsPerHuman*2||!keys.every(hash))return false;const denied=new Set(journal.sourceSnapshot().intents.filter(i=>i.scope.principalId===selected.principalId&&i.scope.collector===selected.collector&&i.scope.sourceNamespace===selected.sourceNamespace).flatMap(i=>[...i.sourceKeys]));return keys.every(k=>denied.has(k))&&current(a);}catch{return false;}},
  remove:(a:SourceActor,keys:readonly string[],e:SourceEnrollmentScope,reason:'sourceRemoved'|'recordDeleted'|'retentionExpired'='sourceRemoved')=>{
   const selectedScope=scope(a,e);if(!['sourceRemoved','recordDeleted','retentionExpired'].includes(reason)||!Array.isArray(keys)||keys.length>maximumRecordsPerHuman*2||!keys.every(hash))throw Error('Bounded complete mobile source hash selection required');
   const denied=new Set(journal.sourceSnapshot().intents.filter(i=>i.scope.principalId===selectedScope.principalId&&i.scope.collector===selectedScope.collector&&i.scope.sourceNamespace===selectedScope.sourceNamespace).flatMap(i=>[...i.sourceKeys]));
   const missing=[...new Set(keys)].filter(k=>!denied.has(k)),intents:SourceRecoveryIntent[]=[];
   for(let offset=0;offset<missing.length;offset+=256)intents.push({operationId:randomUUID(),idempotencyKey:randomUUID(),scope:selectedScope,reason,sourceKeys:missing.slice(offset,offset+256),createdAt:new Date().toISOString()});
   if(intents.length)journal.admitSourceBatch(intents);
   const committed=new Set(journal.sourceSnapshot().intents.filter(i=>i.scope.principalId===selectedScope.principalId&&i.scope.collector===selectedScope.collector&&i.scope.sourceNamespace===selectedScope.sourceNamespace).flatMap(i=>[...i.sourceKeys]));
   if(!current(a)||keys.some(k=>!committed.has(k)))throw Error('Complete durable source suppression required before deletion');
  },
  removalEvidence:(a:SourceActor,e:SourceEnrollmentScope)=>{try{scope(a,e);return {epoch:journal.sourceSnapshot().epoch};}catch{return null;}}
 });
}

/** Compose policy mechanics without inventing a policy binding or consumer.
 * Only the synchronous answers consumer exists in this source. Other data-use
 * consumers remain unavailable until their actual owners are joined.
 */
export function mobileSourceGovernance(journal:RecoveryJournal,database:Database,maximumRecords:number,policy:MobileSourcePolicy|null):MobileGovernance{
 const safety=mobileSourceSafety(journal,database,maximumRecords),withInterpretation=database.connection.prepare('PRAGMA table_info(mobile_context_control_operations)').all().some(row=>row.name==='interpretation_json');
 return Object.freeze({...policy,...safety,retention:policy?policy.retention:()=>null,recordCurrent:policy?policy.recordCurrent:()=>false,current:policy?safety.current:()=>false,
  capturePolicy:(a:MobileAccess,e:MobileEnrollment)=>{
   if(!controlOriginalsCurrent(journal,database,a,maximumRecords,withInterpretation)||typeof policy?.capturePolicy!=='function')return null;
   const captured=policy.capturePolicy(a,e);if(!captured)return null;const descriptors=Object.getOwnPropertyDescriptors(captured),binding=descriptors.binding,current=descriptors.current;
   if(!binding||!('value'in binding)||!current||!('value'in current)||typeof current.value!=='function')return null;
   const ownerCurrent=current.value as MobilePolicyCapture['current'];
   return {binding:binding.value,current:(pin:Parameters<typeof ownerCurrent>[0])=>controlOriginalsCurrent(journal,database,a,maximumRecords,withInterpretation)&&ownerCurrent(pin)===true&&controlOriginalsCurrent(journal,database,a,maximumRecords,withInterpretation)};
  },
  allowed:(a:MobileAccess,e:MobileEnrollment,use:Parameters<MobileGovernance['allowed']>[2],assistant?:string)=>controlOriginalsCurrent(journal,database,a,maximumRecords,withInterpretation)&&(use==='collect'||use==='answers')&&policy?.allowed(a,e,use,assistant)===true&&controlOriginalsCurrent(journal,database,a,maximumRecords,withInterpretation),
  invalidate:(a:MobileAccess,enrollmentId:string,reason:Parameters<MobileGovernance['invalidate']>[2])=>{
   if(!safety.current(a)||!policy)throw Error('Current source owner required for invalidation');
   const row=database.connection.prepare('SELECT source_namespace,collector FROM mobile_context_enrollments WHERE principal_id=? AND enrollment_id=?').get(a.principalId,enrollmentId) as {source_namespace:string|null;collector:string}|undefined;
   if(!row)throw Error('Owned source invalidation scope unavailable');
   const ids=row.source_namespace?database.connection.prepare('SELECT enrollment_id FROM mobile_context_enrollments WHERE principal_id=? AND collector=? AND source_namespace=? ORDER BY enrollment_id').iterate(a.principalId,row.collector,row.source_namespace):[{enrollment_id:enrollmentId}];
   let count=0;for(const entry of ids){if(!safety.current(a))throw Error('Source invalidation currency changed');policy.invalidate(a,String(entry.enrollment_id),reason);count++;}if(!count)throw Error('Owned source invalidation scope unavailable');if(!safety.current(a))throw Error('Source invalidation currency changed');
  }
 });
}

/** Separate B authority, same independent deny owner. Missing issuer always denies;
 * this packet has no B retrieval/derived consumer and cannot borrow Health grants. */
export function mobileCalendarSourceGovernance(journal:RecoveryJournal,database:Database,maximumRecords:number,policy:CalendarSourcePolicy|null):CalendarGovernance{
 const safety=mobileSourceSafety(journal,database,maximumRecords),withInterpretation=database.connection.prepare('PRAGMA table_info(mobile_context_control_operations)').all().some(row=>row.name==='interpretation_json'),current=(a:CalendarAccess)=>safety.current(a)&&controlOriginalsCurrent(journal,database,a,maximumRecords,withInterpretation);
 const originalCurrent=journal.sourceCurrent.bind(journal),originalSnapshot=journal.sourceSnapshot.bind(journal);
 return Object.freeze({current:(a:CalendarAccess)=>safety.current(a),suppressed:safety.suppressed,remove:safety.remove,
  controlFence:(a,r,admit,reservationDigest)=>{if(!safety.current(a))throw Error('calendar_control_unavailable');return journal.sourceControl({principalId:a.principalId,operationId:r.operationId,requestDigest:calendarControlRequestDigest(r)!,family:'calendarControl',reservationDigest},admit);},
  controlPhase:(a,r,phase,digest,admit)=>{if(!safety.current(a))throw Error('calendar_control_unavailable');return journal.sourceControlPhase({principalId:a.principalId,operationId:r.operationId,requestDigest:calendarControlRequestDigest(r)!},phase,digest,admit);},
  controlFamily:(a,r)=>{if(!current(a))return null;const c=journal.sourceSnapshot().controls?.find(c=>c.principalId===a.principalId&&c.operationId===r.operationId);if(!c||c.family!=='calendarControl'||c.requestDigest!==calendarControlRequestDigest(r)||c.reservationDigest!==calendarControlReservationDigest(r))return null;const before=JSON.stringify(c);return {family:'calendarControl' as const,reservationDigest:c.reservationDigest!,...(c.preparedDigest?{preparedDigest:c.preparedDigest}:{}),...(c.terminalDigest?{terminalDigest:c.terminalDigest}:{}),current:()=>current(a)&&JSON.stringify(journal.sourceSnapshot().controls?.find(x=>x.principalId===a.principalId&&x.operationId===r.operationId))===before};},
  captureSyncScope:(a,e,settings,run,selection)=>{try{
   if(!current(a)||!policy?.captureSyncScope)return null;const captured=policy.captureSyncScope(a,e,settings,run,selection);
   if(!captured||types.isProxy(captured))return null;const fields=Object.getOwnPropertyDescriptors(captured);
   if(['binding','current','recordAllowed'].some(k=>!fields[k]||!Object.hasOwn(fields[k]!,'value'))||typeof fields.current!.value!=='function'||typeof fields.recordAllowed!.value!=='function')return null;
   const binding=unifiedDesktopSnapshot(fields.binding!.value,8192) as NonNullable<ReturnType<NonNullable<CalendarGovernance['captureSyncScope']>>>['binding']|undefined;if(!binding)return null;
   const stamp=calendarSettingsCanonical(binding);let revoked=false;
   const original=()=>{if(revoked)return false;const now=Object.getOwnPropertyDescriptors(captured);revoked=['binding','current','recordAllowed'].some(k=>!now[k]||!Object.hasOwn(now[k]!,'value')||['value','enumerable','configurable','writable'].some(key=>(now[k] as any)[key]!==(fields[k] as any)[key]))||calendarSettingsCanonical(unifiedDesktopSnapshot(fields.binding!.value,8192))!==stamp;return !revoked;};
   const scopeCurrent=()=>{try{return current(a)&&original()&&fields.current!.value!.call(captured)===true&&original()&&current(a);}catch{return false;}};
   return scopeCurrent()?{binding,current:scopeCurrent,recordAllowed:item=>{try{return scopeCurrent()&&fields.recordAllowed!.value!.call(captured,item)===true&&scopeCurrent();}catch{return false;}}}:null;
  }catch{return null;}},
  captureReadFence:(a:CalendarAccess)=>{try{if(!current(a))return null;const consent=policy?.captureConsentReadFence?.(a);if(policy?.captureConsentReadFence&&!consent)return null;const snapshot=JSON.stringify(originalSnapshot()),stamp=()=>JSON.stringify([database.connection.prepare('PRAGMA data_version').get(),database.connection.prepare('SELECT total_changes() AS changes').get()]),before=stamp(),view={sourceSnapshot:originalSnapshot}as unknown as RecoveryJournal;return {current:()=>{try{return (!consent||consent.current())&&originalCurrent()&&JSON.stringify(originalSnapshot())===snapshot&&controlOriginalsCurrent(view,database,a,maximumRecords,withInterpretation)&&stamp()===before;}catch{return false;}}};}catch{return null;}},
  recordCurrent:(a:CalendarAccess,e:CalendarEnrollment,key:string,ref:string,use:'answers',assistant:string)=>current(a)&&policy?.recordCurrent?.(a,e,key,ref,use,assistant)===true&&current(a),
  capturePolicy:(a:CalendarAccess,e:CalendarEnrollment)=>{if(!current(a)||!policy)return null;const capture=policy.capturePolicy(a,e);if(!capture)return null;const d=Object.getOwnPropertyDescriptors(capture);if(!d.binding||!('value'in d.binding)||!d.current||!('value'in d.current)||typeof d.current.value!=='function')return null;const ownerCurrent=d.current.value as NonNullable<ReturnType<CalendarSourcePolicy['capturePolicy']>>['current'];return{binding:d.binding.value,current:(pin:Parameters<typeof ownerCurrent>[0])=>current(a)&&ownerCurrent(pin)===true&&current(a)};},
  allowed:(a:CalendarAccess,e:CalendarEnrollment,use:Parameters<CalendarGovernance['allowed']>[2],assistant?:string)=>(use==='collect'||use==='answers'&&typeof policy?.recordCurrent==='function')&&current(a)&&policy?.allowed(a,e,use,assistant)===true&&current(a),
  retention:(a:CalendarAccess,e:CalendarEnrollment,c:Parameters<CalendarGovernance['retention']>[2],context)=>current(a)&&policy?policy.retention(a,e,c,context):null,
  ...(policy?.acceptedRecord?{acceptedRecord:(a:CalendarAccess,e:CalendarEnrollment,context:{sourceKey:string;suppressionKey:string;receivedAt:string;existing:boolean})=>{if(!current(a))throw Error('calendar_import_owner_unavailable');policy.acceptedRecord!(a,e,context);if(!current(a))throw Error('calendar_import_owner_changed');}}:{}),
  invalidate:(a:CalendarAccess,id:string,reason:Parameters<CalendarGovernance['invalidate']>[2])=>{if(!safety.current(a))throw Error('calendar_source_currency_unavailable');policy?.invalidate(a,id,reason);if(!safety.current(a))throw Error('calendar_source_currency_changed');}
 });
}
