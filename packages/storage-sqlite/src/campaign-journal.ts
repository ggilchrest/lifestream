import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {campaignJournalSnapshot} from '@lifestream/contracts/game-journal';
import type {CampaignJournal} from '@lifestream/contracts/game-activity';
import type {Database,Transaction} from './database.ts';
export type CampaignOwner={principalId:string;assistantId:string;relationshipId:string};
export type CampaignJournalPolicy={enabled:boolean;revision:number;retentionMs:number;retentionPolicyRef:string};
type Entry=CampaignJournal['entries'][number];type Goal=CampaignJournal['goals'][number];
type Row={journal_id:string;owner_key:string;campaign_id:string;revision:number;access_revision:number;policy_revision:number;policy_digest:string;expires_at:number;state:'active'|'needsReview'|'retracted'|'expired';header_json:string|null;goals_json:string|null};
export type CampaignJournalOptions={maxJournals:number;maxEntryIdentities:number;maxSourceFences:number;maxJournalBytes:number;scopeCurrent:(owner:CampaignOwner)=>boolean;quarantined:()=>boolean;policyFor:(owner:CampaignOwner)=>CampaignJournalPolicy|null;allowCreate:(owner:CampaignOwner,journal:CampaignJournal)=>boolean;sourceCurrent:(owner:CampaignOwner,entry:Entry)=>boolean;journalCurrent:(owner:CampaignOwner,journal:CampaignJournal)=>boolean;now?:()=>number};
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
 private entries(id:string):Entry[]{return this.database.connection.prepare("SELECT payload_json FROM campaign_journal_entries WHERE journal_id=? AND state='retained' ORDER BY entry_id").all(id).map(row=>JSON.parse(row.payload_json as string));}
 private retire(tx:Transaction,id:string,state:'retracted'|'expired'){
  tx.run('UPDATE campaign_journal_sources SET fenced=1 WHERE (owner_key,source_hash) IN (SELECT owner_key,source_hash FROM campaign_journal_entry_sources WHERE journal_id=?)',id);
  tx.run("UPDATE campaign_journal_entries SET payload_json=NULL,state='fenced' WHERE journal_id=?",id);tx.run('UPDATE campaign_journal_goal_versions SET fenced=1 WHERE journal_id=?',id);tx.run('UPDATE campaign_journals SET state=?,revision=revision+1,access_revision=access_revision+1,header_json=NULL,goals_json=NULL WHERE journal_id=?',state,id);
 }
 sweep(){const now=this.time();this.database.transaction(tx=>{for(const row of tx.all<{journal_id:string}>("SELECT journal_id FROM campaign_journals WHERE state IN ('active','needsReview') AND expires_at<=?",now))this.retire(tx,row.journal_id,'expired');});}
 /** Explicit owner policy withdrawal/revision invalidates old custody. This
  * runs independently of source selection; quarantine still permits no reuse. */
 reconcilePolicy(owner:CampaignOwner){if(!this.scope(owner))return;let policy:CampaignJournalPolicy|null;try{policy=this.options.policyFor(owner);}catch{return;}if(!policy)return;this.database.transaction(tx=>{for(const row of tx.all<Row>("SELECT * FROM campaign_journals WHERE owner_key=? AND state IN ('active','needsReview')",ownerKey(owner)))if(policy.enabled===false||row.policy_digest!==digest(policy))this.retire(tx,row.journal_id,'retracted');});}
 put(owner:CampaignOwner,input:CampaignJournal,expectedRevision:number):CampaignJournal{
  const now=this.time();this.sweep();const policy=this.policy(owner);if(!policy)throw new CampaignJournalError('unavailable');
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
   tx.run("UPDATE campaign_journal_entries SET payload_json=NULL,state='omitted' WHERE journal_id=? AND state='retained'",journal.journalId);
   for(const entry of entries){tx.run("INSERT INTO campaign_journal_entries VALUES(?,?,?,?,'retained') ON CONFLICT(journal_id,entry_id) DO UPDATE SET payload_json=excluded.payload_json,state='retained'",journal.journalId,entry.entryId,digest(entry),JSON.stringify(entry));for(const ref of entry.sourceRefs){const hash=sourceHash(owner,ref);tx.run('INSERT OR IGNORE INTO campaign_journal_sources VALUES(?,?,0)',ownerKey(owner),hash);tx.run('INSERT OR IGNORE INTO campaign_journal_entry_sources VALUES(?,?,?,?)',journal.journalId,entry.entryId,ownerKey(owner),hash);}}
   for(const goal of goals){const {revision,...content}=goal;tx.run('INSERT INTO campaign_journal_goal_versions VALUES(?,?,?,?,0) ON CONFLICT(journal_id,goal_id) DO UPDATE SET revision=excluded.revision,fingerprint=excluded.fingerprint',journal.journalId,goal.goalId,revision,digest(content));}
   if(entries.some(entry=>!this.source(owner,entry))||!this.derivation(owner,journal)||!this.current(owner,policy))throw new CampaignJournalError('sourceChanged');
  });return structuredClone(journal);
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
