import {createHash, randomUUID} from 'node:crypto';
import {autonomyLimits,defaultAutonomyConfiguration,validateAutonomyConfiguration,validateAutonomyScope,validateImprovementProposal,
  type AutonomyConfiguration,type AutonomyEvidence,type AutonomyJob,type AutonomyScope,type AutonomySettings,type ImprovementCandidate,type ImprovementDecision,type ImprovementProposal,type ImprovementRecord,type PreparedAutonomyBriefing,type AutonomyCandidatePlan} from '@lifestream/contracts';
import type {Database,Transaction} from './database.ts';

export function autonomyDigest(value:unknown):string {
  const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
  return createHash('sha256').update(canonical(value)).digest('hex');
}
const scopeKey=(scope:AutonomyScope)=>autonomyDigest(validateAutonomyScope(scope));
const sourceDigest=(proposal:ImprovementProposal)=>autonomyDigest(proposal.evidenceRefs.map(r=>[r.id,r.revision,r.digest]).sort());
const fingerprint=(proposal:ImprovementProposal)=>autonomyDigest([proposal.goalId,proposal.hypothesis.toLowerCase().replace(/\s+/g,' ').trim()]);
const boundary=(record:Pick<ImprovementRecord,'proposal'|'candidate'>)=>autonomyDigest([record.proposal,record.candidate]);
type Row={record_json:string};
const parse=<T>(row:Row|undefined):T|null=>row?JSON.parse(row.record_json) as T:null;
export type AutonomyBudget = {calls:number;computeMs:number;costUsd:number;totalCostUsd:number};

