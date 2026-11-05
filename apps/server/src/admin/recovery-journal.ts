import {invalidateCanonicalPresenceConfiguration} from '../runtime/canonical-presence-owners.ts';
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,writeFileSync,statSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import type {Database} from '@lifestream/storage-sqlite';
export const privacyActions=['stop-collection','revoke-processing','stop-personalization','prohibit-training','delete-source','forget-derived-information'] as const;
export type PrivacyAction=typeof privacyActions[number];
export type HypothesisRejection={deploymentId:string;hypothesisId:string;fingerprint:string;expectedRevision:number};
export type CandidateSuppression={deploymentId:string;candidateId:string;fingerprint:string;expectedRevision:number};
export type RecoveryIntent={operationId:string;idempotencyKey:string;requestDigest:string;rootRecordIds:string[];rootMemoryIds:string[];rootProfileIds:string[];actor:string;assistantId:string;relationshipId:string;action:PrivacyAction;recordIds:string[];memoryIds:string[];profileIds:string[];sourceDigests:string[];contentDigests:string[];createdAt:string;hypothesisRejection?:HypothesisRejection;candidateSuppression?:CandidateSuppression};
const validHypothesisIntent=(intent:RecoveryIntent):boolean=>{
 if(intent.candidateSuppression!==undefined){const candidate=intent.candidateSuppression;if(intent.hypothesisRejection!==undefined||!candidate||Object.keys(candidate).sort().join(',')!=='candidateId,deploymentId,expectedRevision,fingerprint')return false;const {candidateSuppression:_candidate,...rest}=intent;return validHypothesisIntent({...rest,hypothesisRejection:{deploymentId:candidate.deploymentId,hypothesisId:candidate.candidateId,fingerprint:candidate.fingerprint,expectedRevision:candidate.expectedRevision}});}
 const target=intent.hypothesisRejection;if(target===undefined)return true;
 return !!target&&Object.keys(target).sort().join(',')==='deploymentId,expectedRevision,fingerprint,hypothesisId'&&intent.action==='revoke-processing'&&[target.deploymentId,target.hypothesisId].every(id=>typeof id==='string'&&/^[a-f0-9-]{36}$/iu.test(id))&&/^[a-f0-9]{64}$/u.test(target.fingerprint)&&Number.isInteger(target.expectedRevision)&&target.expectedRevision>0&&target.expectedRevision<2147483647&&[intent.rootRecordIds,intent.rootMemoryIds,intent.rootProfileIds,intent.recordIds,intent.memoryIds,intent.profileIds,intent.sourceDigests,intent.contentDigests].every(ids=>Array.isArray(ids)&&ids.length===0);
};
export const recoveryDigest=(s:string)=>createHash('sha256').update(s.trim().replace(/\s+/gu,' ')).digest('hex');
export type SourceRecoveryScope=Readonly<{principalId:string;collector:'healthKit'|'healthConnect'|'eventKit'|'androidCalendar'|'googleTasks';sourceNamespace:string}>;
export type SourceRecoveryIntent=Readonly<{operationId:string;idempotencyKey:string;scope:SourceRecoveryScope;reason:'sourceRemoved'|'recordDeleted'|'retentionExpired';sourceKeys:readonly string[];createdAt:string}>;
export type SourceControlFence=Readonly<{principalId:string;operationId:string;requestDigest:string;phaseVersion?:'1.0.0';family?:'ordinaryControl'|'calendarControl';reservationDigest?:string;preparedDigest?:string;terminalDigest?:string}>;
export type SourcePolicyFence=Readonly<{family:'healthPolicy'|'calendarPolicy'|'calendarSourceConsent'|'healthSourceConsent';principalId:string;operationId:string;requestDigest:string;reservationDigest:string;preparedDigest?:string;terminalDigest?:string}>;
export type SourceImportPin=Readonly<{principalId:string;sourceKey:string;firstImportDigest:string}>;
const validImportPin=(p:SourceImportPin)=>!!p&&Object.keys(p).sort().join(',')==='firstImportDigest,principalId,sourceKey'&&sourceUuid(p.principalId)&&sourceHash(p.sourceKey)&&sourceHash(p.firstImportDigest);
type SourceSafety={schemaVersion:'1.0.0'|'2.0.0';epoch:number;intents:SourceRecoveryIntent[];controls?:SourceControlFence[];policyOperations?:SourcePolicyFence[];acceptedImports?:SourceImportPin[]};
function validPolicyFence(c:SourcePolicyFence):boolean{return !!c&&Object.keys(c).every(k=>['family','principalId','operationId','requestDigest','reservationDigest','preparedDigest','terminalDigest'].includes(k))&&['healthPolicy','calendarPolicy','calendarSourceConsent','healthSourceConsent'].includes(c.family)&&sourceUuid(c.principalId)&&sourceUuid(c.operationId)&&sourceHash(c.requestDigest)&&sourceHash(c.reservationDigest)&&(c.preparedDigest===undefined||sourceHash(c.preparedDigest))&&(c.terminalDigest===undefined||sourceHash(c.terminalDigest))&&(!c.terminalDigest||!!c.preparedDigest);}
const sourceHash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function validSourceControl(c:SourceControlFence):boolean{return !!c&&Object.keys(c).every(k=>['operationId','principalId','requestDigest','phaseVersion','family','reservationDigest','preparedDigest','terminalDigest'].includes(k))&&sourceUuid(c.principalId)&&sourceUuid(c.operationId)&&sourceHash(c.requestDigest)&&(c.phaseVersion===undefined||c.phaseVersion==='1.0.0')&&(c.family===undefined||['ordinaryControl','calendarControl'].includes(c.family!)&&sourceHash(c.reservationDigest))&&(c.reservationDigest===undefined||sourceHash(c.reservationDigest))&&(c.preparedDigest===undefined||sourceHash(c.preparedDigest))&&(c.terminalDigest===undefined||sourceHash(c.terminalDigest));}
const controlEpoch=(controls:readonly SourceControlFence[]|undefined)=>Array.isArray(controls)?controls.reduce((n,c)=>n+1+(c?.preparedDigest?1:0)+(c?.terminalDigest?1:0),0):0;

