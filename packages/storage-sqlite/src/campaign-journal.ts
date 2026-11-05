import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {boundedGameDataSnapshot,campaignJournalSnapshot} from '@lifestream/contracts/game-journal';
import type {CampaignJournal,ActivityScope,ActivityCheckpoint,GameActionResult} from '@lifestream/contracts/game-activity';
import {createContractValidator} from '@lifestream/contracts';
import {gameHostDigest} from '@lifestream/contracts/game-host';
import type {ActivityMetadataPolicy,ControllerUsage} from './game-activity.ts';
import type {Database,Transaction} from './database.ts';
export type CampaignOwner={principalId:string;assistantId:string;relationshipId:string};
export type CampaignJournalPolicy={enabled:boolean;revision:number;retentionMs:number;retentionPolicyRef:string};
type Entry=CampaignJournal['entries'][number];type Goal=CampaignJournal['goals'][number];
type Row={journal_id:string;owner_key:string;campaign_id:string;revision:number;access_revision:number;policy_revision:number;policy_digest:string;expires_at:number;state:'active'|'needsReview'|'retracted'|'expired';header_json:string|null;goals_json:string|null};
export type CampaignJournalOptions={retainHistoricalAttempts?:true;maxJournals:number;maxEntryIdentities:number;maxSourceFences:number;maxJournalBytes:number;scopeCurrent:(owner:CampaignOwner)=>boolean;quarantined:()=>boolean;policyFor:(owner:CampaignOwner)=>CampaignJournalPolicy|null;allowCreate:(owner:CampaignOwner,journal:CampaignJournal)=>boolean;sourceCurrent:(owner:CampaignOwner,entry:Entry)=>boolean;journalCurrent:(owner:CampaignOwner,journal:CampaignJournal)=>boolean;now?:()=>number};
export class CampaignJournalError extends Error{readonly code:'invalidJournal'|'unavailable'|'revisionConflict'|'sourceChanged'|'capacity'|'identityConflict'|'clockUncertain';constructor(code:CampaignJournalError['code']){super('Campaign journal '+code);this.code=code;}}
const ownerKey=(o:CampaignOwner)=>JSON.stringify([o.principalId,o.assistantId,o.relationshipId]);
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const sourceHash=(owner:CampaignOwner,source:string)=>digest([ownerKey(owner),source]);
/** Metadata continuity is not memory consent, game progress, save or authority.
 * Host callbacks resolve exact retained sources, validated derivations and owner/restore policy. They are synchronous read-only predicates, never model/self-issued grants. */