/** All durable state uses the normal private application database. No source text is copied here. */
export class AutonomyRepository {
  private database:Database;private now:()=>number;
  constructor(database:Database,now:()=>number=Date.now){this.database=database;this.now=now;}
  private time(){return new Date(this.now()).toISOString();}
  read(scope:AutonomyScope):AutonomySettings {
    return parse<AutonomySettings>(this.database.connection.prepare('SELECT record_json FROM autonomy_settings WHERE scope_key=?').get(scopeKey(scope)) as Row|undefined)
      ?? {scope:validateAutonomyScope(scope),revision:0,configuration:defaultAutonomyConfiguration(),updatedAt:this.time()};
  }
  scopes():AutonomyScope[]{return (this.database.connection.prepare('SELECT record_json FROM autonomy_settings').all() as Row[]).map(row=>JSON.parse(row.record_json).scope);}
  configure(scope:AutonomyScope,expectedRevision:number,value:unknown,actor:string):AutonomySettings {
    if(actor!==scope.principalId)throw Error('autonomy_owner_required');const configuration=validateAutonomyConfiguration(value),key=scopeKey(scope);
    return this.database.transaction(tx=>{const prior=parse<AutonomySettings>(tx.get<Row>('SELECT record_json FROM autonomy_settings WHERE scope_key=?',key))??this.read(scope);
      if(prior.revision!==expectedRevision)throw Error('autonomy_revision_conflict');
      const next={scope:validateAutonomyScope(scope),revision:prior.revision+1,configuration,updatedAt:this.time()};
      tx.run('INSERT INTO autonomy_settings VALUES (?,?) ON CONFLICT(scope_key) DO UPDATE SET record_json=excluded.record_json',key,JSON.stringify(next));
      for(const row of tx.all<Row>('SELECT record_json FROM autonomy_jobs WHERE scope_key=?',key)){const job=JSON.parse(row.record_json) as AutonomyJob;if(['queued','running','blocked'].includes(job.state)){job.state='cancelled';job.reason='owner_configuration_changed';job.updatedAt=this.time();this.saveJob(tx,job);}}
      return next;
    });
  }
  list(scope:AutonomyScope):ImprovementRecord[]{return (this.database.connection.prepare('SELECT record_json FROM autonomy_improvements WHERE scope_key=? ORDER BY rowid DESC LIMIT ?').all(scopeKey(scope),autonomyLimits.maximumRecords) as Row[]).map(row=>JSON.parse(row.record_json));}
  get(scope:AutonomyScope,id:string):ImprovementRecord|null{return parse<ImprovementRecord>(this.database.connection.prepare('SELECT record_json FROM autonomy_improvements WHERE scope_key=? AND id=?').get(scopeKey(scope),id) as Row|undefined);}
  setCandidatePlan(scope:AutonomyScope,id:string,expectedRevision:number,value:unknown,actor:string):AutonomyCandidatePlan {
    if(actor!==scope.principalId)throw Error('autonomy_owner_required');return this.saveCandidatePlan(scope,id,expectedRevision,value,'owner');
  }
  saveGeneratedCandidatePlan(scope:AutonomyScope,id:string,expectedRevision:number,value:unknown):AutonomyCandidatePlan {
    if(!this.authorized(scope,id,'prepare'))throw Error('autonomy_workshop_not_authorized');if(this.candidatePlanInfo(scope,id)?.provenance==='owner')throw Error('autonomy_owner_plan_current');return this.saveCandidatePlan(scope,id,expectedRevision,value,'assistant');
  }
  private saveCandidatePlan(scope:AutonomyScope,id:string,expectedRevision:number,value:unknown,provenance:'owner'|'assistant'):AutonomyCandidatePlan {
    const record=this.get(scope,id);if(!record||record.revision!==expectedRevision)throw Error('autonomy_revision_conflict');
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('autonomy_invalid_candidate_plan');const plan=value as AutonomyCandidatePlan;
    if(Object.keys(plan).some(key=>!['repositoryId','baseRevision','changes'].includes(key))||typeof plan.repositoryId!=='string'||!plan.repositoryId||plan.repositoryId.length>200||plan.baseRevision!==undefined&&(typeof plan.baseRevision!=='string'||!/^[a-f0-9]{40,64}$/.test(plan.baseRevision))||!Array.isArray(plan.changes)||!plan.changes.length||plan.changes.length>32)throw Error('autonomy_invalid_candidate_plan');
    let bytes=0;for(const change of plan.changes){if(!change||Object.keys(change).sort().join(',')!=='content,expectedContentHash,path'||typeof change.path!=='string'||!change.path||change.path.length>512||change.expectedContentHash!==null&&(typeof change.expectedContentHash!=='string'||!/^[a-f0-9]{64}$/.test(change.expectedContentHash))||change.content!==null&&typeof change.content!=='string')throw Error('autonomy_invalid_candidate_plan');bytes+=Buffer.byteLength(change.content??'');}
    if(bytes>262144)throw Error('autonomy_candidate_plan_budget');const existing=this.candidatePlan(scope,id);
    if(record.candidate&&(!existing||autonomyDigest(existing)!==autonomyDigest(plan)))throw Error('autonomy_candidate_plan_changed_after_review');
    this.database.connection.prepare('INSERT INTO autonomy_candidate_plans VALUES (?,?,?,?) ON CONFLICT(improvement_id) DO UPDATE SET boundary=excluded.boundary,plan_json=excluded.plan_json').run(id,scopeKey(scope),autonomyDigest(record.proposal),JSON.stringify({plan,provenance,createdAt:this.time()}));return structuredClone(plan);
  }
  candidatePlanInfo(scope:AutonomyScope,id:string):{plan:AutonomyCandidatePlan;provenance:'owner'|'assistant';createdAt:string}|null {const record=this.get(scope,id),row=this.database.connection.prepare('SELECT boundary,plan_json FROM autonomy_candidate_plans WHERE scope_key=? AND improvement_id=?').get(scopeKey(scope),id) as {boundary:string;plan_json:string}|undefined;if(!record||!row||row.boundary!==autonomyDigest(record.proposal))return null;const stored=JSON.parse(row.plan_json);return stored.plan?stored:{plan:stored,provenance:'owner',createdAt:record.createdAt};}
  candidatePlan(scope:AutonomyScope,id:string):AutonomyCandidatePlan|null {return this.candidatePlanInfo(scope,id)?.plan??null;}
  propose(scope:AutonomyScope,value:unknown,sources:AutonomyEvidence[]):ImprovementRecord {
    const proposal=validateImprovementProposal(value,this.read(scope).configuration,sources),key=scopeKey(scope),stamp=this.time(),evidenceDigest=sourceDigest(proposal),fp=fingerprint(proposal);
    return this.database.transaction(tx=>{
      const related=tx.all<Row>('SELECT record_json FROM autonomy_improvements WHERE scope_key=? AND (idea_key=? OR fingerprint=?) ORDER BY rowid DESC',key,proposal.key,fp).map(row=>JSON.parse(row.record_json) as ImprovementRecord);
      let prior=related.find(record=>record.evidenceDigest===evidenceDigest)??related[0];
      // A renamed/restated suggestion cannot repeatedly ask for declined authority on unchanged evidence.
      if(prior&&prior.evidenceDigest===evidenceDigest)return prior;
      // New evidence can propose a follow-up without deleting an applied change's
      // durable candidate, decision or recovery reference.
      if(prior?.evaluation){proposal.key=proposal.key.slice(0,50)+'-'+evidenceDigest.slice(0,16);prior=undefined;}
      if(!prior&&Number(tx.get<{n:number}>('SELECT count(*) AS n FROM autonomy_improvements WHERE scope_key=?',key)!.n)>=autonomyLimits.maximumRecords)throw Error('autonomy_backlog_capacity');
      const record:ImprovementRecord={id:prior?.id??randomUUID(),scope:validateAutonomyScope(scope),revision:(prior?.revision??0)+1,state:prior?'investigating':'proposed',proposal:{...proposal,key:prior?.proposal.key??proposal.key},evidenceDigest,scopeDigest:'',candidate:null,decision:null,decisionHistory:prior?.decisionHistory??[],evaluation:null,createdAt:prior?.createdAt??stamp,updatedAt:stamp};
      if(proposal.requiredAuthority.some(authority=>!['research','workshop','apply'].includes(authority)))record.state='blocked';
      record.scopeDigest=boundary(record);
      tx.run('INSERT INTO autonomy_improvements VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,record_json=excluded.record_json',record.id,key,record.proposal.key,fp,JSON.stringify(record));return record;
    });
  }
  private mutate(scope:AutonomyScope,id:string,revision:number,apply:(record:ImprovementRecord)=>void):ImprovementRecord {
    return this.database.transaction(tx=>{const record=parse<ImprovementRecord>(tx.get<Row>('SELECT record_json FROM autonomy_improvements WHERE scope_key=? AND id=?',scopeKey(scope),id));
      if(!record)throw Error('autonomy_improvement_missing');if(record.revision!==revision)throw Error('autonomy_revision_conflict');apply(record);record.revision++;record.updatedAt=this.time();record.scopeDigest=boundary(record);
      tx.run('UPDATE autonomy_improvements SET record_json=? WHERE id=?',JSON.stringify(record),id);return record;});
  }
  attachCandidate(scope:AutonomyScope,id:string,revision:number,candidate:ImprovementCandidate):ImprovementRecord {
    if(!this.authorized(scope,id,'prepare'))throw Error('autonomy_workshop_not_authorized');
    if(!candidate||Object.keys(candidate).sort().join(',')!=='baseRevision,candidateRevision,id,outcomeDigest,passed'||typeof candidate.id!=='string'||!candidate.id||candidate.id.length>256||![candidate.baseRevision,candidate.candidateRevision,candidate.outcomeDigest].every(v=>typeof v==='string'&&/^[a-f0-9]{40,64}$/.test(v))||typeof candidate.passed!=='boolean')throw Error('autonomy_invalid_candidate');
    return this.mutate(scope,id,revision,record=>{if(['rejected','abandoned','retained','reverted'].includes(record.state))throw Error('autonomy_closed_improvement');record.candidate=structuredClone(candidate);record.decision=null;record.state=candidate.passed?'readyForReview':'blocked';});
  }
  decide(scope:AutonomyScope,id:string,revision:number,decision:ImprovementDecision['decision'],actor:string,note=''):ImprovementRecord {
    if(actor!==scope.principalId)throw Error('autonomy_owner_required');if(!['approve','reject','defer','revoke','abandon','rollback'].includes(decision)||typeof note!=='string'||note.length>1000)throw Error('autonomy_invalid_decision');
    return this.mutate(scope,id,revision,record=>{if(decision==='approve'&&(record.state!=='readyForReview'||!record.candidate?.passed))throw Error('autonomy_candidate_review_required');
      if(decision==='rollback'&&!record.candidate)throw Error('autonomy_recovery_candidate_required');
      record.decision={id:randomUUID(),actor,at:this.time(),decision,scopeDigest:record.scopeDigest,note};record.decisionHistory=[...record.decisionHistory,record.decision].slice(-64);if(decision!=='rollback')record.state=decision==='approve'?'approved':decision==='reject'?'rejected':decision==='abandon'?'abandoned':'deferred';});
  }
  authorized(scope:AutonomyScope,id:string,action:'prepare'|'apply'|'rollback',decisionId?:string):boolean {
    const settings=this.read(scope),record=this.get(scope,id);if(!record)return false;
    if(action==='rollback')return !!record.candidate&&!!record.decision&&record.decision.id===decisionId&&['approve','rollback'].includes(record.decision.decision)&&record.decision.scopeDigest===record.scopeDigest;
    const dependenciesReady=(item:ImprovementRecord,seen:Set<string>,depth:number):boolean=>item.proposal.dependencies.every(id=>{if(seen.has(id)||depth>2)return false;const dependency=this.get(scope,id);if(!dependency)return false;if(dependency.state==='retained')return true;if(action==='apply'||!dependency.candidate?.passed||['rejected','deferred','blocked','abandoned','reverted'].includes(dependency.state))return false;return dependenciesReady(dependency,new Set([...seen,id]),depth+1);});
    if(!dependenciesReady(record,new Set([record.id]),1))return false;
    if(action==='apply')return settings.configuration.mandate.enabled&&record.state==='approved'&&!!record.candidate?.passed&&record.decision?.decision==='approve'&&record.decision.scopeDigest===record.scopeDigest&&(decisionId===undefined||record.decision.id===decisionId);
    const mandate=settings.configuration.mandate;return mandate.enabled&&mandate.allowWorkshop&&!['rejected','deferred','abandoned','retained','reverted'].includes(record.state)&&record.proposal.requiredAuthority.every(value=>['research','workshop','apply'].includes(value))&&record.proposal.budget.computeMs<=mandate.dailyComputeMs&&record.proposal.budget.costUsd<=mandate.totalCostLimitUsd;
  }
  authorizeRecovery(scope:AutonomyScope,id:string,revision:number,actor:string):ImprovementRecord {return this.decide(scope,id,revision,'rollback',actor,'Explicit recovery of an applied candidate.');}
  evaluate(scope:AutonomyScope,id:string,revision:number,outcome:'retained'|'reverted',summary:string,decisionId:string):ImprovementRecord {
    if(!this.authorized(scope,id,outcome==='reverted'?'rollback':'apply',decisionId))throw Error('autonomy_application_not_authorized');
    if(typeof summary!=='string'||!summary.trim()||summary.length>1500)throw Error('autonomy_invalid_evaluation');
    return this.mutate(scope,id,revision,record=>{record.evaluation={outcome,summary,at:this.time()};record.state=outcome;});
  }
  /** Record an observed execution receipt even when a newer owner revocation raced its completion. */
  recordExecutionOutcome(scope:AutonomyScope,id:string,revision:number,outcome:'retained'|'reverted',summary:string,decisionId:string):ImprovementRecord {
    if(typeof summary!=='string'||!summary.trim()||summary.length>1500)throw Error('autonomy_invalid_evaluation');
    const current=this.get(scope,id);if(current?.revision===revision&&current.evaluation?.outcome===outcome&&current.evaluation.summary===summary)return current;
    return this.mutate(scope,id,revision,record=>{const grant=record.decisionHistory.find(item=>item.id===decisionId&&item.scopeDigest===record.scopeDigest&&item.decision===(outcome==='retained'?'approve':'rollback'))??(outcome==='reverted'?record.decisionHistory.find(item=>item.id===decisionId&&item.scopeDigest===record.scopeDigest&&item.decision==='approve'):undefined);if(!grant)throw Error('autonomy_execution_receipt_scope');record.evaluation={outcome,summary,at:this.time()};if(record.decision?.id===decisionId)record.state=outcome;});
  }
  /** The supplied references must be an authoritative validity set, never a retrieval window. */
  reconcile(scope:AutonomyScope,sources:readonly Pick<AutonomyEvidence,'id'|'revision'|'digest'>[]):void {
    const current=new Set(sources.map(source=>autonomyDigest([source.id,source.revision,source.digest])));
    for(const record of this.list(scope))if(record.proposal.evidenceRefs.some(ref=>!current.has(autonomyDigest([ref.id,ref.revision,ref.digest])))&&record.state!=='abandoned'){
      this.mutate(scope,record.id,record.revision,value=>{value.state='abandoned';value.decision=null;value.proposal.observation='Supporting evidence is no longer available.';value.proposal.hypothesis='Withdrawn with its evidence.';value.proposal.expectedBenefit='Unavailable';value.proposal.title='Withdrawn improvement';value.proposal.successMeasure='Unavailable';value.proposal.recovery='Use the retained candidate reference for explicit owner recovery.';value.proposal.evidenceRefs=[];if(value.evaluation)value.evaluation.summary='An execution outcome was recorded; its source-dependent summary was withdrawn.';});
      this.database.connection.prepare('DELETE FROM autonomy_briefings WHERE scope_key=?').run(scopeKey(scope));
      this.database.connection.prepare('DELETE FROM autonomy_candidate_plans WHERE improvement_id=?').run(record.id);
    }
  }
  jobs(scope:AutonomyScope):AutonomyJob[]{return (this.database.connection.prepare('SELECT record_json FROM autonomy_jobs WHERE scope_key=? ORDER BY rowid DESC LIMIT ?').all(scopeKey(scope),autonomyLimits.maximumJobs) as Row[]).map(row=>JSON.parse(row.record_json));}
  enqueue(scope:AutonomyScope,digest:string,key:string,kind:AutonomyJob['kind']='reflection',improvementId:string|null=null):AutonomyJob|null {
    const settings=this.read(scope),scopeId=scopeKey(scope);if(!settings.configuration.mandate.enabled||kind==='reflection'&&!settings.configuration.mandate.allowResearch||['workshop','planning'].includes(kind)&&(!improvementId||!this.authorized(scope,improvementId,'prepare')))return null;
    if(!/^[a-f0-9]{64}$/.test(digest)||!key||key.length>256)throw Error('autonomy_invalid_job');
    return this.database.transaction(tx=>{const prior=parse<AutonomyJob>(tx.get<Row>('SELECT record_json FROM autonomy_jobs WHERE scope_key=? AND job_key=?',scopeId,key));if(prior)return prior;
      const rows=tx.all<Row>('SELECT record_json FROM autonomy_jobs WHERE scope_key=? ORDER BY rowid',scopeId).map(row=>JSON.parse(row.record_json) as AutonomyJob);
      if(rows.length>=autonomyLimits.maximumJobs){const removable=rows.filter(job=>!['queued','running','blocked'].includes(job.state));if(!removable.length)return null;tx.run('DELETE FROM autonomy_jobs WHERE id=?',removable[0]!.id);}
      const job:AutonomyJob={id:randomUUID(),scope:validateAutonomyScope(scope),kind,key,improvementId,state:'queued',configurationRevision:settings.revision,attempts:0,nextAt:this.now(),sourceDigest:digest,checkpoint:null,reason:'queued',reservedComputeMs:0,reservedCostUsd:0,observedComputeMs:0,createdAt:this.time(),updatedAt:this.time()};
      tx.run('INSERT INTO autonomy_jobs VALUES (?,?,?,?)',job.id,scopeId,key,JSON.stringify(job));return job;});
  }
  private saveJob(tx:Transaction,job:AutonomyJob){tx.run('UPDATE autonomy_jobs SET record_json=? WHERE id=?',JSON.stringify(job),job.id);}
  current(job:AutonomyJob):boolean {const current=this.jobs(job.scope).find(item=>item.id===job.id),settings=this.read(job.scope);return !!current&&['queued','running'].includes(current.state)&&settings.revision===job.configurationRevision&&settings.configuration.mandate.enabled&&(job.kind!=='reflection'||settings.configuration.mandate.allowResearch)&&(!['workshop','planning'].includes(job.kind)||!!job.improvementId&&this.authorized(job.scope,job.improvementId,'prepare'));}
  budget(scope:AutonomyScope):AutonomyBudget {
    const key=scopeKey(scope),row=this.database.connection.prepare('SELECT calls,compute_ms,cost_usd FROM autonomy_budget WHERE scope_key=? AND day=?').get(key,Math.floor(this.now()/86400000)) as {calls:number;compute_ms:number;cost_usd:number}|undefined;
    const total=this.database.connection.prepare('SELECT coalesce(sum(cost_usd),0) AS total FROM autonomy_budget WHERE scope_key=?').get(key) as {total:number};return {calls:row?.calls??0,computeMs:row?.compute_ms??0,costUsd:row?.cost_usd??0,totalCostUsd:total.total};
  }
  admit(job:AutonomyJob,costUsd=0,requiredComputeMs=0):boolean {
    if(!this.current(job)||!Number.isFinite(costUsd)||costUsd<0||!Number.isFinite(requiredComputeMs)||requiredComputeMs<0)return false;
    return this.database.transaction(tx=>{const fresh=parse<AutonomyJob>(tx.get<Row>('SELECT record_json FROM autonomy_jobs WHERE id=?',job.id));if(!fresh||fresh.state!=='queued'||fresh.nextAt>this.now())return false;
      const settings=this.read(job.scope),mandate=settings.configuration.mandate,budget=this.budget(job.scope),compute=Math.max(requiredComputeMs,job.kind==='briefing'?100:job.kind==='workshop'?this.get(job.scope,job.improvementId!)?.proposal.budget.computeMs??autonomyLimits.reflectionDeadlineMs:autonomyLimits.reflectionDeadlineMs),call=['reflection','planning'].includes(job.kind)?1:0;
      if(fresh.attempts>=autonomyLimits.maximumAttempts){fresh.state='failed';fresh.reason='retry_budget';this.saveJob(tx,fresh);return false;}
      if(budget.calls+call>mandate.dailyCalls||budget.computeMs+compute>mandate.dailyComputeMs||budget.totalCostUsd+costUsd>mandate.totalCostLimitUsd){fresh.reason='budget_exhausted';fresh.nextAt=(Math.floor(this.now()/86400000)+1)*86400000;this.saveJob(tx,fresh);return false;}
      tx.run('INSERT INTO autonomy_budget VALUES (?,?,?,?,?) ON CONFLICT(scope_key,day) DO UPDATE SET calls=calls+excluded.calls,compute_ms=compute_ms+excluded.compute_ms,cost_usd=cost_usd+excluded.cost_usd',scopeKey(job.scope),Math.floor(this.now()/86400000),call,compute,costUsd);
      fresh.state='running';fresh.attempts++;fresh.reservedComputeMs+=compute;fresh.reservedCostUsd+=costUsd;fresh.reason='running';fresh.updatedAt=this.time();this.saveJob(tx,fresh);Object.assign(job,fresh);return true;});
  }
  finish(job:AutonomyJob,success:boolean,reason:string,elapsedMs=0,checkpoint:string|null=null):void {
    this.database.transaction(tx=>{const fresh=parse<AutonomyJob>(tx.get<Row>('SELECT record_json FROM autonomy_jobs WHERE id=?',job.id));if(!fresh||fresh.state!=='running')return;
      fresh.state=success?'completed':fresh.attempts>=autonomyLimits.maximumAttempts?'failed':'queued';fresh.reason=reason.slice(0,100);fresh.observedComputeMs+=Number.isFinite(elapsedMs)?Math.max(0,elapsedMs):0;fresh.checkpoint=checkpoint?.slice(0,1000)??fresh.checkpoint;fresh.nextAt=this.now()+Math.min(3600000,60000*2**fresh.attempts);fresh.updatedAt=this.time();this.saveJob(tx,fresh);});
  }
  defer(job:AutonomyJob,reason:string){this.database.transaction(tx=>{const fresh=parse<AutonomyJob>(tx.get<Row>('SELECT record_json FROM autonomy_jobs WHERE id=?',job.id));if(!fresh||fresh.state!=='queued')return;if(fresh.reason!=='budget_exhausted')fresh.reason=reason.slice(0,100);fresh.nextAt=Math.max(fresh.nextAt,this.now()+60000);fresh.updatedAt=this.time();this.saveJob(tx,fresh);});}
  cancel(job:AutonomyJob,reason:string){this.database.transaction(tx=>{const fresh=parse<AutonomyJob>(tx.get<Row>('SELECT record_json FROM autonomy_jobs WHERE id=?',job.id));if(!fresh||!['queued','running','blocked'].includes(fresh.state))return;fresh.state='cancelled';fresh.reason=reason.slice(0,100);fresh.updatedAt=this.time();this.saveJob(tx,fresh);});}
  block(job:AutonomyJob,reason:string){this.database.transaction(tx=>{const fresh=parse<AutonomyJob>(tx.get<Row>('SELECT record_json FROM autonomy_jobs WHERE id=?',job.id));if(!fresh||!['queued','running'].includes(fresh.state))return;fresh.state='blocked';fresh.reason=reason.slice(0,100);fresh.updatedAt=this.time();this.saveJob(tx,fresh);});}
  recover(){for(const scope of this.scopes())for(const job of this.jobs(scope))if(job.state==='running')this.finish(job,false,'interrupted_restart',0,job.checkpoint);}
  briefing(scope:AutonomyScope){const records=this.list(scope).sort((a,b)=>b.proposal.priority-a.proposal.priority||b.updatedAt.localeCompare(a.updatedAt));return {
    ready:records.filter(record=>record.state==='readyForReview').slice(0,3),outcomes:records.filter(record=>['retained','reverted'].includes(record.state)).slice(0,3),
    decisions:records.filter(record=>['blocked','investigating','proposed'].includes(record.state)).slice(0,3),rejected:records.filter(record=>record.state==='rejected').slice(0,2),
    budget:this.budget(scope),queued:this.jobs(scope).filter(job=>job.state==='queued').length};}
  briefingDigest(scope:AutonomyScope){return autonomyDigest(this.list(scope).map(record=>[record.id,record.revision]).sort());}
  prepareBriefing(scope:AutonomyScope):PreparedAutonomyBriefing {
    const view=this.briefing(scope),briefing:PreparedAutonomyBriefing={generatedAt:this.time(),sourceDigest:this.briefingDigest(scope),summary:[view.outcomes.length?`${view.outcomes.length} evaluated outcome(s): ${view.outcomes.map(record=>record.proposal.title).join('; ')}.`:'No new evaluated outcomes.',view.ready.length?`${view.ready.length} candidate(s) ready for review: ${view.ready.map(record=>record.proposal.title).join('; ')}.`:'No candidate requires review.',view.decisions.length?`Leading investigation: ${view.decisions[0]!.proposal.title}.`:'',view.rejected.length?`${view.rejected.length} rejected hypothesis/hypotheses retained to prevent repeated proposals.`:'',`${view.budget.calls} reflection call(s), ${view.budget.computeMs} ms reserved today; $${view.budget.totalCostUsd.toFixed(2)} reserved overall.`].filter(Boolean).join(' ').slice(0,2000),readyIds:view.ready.map(record=>record.id),outcomeIds:view.outcomes.map(record=>record.id),decisionIds:view.decisions.map(record=>record.id),rejectedIds:view.rejected.map(record=>record.id)};
    this.database.connection.prepare('INSERT INTO autonomy_briefings VALUES (?,?) ON CONFLICT(scope_key) DO UPDATE SET record_json=excluded.record_json').run(scopeKey(scope),JSON.stringify(briefing));return briefing;
  }
  preparedBriefing(scope:AutonomyScope):PreparedAutonomyBriefing|null {const value=parse<PreparedAutonomyBriefing>(this.database.connection.prepare('SELECT record_json FROM autonomy_briefings WHERE scope_key=?').get(scopeKey(scope)) as Row|undefined);return value?.sourceDigest===this.briefingDigest(scope)?value:null;}
}