const policyEpoch=(entries:readonly SourcePolicyFence[]|undefined)=>Array.isArray(entries)?entries.reduce((n,c)=>n+1+(c.preparedDigest?1:0)+(c.terminalDigest?1:0),0):0;

type Journal={schemaVersion:'1.0.0';epoch:number;intents:RecoveryIntent[];sourceSafety?:SourceSafety};
const sourceUuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const exactKeys=(v:object,keys:string)=>Object.keys(v).sort().join(',')===keys;
function validSourceIntent(i:SourceRecoveryIntent):boolean{
 return !!i&&exactKeys(i,'createdAt,idempotencyKey,operationId,reason,scope,sourceKeys')&&sourceUuid(i.operationId)&&sourceUuid(i.idempotencyKey)&&!!i.scope&&exactKeys(i.scope,'collector,principalId,sourceNamespace')&&sourceUuid(i.scope.principalId)&&sourceUuid(i.scope.sourceNamespace)&&['healthKit','healthConnect','eventKit','androidCalendar','googleTasks'].includes(i.scope.collector)&&['sourceRemoved','recordDeleted','retentionExpired'].includes(i.reason)&&typeof i.createdAt==='string'&&Number.isFinite(Date.parse(i.createdAt))&&Array.isArray(i.sourceKeys)&&i.sourceKeys.length>0&&i.sourceKeys.length<=256&&new Set(i.sourceKeys).size===i.sourceKeys.length&&i.sourceKeys.every(k=>typeof k==='string'&&/^[a-f0-9]{64}$/.test(k));
}
function validSourceSafety(s:SourceSafety):boolean{
 if(!s||!Number.isSafeInteger(s.epoch)||s.epoch<0||!Array.isArray(s.intents)||s.epoch>10000||s.intents.some(i=>!validSourceIntent(i))||s.controls!==undefined&&(!Array.isArray(s.controls)||s.controls.some(c=>!validSourceControl(c))))return false;
 const legacy=s.schemaVersion==='1.0.0'&&(exactKeys(s,'epoch,intents,schemaVersion')||exactKeys(s,'controls,epoch,intents,schemaVersion'));
 const modern=s.schemaVersion==='2.0.0'&&(exactKeys(s,'epoch,intents,policyOperations,schemaVersion')||exactKeys(s,'controls,epoch,intents,policyOperations,schemaVersion')||exactKeys(s,'acceptedImports,epoch,intents,policyOperations,schemaVersion')||exactKeys(s,'acceptedImports,controls,epoch,intents,policyOperations,schemaVersion'))&&Array.isArray(s.policyOperations)&&s.policyOperations.length>0&&s.policyOperations.every(validPolicyFence)&&(s.acceptedImports===undefined||Array.isArray(s.acceptedImports)&&s.acceptedImports.length>0&&s.acceptedImports.every(validImportPin)&&new Set(s.acceptedImports.map(p=>p.principalId+':'+p.sourceKey)).size===s.acceptedImports.length);
 if(!legacy&&!modern||s.epoch!==s.intents.length+controlEpoch(s.controls)+policyEpoch(s.policyOperations)+(s.acceptedImports?.length??0))return false;
 const policyKeys=new Set<string>();for(const c of s.policyOperations??[]){const key=c.principalId+':'+c.operationId;if(policyKeys.has(key)||s.controls?.some(x=>x.principalId===c.principalId&&x.operationId===c.operationId)||s.intents.some(x=>x.operationId===c.operationId))return false;policyKeys.add(key);}
 const keys=new Set<string>(),operations=new Set<string>();for(const i of s.intents){const key=i.scope.principalId+':'+i.idempotencyKey;if(keys.has(key)||operations.has(i.operationId))return false;keys.add(key);operations.add(i.operationId);}const controls=new Set<string>();for(const c of s.controls??[]){const key=c.principalId+':'+c.operationId;if(controls.has(key))return false;controls.add(key);}return true;
}
/** Payload-free owner-local safety state outside database backups. No worker can grant use. */
export class RecoveryJournal {
 private readonly db:Database;private state:Journal={schemaVersion:'1.0.0',epoch:0,intents:[]};private directory:string|undefined;private publicationUncertain=false;readonly currency:'current'|'unknown';private sourceReady=false;
 constructor(db:Database,directory?:string){this.db=db;this.directory=directory;db.exec('CREATE TABLE IF NOT EXISTS relationship_recovery_currency (singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL)');const marker=db.connection.prepare('SELECT epoch FROM relationship_recovery_currency WHERE singleton=1').get() as {epoch:number}|undefined;
  if(!directory){this.currency='current';db.connection.prepare('INSERT OR IGNORE INTO relationship_recovery_currency VALUES (1,0)').run();return;}
  mkdirSync(directory,{recursive:true,mode:0o700});const path=join(directory,'journal.json');let current=true;
  if(existsSync(path)){try{if(statSync(path).size>8388608)throw new Error('Safety journal capacity exceeded');const value=JSON.parse(readFileSync(path,'utf8')) as Journal;if(value.schemaVersion!=='1.0.0'||!Number.isSafeInteger(value.epoch)||value.epoch<0||!Array.isArray(value.intents)||value.intents.length!==value.epoch||value.intents.length>10000||value.intents.some(i=>!validHypothesisIntent(i)||!privacyActions.includes(i.action)||[i.operationId,i.idempotencyKey,i.actor,i.assistantId,i.relationshipId,i.createdAt,i.requestDigest].some(v=>typeof v!=='string'||!v||v.length>256)||[i.recordIds,i.memoryIds,i.profileIds,i.rootRecordIds,i.rootMemoryIds,i.rootProfileIds,i.sourceDigests,i.contentDigests].some(a=>!Array.isArray(a)||a.length>8192||a.some(v=>typeof v!=='string'||v.length>256))))throw new Error('Invalid safety journal');this.state=value;if(marker&&marker.epoch>value.epoch)current=false;}catch{current=false;}}
  else if(marker||Number((db.connection.prepare('SELECT ((SELECT COUNT(*) FROM assistant_relationships)+(SELECT COUNT(*) FROM memories)+(SELECT COUNT(*) FROM user_profile_revisions)) AS n').get() as {n:number}).n)>0)current=false;
  else this.write(this.state);
  this.currency=current?'current':'unknown';if(current)db.connection.prepare('INSERT OR IGNORE INTO relationship_recovery_currency VALUES (1,0)').run();
 }
 private write(state:Journal){const payload=JSON.stringify(state);if(Buffer.byteLength(payload)>8388608)throw new Error('Safety journal capacity exceeded; retain current tombstones');if(!this.directory){invalidateCanonicalPresenceConfiguration(this.db);return;}const temporary=join(this.directory,`pending-${randomUUID()}`);invalidateCanonicalPresenceConfiguration(this.db);const fd=openSync(temporary,'wx',0o600);try{writeFileSync(fd,payload);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,join(this.directory,'journal.json'));this.state=state;this.publicationUncertain=true;const directory=openSync(this.directory,'r');try{fsyncSync(directory);this.publicationUncertain=false;}finally{closeSync(directory);}}
 // Retain a visible rename even when its directory flush failed, but do not
 // report source commit/currentness until this same owner confirms durability.
 private confirmPublication(force=false):void{
  if(!force&&!this.publicationUncertain)return;
  this.publicationUncertain=true;
  if(!this.directory||!this.sourceDiskCurrent())throw Error('Published source safety state changed before durability confirmation');
  const directory=openSync(this.directory,'r');try{fsyncSync(directory);this.publicationUncertain=false;}finally{closeSync(directory);}
 }
 /** Current independent owner state; a missing/replaced or uncertain file is not authority. */
 current():boolean{return this.currency==='current'&&!this.publicationUncertain&&(!this.directory||this.sourceDiskCurrent());}
 get revision():number{return this.state.epoch;}
 /** Explicit host opt-in to the same independent journal. This enables denial
  * evidence only: it supplies no collection, retention, interpretation or use grant.
  * Source failure does not change legacy relationship currency or ordinary chat. */
 enableSources(initialization:'requireExisting'|'initializeEmpty'):boolean{
  this.sourceReady=false;
  try{
   if(this.currency!=='current'||!this.directory||!this.sourceDiskCurrent()||!['requireExisting','initializeEmpty'].includes(initialization))return false;
   // Projection metadata in the existing database, never another policy/journal
   // store. Keep the legacy two-column marker layout compatible with rollback.
   this.db.exec('CREATE TABLE IF NOT EXISTS recovery_source_projection (singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL CHECK(epoch>=0))');
   this.db.connection.prepare('INSERT OR IGNORE INTO recovery_source_projection VALUES(1,0)').run();
   const marker=this.db.connection.prepare('SELECT epoch AS source_epoch FROM recovery_source_projection WHERE singleton=1').get() as {source_epoch:number};
   if(!Number.isSafeInteger(marker.source_epoch)||marker.source_epoch<0)return false;
   if(this.state.sourceSafety===undefined){
    if(initialization!=='initializeEmpty'||marker.source_epoch!==0)return false;
    for(const name of ['mobile_context_sources','mobile_context_enrollments','mobile_context_records','mobile_context_deliveries'])if(this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)&&Number(this.db.connection.prepare(`SELECT count(*) AS n FROM ${name}`).get()!.n)>0)return false;
    const next={...this.state,sourceSafety:{schemaVersion:'1.0.0' as const,epoch:0,intents:[]}};this.write(next);this.state=next;
   }
   const safety=this.state.sourceSafety;if(!safety||!validSourceSafety(safety)||marker.source_epoch>safety.epoch)return false;
   try{this.confirmPublication(true);}catch{return false;}
   this.sourceReady=true;if(!this.sourceCurrent()){this.sourceReady=false;return false;}
   this.db.durableTransaction(()=>this.db.connection.prepare('UPDATE recovery_source_projection SET epoch=? WHERE singleton=1').run(safety.epoch));
   return true;
  }catch{this.sourceReady=false;return false;}
 }
 private sourceDiskCurrent():boolean{
  if(!this.directory)return false;
  try{const path=join(this.directory,'journal.json'),stat=lstatSync(path);return stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=8388608&&JSON.stringify(JSON.parse(readFileSync(path,'utf8')))===JSON.stringify(this.state);}catch{return false;}
 }
 sourceCurrent():boolean{
  if(this.publicationUncertain||!this.sourceReady||!this.directory||this.currency!=='current'||!this.state.sourceSafety||!validSourceSafety(this.state.sourceSafety))return false;
  try{const marker=this.db.connection.prepare('SELECT epoch AS source_epoch FROM recovery_source_projection WHERE singleton=1').get() as {source_epoch:number};return Number.isSafeInteger(marker.source_epoch)&&marker.source_epoch>=0&&this.sourceDiskCurrent()&&marker.source_epoch<=this.state.sourceSafety.epoch;}catch{return false;}
 }
 sourceSnapshot():SourceSafety{if(!this.sourceCurrent())throw Error('Source safety currency unavailable');return structuredClone(this.state.sourceSafety!);}
 sourceForbidden(scope:SourceRecoveryScope,key:string):boolean{
  if(!sourceUuid(scope.principalId)||!sourceUuid(scope.sourceNamespace)||!['healthKit','healthConnect'].includes(scope.collector)||!/^[a-f0-9]{64}$/.test(key)||!this.sourceCurrent())return true;
  return this.state.sourceSafety!.intents.some(i=>i.scope.principalId===scope.principalId&&i.scope.collector===scope.collector&&i.scope.sourceNamespace===scope.sourceNamespace&&i.sourceKeys.includes(key));
 }
 /** Deny-only admission memory outside SQL backups. A matching entry without
  * its SQL original remains uncertain; it is never a result receipt or retry grant. */
 sourceControl(fence:SourceControlFence,admit=false):'absent'|'created'|'matching'|'conflict'{
  if(!validSourceControl(fence)||!(exactKeys(fence,'operationId,principalId,requestDigest')||exactKeys(fence,'operationId,principalId,requestDigest,reservationDigest')||exactKeys(fence,'family,operationId,principalId,requestDigest,reservationDigest')))throw Error('Valid source control identity required');
  if(admit)this.confirmPublication();if(!this.sourceCurrent())throw Error('Source control currency unavailable');
  const safety=this.state.sourceSafety!;if(safety.policyOperations?.some(c=>c.principalId===fence.principalId&&c.operationId===fence.operationId))return 'conflict';const prior=safety.controls?.find(c=>c.principalId===fence.principalId&&c.operationId===fence.operationId);
  if(prior){if(prior.requestDigest!==fence.requestDigest||fence.family!==undefined&&prior.family!==fence.family||admit&&prior.family!==fence.family||fence.reservationDigest!==undefined&&prior.reservationDigest!==fence.reservationDigest||admit&&prior.reservationDigest!==fence.reservationDigest)return 'conflict';return 'matching';}if(!admit)return 'absent';
  if(this.state.intents.length+safety.epoch>=10000)throw Error('Source safety capacity reached');
  const next={...this.state,sourceSafety:{...safety,epoch:safety.epoch+1,controls:[...(safety.controls??[]),{...structuredClone(fence),phaseVersion:'1.0.0' as const}]}};
  this.write(next);this.db.connection.prepare('UPDATE recovery_source_projection SET epoch=? WHERE singleton=1').run(next.sourceSafety.epoch);return 'created';
 }
 /** Hash-only monotonic phase evidence. It can hold a restored SQL projection,
  * never reconstruct a missing selection/receipt or authorize another dispatch. */
 sourceControlPhase(fence:SourceControlFence,phase:'reserved'|'prepared'|'terminal',digest:string,admit=false):'absent'|'matching'|'created'|'conflict'|'ahead'{
  if(!validSourceControl(fence)||!exactKeys(fence,'operationId,principalId,requestDigest')||!['reserved','prepared','terminal'].includes(phase)||!sourceHash(digest)||admit&&phase==='reserved')throw Error('Valid control phase evidence required');
  if(admit)this.confirmPublication();if(!this.sourceCurrent())throw Error('Source control phase currency unavailable');
  const safety=this.state.sourceSafety!,index=safety.controls?.findIndex(c=>c.principalId===fence.principalId&&c.operationId===fence.operationId)??-1,prior=safety.controls?.[index];
  if(!prior)return 'absent';if(prior.requestDigest!==fence.requestDigest)return 'conflict';if(prior.phaseVersion!=='1.0.0')return 'absent';
  if(phase==='reserved')return prior.preparedDigest||prior.terminalDigest?'ahead':prior.reservationDigest!==undefined&&prior.reservationDigest!==digest?'conflict':'matching';
  if(phase==='prepared'&&prior.terminalDigest)return 'ahead';
  const field=phase==='prepared'?'preparedDigest':'terminalDigest',existing=prior[field];if(existing)return existing===digest?'matching':'conflict';if(!admit)return 'absent';
  if(this.state.intents.length+safety.epoch>=10000)throw Error('Source safety capacity reached');
  const controls=[...safety.controls!];controls[index]={...prior,[field]:digest};const next={...this.state,sourceSafety:{...safety,epoch:safety.epoch+1,controls}};
  this.write(next);this.db.connection.prepare('UPDATE recovery_source_projection SET epoch=? WHERE singleton=1').run(next.sourceSafety.epoch);return 'created';
 }
 /** Same independent denial document; policy entries are never generic controls. */
 sourcePolicy(fence:SourcePolicyFence,phase:'reserved'|'prepared'|'terminal',digest:string,admit=false):'absent'|'created'|'matching'|'conflict'|'ahead'{
  if(!validPolicyFence(fence)||fence.preparedDigest||fence.terminalDigest||!sourceHash(digest)||!['reserved','prepared','terminal'].includes(phase)||phase==='reserved'&&digest!==fence.reservationDigest)throw Error('Invalid policy phase');
  if(admit)this.confirmPublication();if(!this.sourceCurrent())throw Error('Policy source currency unavailable');
  const safety=this.state.sourceSafety!;if(safety.controls?.some(c=>c.principalId===fence.principalId&&c.operationId===fence.operationId)||safety.intents.some(i=>i.operationId===fence.operationId))return 'conflict';
  const entries=[...(safety.policyOperations??[])],index=entries.findIndex(c=>c.principalId===fence.principalId&&c.operationId===fence.operationId),prior=entries[index];
  if(prior&&(prior.family!==fence.family||prior.requestDigest!==fence.requestDigest||prior.reservationDigest!==fence.reservationDigest))return 'conflict';
  if(!prior){if(phase!=='reserved'||!admit)return 'absent';entries.push(structuredClone(fence));}
  else {if(phase==='reserved')return prior.preparedDigest||prior.terminalDigest?'ahead':'matching';if(phase==='prepared'&&prior.terminalDigest)return 'ahead';const key=phase==='prepared'?'preparedDigest':'terminalDigest';if(prior[key])return prior[key]===digest?'matching':'conflict';if(!admit)return 'absent';if(phase==='terminal'&&!prior.preparedDigest)return 'conflict';entries[index]={...prior,[key]:digest};}
  if(this.state.intents.length+safety.epoch>=10000)throw Error('Source safety capacity reached');
  const next:Journal={...this.state,sourceSafety:{...safety,schemaVersion:'2.0.0',epoch:safety.epoch+1,policyOperations:entries}};
  if(!validSourceSafety(next.sourceSafety!))throw Error('Invalid policy source projection');this.write(next);this.db.connection.prepare('UPDATE recovery_source_projection SET epoch=? WHERE singleton=1').run(next.sourceSafety!.epoch);return 'created';
 }
 /** Accepted identity memory only. Never a reconstructable timestamp or grant. */
 sourceImport(pin:SourceImportPin,admit=false):'absent'|'created'|'matching'|'conflict'{
  if(!validImportPin(pin))throw Error('Invalid accepted import pin');if(admit)this.confirmPublication();if(!this.sourceCurrent())throw Error('Import source currency unavailable');const safety=this.state.sourceSafety!,prior=safety.acceptedImports?.find(p=>p.principalId===pin.principalId&&p.sourceKey===pin.sourceKey);if(prior)return prior.firstImportDigest===pin.firstImportDigest?'matching':'conflict';if(!admit)return 'absent';if(safety.schemaVersion!=='2.0.0'||!safety.policyOperations?.length)throw Error('Explicit policy history required for import pin');if(this.state.intents.length+safety.epoch>=10000)throw Error('Source safety capacity reached');const next:Journal={...this.state,sourceSafety:{...safety,epoch:safety.epoch+1,acceptedImports:[...(safety.acceptedImports??[]),structuredClone(pin)]}};if(!validSourceSafety(next.sourceSafety!))throw Error('Invalid import source projection');this.write(next);this.db.connection.prepare('UPDATE recovery_source_projection SET epoch=? WHERE singleton=1').run(next.sourceSafety!.epoch);return 'created';
 }
 admitSource(intent:SourceRecoveryIntent):SourceRecoveryIntent{return this.admitSourceBatch([intent])[0]!;}
 /** Admit a complete bounded denial selection to this same independent journal.
  * Validate all chunks/capacity before a single file commit; no partial prefix
  * is published if another chunk conflicts or the existing byte limit is full.
  */
 admitSourceBatch(intents:readonly SourceRecoveryIntent[]):SourceRecoveryIntent[]{
  if(!Array.isArray(intents)||!intents.length||intents.length>10000)throw Error('Current bounded source safety batch required');
  this.confirmPublication();if(!this.sourceCurrent())throw Error('Current bounded source safety batch required');
  const current=this.state.sourceSafety!,retained=[...current.intents],byKey=new Map(retained.map(i=>[i.scope.principalId+':'+i.idempotencyKey,i])),operations=new Set(retained.map(i=>i.operationId)),result:SourceRecoveryIntent[]=[];
  const body=(i:SourceRecoveryIntent)=>JSON.stringify([i.scope.principalId,i.scope.collector,i.scope.sourceNamespace,i.reason,[...i.sourceKeys].sort()]);
  for(const input of intents){
   if(!validSourceIntent(input))throw Error('Current valid source safety evidence required');const intent=structuredClone(input),key=intent.scope.principalId+':'+intent.idempotencyKey,prior=byKey.get(key);
   if(prior){if(body(prior)!==body(intent))throw Error('Source privacy idempotency conflict');result.push(prior);continue;}
   if(retained.length+controlEpoch(current.controls)+policyEpoch(current.policyOperations)+(current.acceptedImports?.length??0)+this.state.intents.length>=10000||operations.has(intent.operationId)||current.policyOperations?.some(c=>c.operationId===intent.operationId))throw Error('Source safety capacity or operation conflict');
   retained.push(intent);byKey.set(key,intent);operations.add(intent.operationId);result.push(intent);
  }
  if(retained.length===current.intents.length)return structuredClone(result);
  const sourceSafety={...current,epoch:retained.length+controlEpoch(current.controls)+policyEpoch(current.policyOperations)+(current.acceptedImports?.length??0),intents:retained},next={...this.state,sourceSafety};
  if(!this.sourceCurrent())throw Error('Source safety currency changed before batch commit');
  this.write(next);this.state=next;
  // Independent fsynced denial precedes SQL. Outer SQL rollback cannot erase it.
  this.db.connection.prepare('UPDATE recovery_source_projection SET epoch=? WHERE singleton=1').run(sourceSafety.epoch);
  return structuredClone(result);
 }

 snapshot():Journal{return structuredClone(this.state);}
 admit(intent:RecoveryIntent):RecoveryIntent{if(!validHypothesisIntent(intent))throw new Error('Invalid hypothesis rejection scope');if(this.currency!=='current')throw new Error('Recovery currency unknown; affected stored state requires current safety evidence');const prior=this.state.intents.find(i=>i.idempotencyKey===intent.idempotencyKey);if(prior){if(JSON.stringify({...prior,operationId:'',createdAt:''})!==JSON.stringify({...intent,operationId:'',createdAt:''}))throw new Error('Privacy idempotency conflict');return structuredClone(prior);}if(this.state.intents.length+(this.state.sourceSafety&&validSourceSafety(this.state.sourceSafety)?this.state.sourceSafety.epoch:0)>=10000)throw new Error('Safety journal capacity reached; retain current tombstones and review storage');const state={...this.state,epoch:this.state.epoch+1,intents:[...this.state.intents,structuredClone(intent)]};this.write(state);invalidateCanonicalPresenceConfiguration(this.db);this.state=state;return structuredClone(intent);}
 known(key:string,actor:string,relationshipId:string):RecoveryIntent|undefined{return this.state.intents.find(i=>i.idempotencyKey===key&&i.actor===actor&&i.relationshipId===relationshipId);}
 forbidden(actor:string,relationshipId:string,value:string,sourceDigest?:string):boolean{const digest=recoveryDigest(value);return this.currency!=='current'||this.state.intents.some(i=>i.actor===actor&&i.relationshipId===relationshipId&&['delete-source','forget-derived-information','revoke-processing'].includes(i.action)&&(i.contentDigests.includes(digest)||!!sourceDigest&&i.sourceDigests.includes(sourceDigest)));}
}