export class CampaignJournalRepository{
 private readonly database:Database;private readonly options:CampaignJournalOptions;private readonly now:()=>number;
 constructor(database:Database,options:CampaignJournalOptions){
  if(options.retainHistoricalAttempts!==undefined&&options.retainHistoricalAttempts!==true)throw new CampaignJournalError('unavailable');
  if(![options.maxJournals,options.maxEntryIdentities,options.maxSourceFences,options.maxJournalBytes].every(n=>Number.isSafeInteger(n)&&n>0)||options.maxJournals>128||options.maxEntryIdentities>8192||options.maxSourceFences>65536||options.maxJournalBytes>262144||['scopeCurrent','quarantined','policyFor','allowCreate','sourceCurrent','journalCurrent'].some(k=>typeof (options as any)[k]!=='function'))throw new CampaignJournalError('unavailable');
  this.database=database;this.options={...options};this.now=options.now??Date.now;
 }
 private time(){const now=this.now(),seen=this.database.connection.prepare('SELECT observed_at FROM campaign_journal_clock WHERE singleton=1').get()!.observed_at as number;if(!Number.isSafeInteger(now)||now<seen)throw new CampaignJournalError('clockUncertain');this.database.connection.prepare('UPDATE campaign_journal_clock SET observed_at=? WHERE singleton=1').run(now);return now;}
 private scope(owner:CampaignOwner){try{return this.options.quarantined()===false&&this.options.scopeCurrent(owner)===true;}catch{return false;}}
 private source(owner:CampaignOwner,entry:Entry){try{return this.options.sourceCurrent(owner,structuredClone(entry))===true;}catch{return false;}}
 private fenced(owner:CampaignOwner,entry:Entry){return entry.sourceRefs.some(ref=>{const row=this.database.connection.prepare('SELECT fenced FROM campaign_journal_sources WHERE owner_key=? AND source_hash=?').get(ownerKey(owner),sourceHash(owner,ref));return !row||row.fenced===1;});}
 private createAllowed(owner:CampaignOwner,journal:CampaignJournal){try{return this.options.allowCreate(owner,structuredClone(journal))===true;}catch{return false;}}
 /** Host validates the exact summary, goals, transformation and content scope;
  * cited eligible entries alone do not prove a summary's semantic grounding. */
 private derivation(owner:CampaignOwner,journal:CampaignJournal){try{return this.options.journalCurrent(owner,structuredClone(journal))===true;}catch{return false;}}
 private policy(owner:CampaignOwner){try{const policy=this.options.policyFor(owner);if(!this.scope(owner)||policy?.enabled!==true||!Number.isSafeInteger(policy.revision)||policy.revision<1||!Number.isSafeInteger(policy.retentionMs)||policy.retentionMs<1||typeof policy.retentionPolicyRef!=='string'||!policy.retentionPolicyRef.length)return null;return {...policy};}catch{return null;}}
 private current(owner:CampaignOwner,policy:CampaignJournalPolicy){return isDeepStrictEqual(this.policy(owner),policy);}
 private row(owner:CampaignOwner,id:string):Row|undefined{return this.database.connection.prepare('SELECT * FROM campaign_journals WHERE journal_id=? AND owner_key=?').get(id,ownerKey(owner)) as Row|undefined;}
 private entries(id:string):Entry[]{
  const entries=this.database.connection.prepare("SELECT payload_json FROM campaign_journal_entries WHERE journal_id=? AND state='retained' ORDER BY entry_id").all(id).map(row=>JSON.parse(row.payload_json as string) as Entry);
  if(!this.options.retainHistoricalAttempts||entries.length<=16)return entries;
  const row=this.database.readGet('SELECT header_json,goals_json FROM campaign_journals WHERE journal_id=?',id),header=JSON.parse(String(row?.header_json??'null')),goals=JSON.parse(String(row?.goals_json??'[]')) as Goal[];
  const pinned=new Set<string>([...(header?.summaryEntryIds??[]),...goals.flatMap(goal=>goal.sourceEntryIds)]),mandatory=entries.filter(entry=>pinned.has(entry.entryId)||entry.kind!=='attemptOutcome');
  if(mandatory.length>16)return entries;const keep=new Set(mandatory.map(entry=>entry.entryId));
  for(const entry of [...entries].sort((a,b)=>Date.parse(b.recordedAt)-Date.parse(a.recordedAt)||b.entryId.localeCompare(a.entryId)))if(keep.size<16)keep.add(entry.entryId);
  return entries.filter(entry=>keep.has(entry.entryId));
 }
 private retire(tx:Transaction,id:string,state:'retracted'|'expired'){
  tx.run('UPDATE campaign_journal_sources SET fenced=1 WHERE (owner_key,source_hash) IN (SELECT owner_key,source_hash FROM campaign_journal_entry_sources WHERE journal_id=?)',id);
  tx.run("UPDATE campaign_journal_entries SET payload_json=NULL,state='fenced' WHERE journal_id=?",id);tx.run('UPDATE campaign_journal_goal_versions SET fenced=1 WHERE journal_id=?',id);tx.run('UPDATE campaign_journals SET state=?,revision=revision+1,access_revision=access_revision+1,header_json=NULL,goals_json=NULL WHERE journal_id=?',state,id);
 }
 sweep(){const now=this.time();this.database.transaction(tx=>{for(const row of tx.all<{journal_id:string}>("SELECT journal_id FROM campaign_journals WHERE state IN ('active','needsReview') AND expires_at<=?",now))this.retire(tx,row.journal_id,'expired');});}
 /** Explicit owner policy withdrawal/revision invalidates old custody. This
  * runs independently of source selection; quarantine still permits no reuse. */
 reconcilePolicy(owner:CampaignOwner){if(!this.scope(owner))return;let policy:CampaignJournalPolicy|null;try{policy=this.options.policyFor(owner);}catch{return;}if(!policy)return;this.database.transaction(tx=>{for(const row of tx.all<Row>("SELECT * FROM campaign_journals WHERE owner_key=? AND state IN ('active','needsReview')",ownerKey(owner)))if(policy.enabled===false||row.policy_digest!==digest(policy))this.retire(tx,row.journal_id,'retracted');});}
 put(owner:CampaignOwner,input:CampaignJournal,expectedRevision:number):CampaignJournal{return this.write(owner,input,expectedRevision);}
 private write(owner:CampaignOwner,input:CampaignJournal,expectedRevision:number,finalize?: (tx:Transaction)=>void):CampaignJournal{
  const now=this.time();if(!finalize)this.sweep();const policy=this.policy(owner);if(!policy)throw new CampaignJournalError('unavailable');
  const journal=campaignJournalSnapshot(input,now,this.options.maxJournalBytes);if(!journal||journal.retentionPolicyRef!==policy.retentionPolicyRef||journal.revision!==expectedRevision+1)throw new CampaignJournalError('invalidJournal');
  const expires=now+policy.retentionMs;if(!Number.isSafeInteger(expires)||expires>8640000000000000)throw new CampaignJournalError('invalidJournal');
  const previous=this.row(owner,journal.journalId);if(!previous&&this.database.connection.prepare('SELECT journal_id FROM campaign_journals WHERE journal_id=?').get(journal.journalId))throw new CampaignJournalError('identityConflict');
  if(previous&&(previous.revision!==expectedRevision||previous.campaign_id!==journal.campaignId||previous.policy_revision!==policy.revision||previous.policy_digest!==digest(policy)||!['active','needsReview'].includes(previous.state))||!previous&&expectedRevision!==0)throw new CampaignJournalError('revisionConflict');
  if(journal.accessRevision!==(previous?.access_revision??1))throw new CampaignJournalError('revisionConflict');
  if(!previous&&!this.createAllowed(owner,journal))throw new CampaignJournalError('unavailable');
  for(const goal of journal.goals){const prior=this.database.connection.prepare('SELECT revision,fingerprint,fenced FROM campaign_journal_goal_versions WHERE journal_id=? AND goal_id=?').get(journal.journalId,goal.goalId) as {revision:number;fingerprint:string;fenced:number}|undefined;const {revision,...content}=goal;if(prior){if(prior.fenced||revision!==prior.revision+(prior.fingerprint===digest(content)?0:1))throw new CampaignJournalError('revisionConflict');}else if(revision!==1)throw new CampaignJournalError('revisionConflict');}
  for(const entry of journal.entries){const old=this.database.connection.prepare('SELECT fingerprint,state FROM campaign_journal_entries WHERE journal_id=? AND entry_id=?').get(journal.journalId,entry.entryId);if(old&&(old.fingerprint!==digest(entry)||old.state==='fenced'))throw new CampaignJournalError('identityConflict');if(!this.source(owner,entry))throw new CampaignJournalError('sourceChanged');}
  if(!this.derivation(owner,journal)||!this.current(owner,policy))throw new CampaignJournalError('sourceChanged');
  this.database.transaction(tx=>{
   const latest=tx.get<Row>('SELECT * FROM campaign_journals WHERE journal_id=?',journal.journalId);if(latest?.revision!==previous?.revision)throw new CampaignJournalError('revisionConflict');
   if(!previous&&tx.get<{n:number}>('SELECT count(*) AS n FROM campaign_journals')!.n>=this.options.maxJournals)throw new CampaignJournalError('capacity');
   const newEntries=journal.entries.filter(entry=>!tx.get('SELECT entry_id FROM campaign_journal_entries WHERE journal_id=? AND entry_id=?',journal.journalId,entry.entryId)),newGoals=journal.goals.filter(goal=>!tx.get('SELECT goal_id FROM campaign_journal_goal_versions WHERE journal_id=? AND goal_id=?',journal.journalId,goal.goalId));if(tx.get<{n:number}>('SELECT count(*) AS n FROM campaign_journal_entries')!.n+tx.get<{n:number}>('SELECT count(*) AS n FROM campaign_journal_goal_versions')!.n+newEntries.length+newGoals.length>this.options.maxEntryIdentities)throw new CampaignJournalError('capacity');
   const hashes=[...new Set(journal.entries.flatMap(e=>e.sourceRefs).map(ref=>sourceHash(owner,ref)))];let added=0;for(const hash of hashes){const row=tx.get<{fenced:number}>('SELECT fenced FROM campaign_journal_sources WHERE owner_key=? AND source_hash=?',ownerKey(owner),hash);if(row?.fenced)throw new CampaignJournalError('sourceChanged');if(!row)added++;}
   if(tx.get<{n:number}>('SELECT count(*) AS n FROM campaign_journal_sources')!.n+added>this.options.maxSourceFences)throw new CampaignJournalError('capacity');
   const {entries,goals,...header}=journal;tx.run('INSERT INTO campaign_journals VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(journal_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,header_json=excluded.header_json,goals_json=excluded.goals_json',journal.journalId,ownerKey(owner),journal.campaignId,journal.revision,journal.accessRevision,policy.revision,digest(policy),previous?.expires_at??expires,'active',JSON.stringify(header),JSON.stringify(goals));
   if(this.options.retainHistoricalAttempts)tx.run("UPDATE campaign_journal_entries SET payload_json=NULL,state='omitted' WHERE journal_id=? AND state='retained' AND json_extract(payload_json,'$.kind')<>'attemptOutcome'",journal.journalId);
   else tx.run("UPDATE campaign_journal_entries SET payload_json=NULL,state='omitted' WHERE journal_id=? AND state='retained'",journal.journalId);
   for(const entry of entries){tx.run("INSERT INTO campaign_journal_entries VALUES(?,?,?,?,'retained') ON CONFLICT(journal_id,entry_id) DO UPDATE SET payload_json=excluded.payload_json,state='retained'",journal.journalId,entry.entryId,digest(entry),JSON.stringify(entry));for(const ref of entry.sourceRefs){const hash=sourceHash(owner,ref);tx.run('INSERT OR IGNORE INTO campaign_journal_sources VALUES(?,?,0)',ownerKey(owner),hash);tx.run('INSERT OR IGNORE INTO campaign_journal_entry_sources VALUES(?,?,?,?)',journal.journalId,entry.entryId,ownerKey(owner),hash);}}
   for(const goal of goals){const {revision,...content}=goal;tx.run('INSERT INTO campaign_journal_goal_versions VALUES(?,?,?,?,0) ON CONFLICT(journal_id,goal_id) DO UPDATE SET revision=excluded.revision,fingerprint=excluded.fingerprint',journal.journalId,goal.goalId,revision,digest(content));}
   if(entries.some(entry=>!this.source(owner,entry))||!this.derivation(owner,journal)||!this.current(owner,policy))throw new CampaignJournalError('sourceChanged');
   if(finalize){finalize(tx);if(entries.some(entry=>!this.source(owner,entry))||!this.derivation(owner,journal)||!this.current(owner,policy))throw new CampaignJournalError('sourceChanged');}
  });return structuredClone(journal);
 }
 /** Post-effect audit only. Both the controller usage and exact host result
  * must already be durably settled. The host supplies current authenticated
  * data access and exact closed-neutral custody, independently of input grants.
  * Missing resulting observations remain missing; this never enables resume. */
 recordClosedControllerReceipts(rawScope:ActivityScope,rawCandidates:readonly {result:GameActionResult;usage:ControllerUsage}[],rawPolicy:ActivityMetadataPolicy,maximumCheckpointBytes:number,current:()=>boolean):Readonly<{appended:number;journalRevision:number;checkpointRevision:number}>|null{
  const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
  const scope=boundedGameDataSnapshot(rawScope) as ActivityScope|null,candidates=boundedGameDataSnapshot(rawCandidates,262144) as {result:GameActionResult;usage:ControllerUsage}[]|null,metadata=boundedGameDataSnapshot(rawPolicy) as ActivityMetadataPolicy|null;
  if(!scope||!scope.relationshipId||!validator.validate(schema+'ActivityScope',scope).valid||!Array.isArray(candidates)||candidates.length<1||candidates.length>64||!metadata||Object.keys(metadata).sort().join(',')!=='bounds,enabled,retentionMs,revision'||metadata.enabled!==true||!validator.validate(schema+'GameBounds',metadata.bounds).valid||!Number.isSafeInteger(maximumCheckpointBytes)||maximumCheckpointBytes<1||maximumCheckpointBytes>262144||typeof current!=='function')return null;
  const owner={principalId:scope.principalId,assistantId:scope.assistantId,relationshipId:scope.relationshipId},key=ownerKey(owner),allowed=()=>{try{return current()===true&&this.scope(owner);}catch{return false;}};
  const selectedActions=candidates.map(candidate=>candidate?.usage?.receipt?.actionId);if(selectedActions.some(id=>typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)))return null;const placeholders=selectedActions.map(()=>'?').join(',');
  const read=()=>({checkpoint:this.database.readGet('SELECT * FROM activity_checkpoints WHERE run_id=? AND owner_key=?',scope.runId,key),claim:this.database.readGet('SELECT * FROM game_start_claims WHERE run_id=?',scope.runId),controllers:this.database.readAll('SELECT * FROM activity_controller_reservations WHERE run_id=? AND action_id IN ('+placeholders+') ORDER BY action_id',scope.runId,...selectedActions),planning:this.database.readAll("SELECT * FROM activity_planning_reservations WHERE run_id=? AND (state='reserved' OR settlement_digest IS NULL) LIMIT 1",scope.runId),dispatches:this.database.readAll('SELECT * FROM game_host_dispatch WHERE run_id=? AND action_id IN ('+placeholders+') ORDER BY action_id',scope.runId,...selectedActions)});
  if(!allowed())return null;const original=read(),row=original.checkpoint,claim=original.claim,now=this.time();
  if(!row||row.state!=='active'||typeof row.payload_json!=='string'||Number(row.expires_at)<=now||row.policy_digest!==digest(metadata)||!claim||claim.scope_digest!==digest(scope)||claim.owner_key!==digest([scope.assistantId,scope.principalId,scope.relationshipId,scope.environmentId,scope.activityId,'play'])||claim.assistant_id!==scope.assistantId||!['stopped','completed'].includes(String(claim.disposition))||typeof claim.receipt_digest!=='string'||!/^[a-f0-9]{64}$/.test(claim.receipt_digest)||this.database.readGet('SELECT 1 FROM game_controller_slots WHERE run_id=?',scope.runId)||original.controllers.length!==candidates.length||original.controllers.length>64||original.dispatches.length!==candidates.length||original.planning.length||this.database.readGet("SELECT 1 FROM activity_controller_reservations WHERE run_id=? AND (state='reserved' OR settlement_digest IS NULL) LIMIT 1",scope.runId))return null;
  const checkpoint=boundedGameDataSnapshot(JSON.parse(row.payload_json),maximumCheckpointBytes) as ActivityCheckpoint|null;
  if(!checkpoint||!validator.validate(schema+'ActivityCheckpoint',checkpoint).valid||!isDeepStrictEqual(checkpoint.scope,scope))return null;
  const ids=new Set<string>();
  for(const candidate of candidates){
   if(!candidate||Object.keys(candidate).sort().join(',')!=='result,usage'||!candidate.usage||Object.keys(candidate.usage).sort().join(',')!=='completionRef,receipt,wallMs'||!validator.validate(schema+'GameActionResult',candidate.result).valid||!validator.validate(schema+'GameActionReceipt',candidate.usage.receipt).valid)return null;
   const {result,usage}=candidate,a=usage.receipt,reservation=original.controllers.find(r=>r.action_id===a.actionId),dispatch=original.dispatches.find(r=>r.action_id===a.actionId);
   if(ids.has(a.actionId)||!isDeepStrictEqual(a.scope,scope)||!isDeepStrictEqual(result.outcome.payload,a)||result.outcome.status!=='succeeded'||!a.buttonsNeutralized||!['completed','cancelled','failed'].includes(a.disposition)||a.completedAt===null||a.afterFrame===null||a.framesApplied===null||!reservation||reservation.state!=='settled'||reservation.settlement_digest!==digest(usage)||reservation.idempotency_key!==a.idempotencyKey||reservation.admission_id!==a.admissionId||!dispatch||dispatch.state!=='entered'||dispatch.request_digest!==reservation.fingerprint||dispatch.receipt_digest!==gameHostDigest(result)||!Number.isSafeInteger(usage.wallMs)||usage.wallMs<0||usage.wallMs>Number(reservation.reserved_wall_ms)||a.framesApplied>Number(reservation.reserved_frames))return null;
   if(this.database.readGet('SELECT fenced FROM campaign_journal_sources WHERE owner_key=? AND source_hash=?',key,sourceHash(owner,'game-action:'+a.actionId))?.fenced===1)return null;
   ids.add(a.actionId);
  }
  const journalRow=this.row(owner,checkpoint.campaignJournalRef.journalId),policy=this.policy(owner);
  if(!journalRow||journalRow.state!=='active'||!journalRow.header_json||!journalRow.goals_json||journalRow.expires_at<=now||!policy||journalRow.policy_digest!==digest(policy)||journalRow.access_revision!==checkpoint.campaignJournalRef.accessRevision||journalRow.campaign_id!==scope.campaignId)return null;
  const previous=campaignJournalSnapshot({...JSON.parse(journalRow.header_json),revision:journalRow.revision,accessRevision:journalRow.access_revision,entries:this.entries(journalRow.journal_id),goals:JSON.parse(journalRow.goals_json)},now,this.options.maxJournalBytes);
  if(!previous||previous.entries.some(entry=>this.fenced(owner,entry))||!this.derivation(owner,previous)||!allowed())return null;
  const missing=candidates.filter(({usage})=>!this.database.readGet('SELECT 1 FROM campaign_journal_entry_sources WHERE journal_id=? AND owner_key=? AND source_hash=? LIMIT 1',previous.journalId,key,sourceHash(owner,'game-action:'+usage.receipt.actionId))),candidateLatest=[...candidates].sort((a,b)=>Date.parse(a.usage.receipt.completedAt!)-Date.parse(b.usage.receipt.completedAt!)).at(-1)!.usage.receipt;
  const priorReceipt=checkpoint.lastActionReceipt,latest=priorReceipt?.completedAt&&Date.parse(priorReceipt.completedAt)>=Date.parse(candidateLatest.completedAt!)&&(priorReceipt.afterFrame??-1)>=(candidateLatest.afterFrame??-1)?priorReceipt:candidateLatest;
  const used=JSON.parse(String(row.used_json)) as ActivityCheckpoint['budgetUsed'];
  if(!missing.length&&isDeepStrictEqual(checkpoint.lastActionReceipt,latest)&&isDeepStrictEqual(checkpoint.budgetUsed,used)&&checkpoint.resumeDisposition==='unavailable')return Object.freeze({appended:0,journalRevision:previous.revision,checkpointRevision:checkpoint.revision});
  // An already appended audit can repair only its exact checkpoint projection;
  // a qualified earlier outcome entry is never replaced or reinterpreted.
  const time=new Date(now).toISOString(),entries=missing.map(({usage}):Entry=>({entryId:randomUUID(),kind:'attemptOutcome',epistemicKind:'observation',content:`Settled controller receipt ${usage.receipt.actionId}: ${usage.receipt.disposition}; ${usage.receipt.framesApplied} frames; controls neutralized. Resulting observation unavailable at terminal finalization.`,sourceRefs:['game-action:'+usage.receipt.actionId],sourceSessionRef:'game-run:'+scope.runId,recordedAt:time,limitations:['Receipt-only post-effect audit. No qualified resulting observation, visible outcome, game progress or save persistence is established. This closed run cannot resume or authorize another input.']}));
  const nextJournal={...previous,revision:previous.revision+1,entries:[...previous.entries,...entries],updatedAt:time};
  const next:ActivityCheckpoint={...checkpoint,revision:checkpoint.revision+1,stateRevision:checkpoint.stateRevision+1,budgetUsed:{...used},lastActionReceipt:latest,recordedAt:time,resumeDisposition:'unavailable',campaignJournalRef:{...checkpoint.campaignJournalRef,revision:nextJournal.revision}};
  const floor=used.checkpointBytes;for(let i=0;i<8;i++){const bytes=Buffer.byteLength(JSON.stringify(next)),charge=floor+bytes;if(next.budgetUsed.checkpointBytes===charge)break;next.budgetUsed.checkpointBytes=charge;}
  if(Buffer.byteLength(JSON.stringify(next))>maximumCheckpointBytes||next.budgetUsed.checkpointBytes>metadata.bounds.checkpointByteBudget||!validator.validate(schema+'ActivityCheckpoint',next).valid)return null;
  const terminal=()=>allowed()&&!this.database.readGet('SELECT 1 FROM game_controller_slots WHERE run_id=?',scope.runId)&&!this.database.readGet("SELECT 1 FROM activity_controller_reservations WHERE run_id=? AND (state='reserved' OR settlement_digest IS NULL) LIMIT 1",scope.runId)&&isDeepStrictEqual(read(),original);
  if(!terminal())return null;
  this.write(owner,nextJournal,previous.revision,tx=>{
   if(!terminal())throw new CampaignJournalError('sourceChanged');
   tx.run('UPDATE activity_checkpoints SET checkpoint_revision=?,state_revision=?,ledger_revision=ledger_revision+1,payload_json=?,used_json=? WHERE run_id=? AND owner_key=? AND ledger_revision=?',next.revision,next.stateRevision,JSON.stringify(next),JSON.stringify(next.budgetUsed),scope.runId,key,row.ledger_revision);
   const expected={...original,checkpoint:Object.assign(Object.create(Object.getPrototypeOf(row)),row,{checkpoint_revision:next.revision,state_revision:next.stateRevision,ledger_revision:Number(row.ledger_revision)+1,payload_json:JSON.stringify(next),used_json:JSON.stringify(next.budgetUsed)})};
   if(!allowed()||this.database.readGet('SELECT 1 FROM game_controller_slots WHERE run_id=?',scope.runId)||!isDeepStrictEqual(read(),expected))throw new CampaignJournalError('sourceChanged');
  });
  return Object.freeze({appended:missing.length,journalRevision:nextJournal.revision,checkpointRevision:next.revision});
 }
 /** Removes dependent prose before any further read. Opaque identities fence
  * late updates; independent entries survive while a grounded summary is rebuilt. */
 forgetSource(owner:CampaignOwner,source:string){if(!this.scope(owner)||typeof source!=='string'||source.length>2048)throw new CampaignJournalError('unavailable');const hash=sourceHash(owner,source);this.database.transaction(tx=>{
   const rows=tx.all<{journal_id:string;entry_id:string}>("SELECT s.journal_id,s.entry_id FROM campaign_journal_entry_sources s JOIN campaign_journal_entries e ON e.journal_id=s.journal_id AND e.entry_id=s.entry_id WHERE s.owner_key=? AND s.source_hash=? AND e.state<>'fenced'",ownerKey(owner),hash);tx.run('UPDATE campaign_journal_sources SET fenced=1 WHERE owner_key=? AND source_hash=?',ownerKey(owner),hash);
   for(const id of new Set(rows.map(r=>r.journal_id))){const removed=new Set(rows.filter(r=>r.journal_id===id).map(r=>r.entry_id)),row=tx.get<Row>('SELECT * FROM campaign_journals WHERE journal_id=?',id)!;if(!['active','needsReview'].includes(row.state))continue;
    for(const entry of removed)tx.run("UPDATE campaign_journal_entries SET payload_json=NULL,state='fenced' WHERE journal_id=? AND entry_id=?",id,entry);
    let goals:Goal[]=JSON.parse(row.goals_json??'[]');goals=goals.filter(g=>!g.sourceEntryIds.some(e=>removed.has(e)));let changed=true;while(changed){const ids=new Set(goals.map(g=>g.goalId)),next=goals.filter(g=>g.supersedesGoalId===null||ids.has(g.supersedesGoalId));changed=next.length!==goals.length;goals=next;}
    const survivingGoals=new Set(goals.map(g=>g.goalId));for(const old of JSON.parse(row.goals_json??'[]') as Goal[])if(!survivingGoals.has(old.goalId))tx.run('UPDATE campaign_journal_goal_versions SET fenced=1 WHERE journal_id=? AND goal_id=?',id,old.goalId);
    const header=row.header_json?JSON.parse(row.header_json):null,summaryLost=!header||header.summaryEntryIds.some((e:string)=>removed.has(e));tx.run('UPDATE campaign_journals SET revision=revision+1,access_revision=access_revision+1,state=?,header_json=?,goals_json=? WHERE journal_id=?',summaryLost?'needsReview':'active',summaryLost?null:row.header_json,JSON.stringify(goals),id);
   }
  });}
 inspect(owner:CampaignOwner,id:string){this.sweep();this.reconcilePolicy(owner);const policy=this.policy(owner);if(!policy)return null;let row=this.row(owner,id);if(!row)return null;
  if(['active','needsReview'].includes(row.state)&&row.policy_digest!==digest(policy)){this.database.transaction(tx=>this.retire(tx,id,'retracted'));row=this.row(owner,id)!;}
  if(!['active','needsReview'].includes(row.state))return {revision:row.revision,accessRevision:row.access_revision,state:row.state,summary:null,entries:[] as Entry[],goals:[] as Goal[]};
  for(const entry of this.entries(id))if(this.fenced(owner,entry)||!this.source(owner,entry))for(const source of entry.sourceRefs)this.forgetSource(owner,source);
  row=this.row(owner,id)!;if(!this.current(owner,policy))return null;const header=row.header_json?JSON.parse(row.header_json):null;
  return {revision:row.revision,accessRevision:row.access_revision,state:row.state,summary:header?.summary??null,entries:this.entries(id),goals:JSON.parse(row.goals_json??'[]') as Goal[]};
 }
 get(owner:CampaignOwner,id:string):CampaignJournal|null{const inspected=this.inspect(owner,id);if(!inspected||inspected.state!=='active')return null;const row=this.row(owner,id)!,header=JSON.parse(row.header_json!);const journal={...header,revision:row.revision,accessRevision:row.access_revision,entries:inspected.entries,goals:inspected.goals};const validated=campaignJournalSnapshot(journal,this.time(),this.options.maxJournalBytes);if(!validated||!this.derivation(owner,validated))return null;const latest=this.row(owner,id),policy=this.policy(owner);return latest?.state==='active'&&latest.revision===row.revision&&latest.access_revision===row.access_revision&&policy&&digest(policy)===row.policy_digest&&!validated.entries.some(entry=>this.fenced(owner,entry))?validated:null;}
 retract(owner:CampaignOwner,id:string,revision:number){if(!this.scope(owner))throw new CampaignJournalError('unavailable');const row=this.row(owner,id);if(!row||row.revision!==revision||!['active','needsReview'].includes(row.state))throw new CampaignJournalError('revisionConflict');this.database.transaction(tx=>this.retire(tx,id,'retracted'));}
}
