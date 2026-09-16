import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadMigrations} from '../src/migrations/index.ts';
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {Database} from "../src/database.ts";
import {UnderstandingRepository,hypothesisFingerprint,understandingDigest,type UnderstandingRecord,type UnderstandingScope} from "../src/understanding.ts";
import {compileDiscoveryCandidates} from '../../../apps/server/src/admin/discovery-candidates.ts';
import {extensionSettings} from "../../../tests/fixtures/extension-settings.ts";

function fixture(){
 const db=new Database({path:":memory:"});db.migrate();let now=Date.now();
 const repo=new UnderstandingRepository(db,()=>now),scope:UnderstandingScope={assistantId:randomUUID(),userId:randomUUID(),relationshipId:randomUUID(),deploymentId:randomUUID()},boundary=understandingDigest("current");
 const work=(key=randomUUID()):UnderstandingRecord=>({...scope,schemaVersion:"1.0.0",recordType:"work",workId:randomUUID(),revision:1,topicRef:"topic:quartz",purpose:"briefRebuild",state:"queued",executionMode:"normal",idempotencyKey:key,configurationRef:"config:1",policyRefs:["policy:synthetic"],dependencyRefs:["source:synthetic:1"],capabilityInvocationRef:null,admissionReceiptRef:null,createdAt:new Date(now).toISOString(),deadlineAt:new Date(now+120000).toISOString(),expiresAt:new Date(now+86400000).toISOString(),budget:extensionSettings.understanding.budget,producedRefs:[],lastOutcome:"notRun",reason:"Synthetic preparation"});
 const brief=():UnderstandingRecord=>({...scope,schemaVersion:"1.0.0",recordType:"topicBrief",briefId:randomUUID(),revision:1,topicRef:"topic:quartz",derived:true,status:"prepared",sources:[{sourceRef:"source:synthetic",sourceFamily:"family:synthetic",sourceRevision:"revision:1",policyRef:"policy:synthetic",retrievedAt:new Date(now).toISOString(),reliability:"unknown",reliabilityBasis:"Synthetic test source",kind:"providedFixture"}],claims:[{claimId:randomUUID(),text:"Quartz calibration uses QTZ_MARKER_482.",sourceRefs:["source:synthetic"],qualifier:"attributed",versionScope:"synthetic",spoilerClass:"none",contradictionRefs:[]}],aliasClaims:[],knowledgeGaps:[],deeperMaterialRefs:[],builtAt:new Date(now).toISOString(),freshUntil:new Date(now+3600000).toISOString(),compilerRef:"compiler:synthetic:1",dependencyRefs:["source:synthetic:1"],configurationRef:"config:1"});
 const candidate=(parent:UnderstandingRecord):UnderstandingRecord=>({...scope,schemaVersion:'1.0.0',recordType:'candidate',candidateId:randomUUID(),revision:1,kind:'discovery',status:'proposed',content:'Quartz calibration uses QTZ_MARKER_482.',topicRefs:['topic:quartz'],groundingRefs:[`topic-brief:${parent.briefId}:1`],hypothesisRefs:[],alternatives:[],limitations:['Synthetic attributed source'],contextRef:`snapshot:${boundary}`,builtAt:new Date(now).toISOString(),expiresAt:new Date(now+600000).toISOString(),configurationRef:'config:1',dependencyRefs:[`topic-brief:${parent.briefId}:1`],scores:{interestStrength:null,evidenceConfidence:null,sourceCoverage:null,knowledgeCoverage:null,knowledgeReliability:null,expectedUsefulness:null,novelty:null,repetitionRisk:null,researchCost:0,resourcePressure:null,methodRef:'synthetic:1',limitations:[]},confersAuthority:false});
 const admit=(w:UnderstandingRecord)=>repo.admit(scope,w,understandingDigest(w.idempotencyKey),understandingDigest([w.idempotencyKey,boundary]),boundary,()=>true);
 return {db,repo,scope,boundary,work,brief,candidate,admit,advance:(ms:number)=>{now+=ms;}};
}

test("Discovery publication is atomic, scope-bound and denied after cancellation",t=>{
 const f=fixture();t.after(()=>f.db.close());const w=f.work();f.admit(w);assert.equal(f.repo.start(f.scope,String(w.workId)),true);
 const other={...f.scope,userId:randomUUID()};assert.equal(f.repo.work(other,String(w.workId)),undefined);
 assert.throws(()=>f.repo.publish(f.scope,String(w.workId),f.boundary,[{...f.brief(),...other}],()=>true),/Cross-scope/);
 assert.equal(f.repo.publish(f.scope,String(w.workId),f.boundary,[f.brief()],()=>false),false);
 const duplicate=f.brief();assert.throws(()=>f.repo.publish(f.scope,String(w.workId),f.boundary,[duplicate,duplicate],()=>true),/UNIQUE/);
 assert.equal(f.repo.select(f.scope,f.boundary,"quartz").length,0,"partial insert and FTS entry both rolled back");
 assert.equal(f.repo.work(f.scope,String(w.workId))?.state,"running");
 const request=understandingDigest("cancel"),cancelled=f.repo.cancel(f.scope,String(w.workId),2,"retry",request);
 assert.equal(cancelled.state,"cancelled");assert.deepEqual(f.repo.cancel(f.scope,String(w.workId),2,"retry",request),cancelled);
 assert.throws(()=>f.repo.cancel(f.scope,String(w.workId),2,"retry",understandingDigest("different")),/conflict/);
 assert.equal(f.repo.publish(f.scope,String(w.workId),f.boundary,[f.brief()],()=>true),false);
});

test("Discovery lookup and expiry preserve scope isolation and minimal replay receipts",t=>{
 const f=fixture();t.after(()=>f.db.close());const w=f.work();f.admit(w);f.repo.start(f.scope,String(w.workId));const parent=f.brief();assert.equal(f.repo.publish(f.scope,String(w.workId),f.boundary,[parent,f.candidate(parent)],()=>true),true);
 assert.equal(f.repo.select(f.scope,f.boundary,"quartz").length,1);
 assert.equal(f.repo.select({...f.scope,deploymentId:randomUUID()},f.boundary,"quartz").length,0);
 assert.equal(f.repo.select(f.scope,understandingDigest("changed"),"quartz").length,0);
 f.advance(3600001);assert.equal(f.repo.select(f.scope,f.boundary,"quartz").length,0);f.repo.cleanupExpired();
 assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM understanding_projection").get()!.n,0);
 f.advance(86400000);f.repo.cleanupExpired();assert.equal(f.repo.work(f.scope,String(w.workId)),undefined);
 assert.throws(()=>f.admit(f.work(String(w.idempotencyKey))),/expired receipt/);
 assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM understanding_work").get()!.n,1,"hashed admission retained without source payload");
});

test("Discovery restart cancels unfinished work and keeps failed admissions charged",t=>{
 const f=fixture();t.after(()=>f.db.close());const w=f.work();w.budget={...extensionSettings.understanding.budget,jobsPerDay:1};f.admit(w);f.repo.start(f.scope,String(w.workId));f.repo.recover();
 assert.equal(f.repo.work(f.scope,String(w.workId))?.state,"cancelled");
 const next=f.work();next.budget=w.budget;assert.throws(()=>f.admit(next),/budget exhausted/);
 assert.equal(f.repo.publish(f.scope,String(w.workId),f.boundary,[f.brief()],()=>true),false);
});

test('specific multi-term Discovery matches survive more than 32 common-word candidates without widening scope',t=>{
 const f=fixture();t.after(()=>f.db.close());
 for(let batch=0;batch<6;batch++){
  const w=f.work();w.topicRef='topic:archive';f.admit(w);f.repo.start(f.scope,String(w.workId));
  const parent={...f.brief(),topicRef:'topic:archive',claims:[{claimId:randomUUID(),text:'Synthetic archive material.',sourceRefs:['source:synthetic'],qualifier:'attributed',versionScope:'synthetic',spoilerClass:'none',contradictionRefs:[]}]};
  const candidates=Array.from({length:7},()=>({...f.candidate(parent),content:'Synthetic archive material.',topicRefs:['topic:archive']}));
  assert.equal(f.repo.publish(f.scope,String(w.workId),f.boundary,[parent,...candidates],()=>true),true);
 }
 const w=f.work();f.admit(w);f.repo.start(f.scope,String(w.workId));const parent=f.brief(),wanted={...f.candidate(parent),content:'Synthetic quartz calibration uses QTZ_MARKER_482.'};(parent.claims as Record<string,unknown>[])[0]!.text=wanted.content;
 assert.equal(f.repo.publish(f.scope,String(w.workId),f.boundary,[parent,wanted],()=>true),true);
 const result=f.repo.select(f.scope,f.boundary,'Tell me about synthetic quartz.');assert.equal(result.length,1);assert.match(result[0]!.content,/QTZ_MARKER_482/);
 assert.match(f.repo.select(f.scope,f.boundary,'quartz unrepresentedword')[0]!.content,/QTZ_MARKER_482/,'ordinary optional wording retains the bounded union fallback');
 assert.deepEqual(f.repo.select({...f.scope,userId:randomUUID()},f.boundary,'synthetic quartz'),[]);
 assert.deepEqual(f.repo.select(f.scope,understandingDigest('old-boundary'),'synthetic quartz'),[]);
 f.advance(600001);assert.deepEqual(f.repo.select(f.scope,f.boundary,'synthetic quartz'),[]);
});

test('candidate selection compares named dimensions while leaving unknown scores neutral',t=>{
 const f=fixture();t.after(()=>f.db.close());const w=f.work();f.admit(w);f.repo.start(f.scope,String(w.workId));const parent=f.brief();
 const base=()=>({...f.candidate(parent),kind:'question' as const,scores:{interestStrength:null,evidenceConfidence:null,sourceCoverage:null,knowledgeCoverage:null,knowledgeReliability:null,expectedUsefulness:null,novelty:null,repetitionRisk:null,researchCost:0,resourcePressure:null,methodRef:'synthetic:question',limitations:[]}});
 const low={...base(),content:'Quartz low usefulness detail.',scores:{...base().scores,expectedUsefulness:0.1}};
 const high={...base(),content:'Quartz high usefulness detail.',scores:{...base().scores,expectedUsefulness:0.9}};
 const unknown={...base(),content:'Quartz unknown usefulness detail.'};
 assert.equal(f.repo.publish(f.scope,String(w.workId),f.boundary,[parent,low,high,unknown],()=>true),true);
 const selected=f.repo.select(f.scope,f.boundary,'Tell me about quartz');assert.deepEqual(selected.map(item=>item.content),['topic:quartz: Optional tentative question: Quartz high usefulness detail. [optional; grants no authority]','topic:quartz: Optional tentative question: Quartz low usefulness detail. [optional; grants no authority]','topic:quartz: Optional tentative question: Quartz unknown usefulness detail. [optional; grants no authority]']);
});

test('hypothesis rejection invalidates every pinned candidate derivative in the owner transaction',t=>{
 const f=fixture();t.after(()=>f.db.close());const w=f.work(),now=Date.now(),hypothesis:UnderstandingRecord={...f.scope,schemaVersion:'1.0.0',recordType:'hypothesis',hypothesisId:randomUUID(),revision:1,epistemicStatus:'tentative',status:'candidate',topicRefs:['topic:alpha','topic:beta'],explanations:[
  {explanationId:randomUUID(),summary:'Making may matter.',traitRefs:['trait:making'],supportEvidenceRefs:['evidence:alpha'],counterEvidenceRefs:['evidence:counter-alpha'],boundary:'Only the supplied context.'},
  {explanationId:randomUUID(),summary:'Progress may matter.',traitRefs:['trait:making'],supportEvidenceRefs:['evidence:beta'],counterEvidenceRefs:['evidence:counter-beta'],boundary:'No broader motive is established.'}
 ],unknownAlternative:'Another explanation may apply.',sourceCoverage:'partial',uncertainty:'The motive is not established.',dependencyRefs:['evidence:alpha','evidence:beta'],createdAt:new Date(now).toISOString(),configurationRef:'config:1'};
 f.admit(w);f.repo.start(f.scope,String(w.workId));const derivatives=compileDiscoveryCandidates(hypothesis,f.boundary,now);assert.ok(derivatives.some(record=>record.kind==='question'));assert.ok(derivatives.some(record=>record.kind==='connection'));assert.equal(f.repo.publish(f.scope,String(w.workId),f.boundary,[hypothesis,...derivatives],()=>true),true);assert.ok(f.repo.select(f.scope,f.boundary,'alpha beta').length>0);
 f.db.transaction(tx=>f.repo.applyHypothesisRejection(tx,f.scope,{hypothesisId:String(hypothesis.hypothesisId),fingerprint:hypothesisFingerprint(hypothesis),expectedRevision:1},'reject-hypothesis',understandingDigest('reject-hypothesis')));
 assert.equal(f.repo.select(f.scope,f.boundary,'alpha beta').length,0);const records=f.repo.list(f.scope,f.boundary),parent=records.find(record=>record.recordType==='hypothesis');assert.equal(parent?.status,'rejected');assert.ok(records.filter(record=>record.recordType==='candidate').every(record=>record.status==='invalidated'));
});

test('Discovery exploration reserves daily slots for less-covered approved topics without refunding failures or retries',t=>{
 const f=fixture();t.after(()=>f.db.close());
 const policy={share:0.5,approvedTopicRefs:['topic:quartz','topic:basalt']};
 const work=(topic:string)=>({...f.work(),topicRef:topic,budget:{...extensionSettings.understanding.budget,jobsPerDay:4}});
 const admit=(w:UnderstandingRecord,p=policy)=>f.repo.admit(f.scope,w,understandingDigest(w.idempotencyKey),understandingDigest(w.idempotencyKey),f.boundary,()=>true,p);
 const first=work('topic:quartz');admit(first);f.repo.finish(f.scope,String(first.workId),'failed','synthetic failure');
 assert.equal(admit(first).replay,true);
 const second=work('topic:quartz');admit(second);f.repo.recover();
 assert.throws(()=>admit(work('topic:quartz')),/reserved for less-covered/);
 assert.throws(()=>admit(work('topic:unapproved')),/reserved for less-covered/);
 assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM understanding_work').get()!.n,2,'rejection and retry do not consume another job');
 admit(work('topic:basalt'));assert.throws(()=>admit(work('topic:quartz')),/reserved for less-covered/);
 admit(work('topic:basalt'));assert.throws(()=>admit(work('topic:basalt')),/budget exhausted/);
 f.advance(86400001);admit(work('topic:quartz'));
});

test('Discovery exploration is bounded, owner-local, and cannot reconstruct erased coverage',t=>{
 const f=fixture();t.after(()=>f.db.close());const policy={share:0.5,approvedTopicRefs:['topic:quartz','topic:basalt']};
 const work=()=>({...f.work(),budget:{...extensionSettings.understanding.budget,jobsPerDay:2}});
 const admit=(w:UnderstandingRecord,p=policy)=>f.repo.admit(f.scope,w,understandingDigest(w.idempotencyKey),understandingDigest(w.idempotencyKey),f.boundary,()=>true,p);
 for(const share of [-1,0.51,NaN])assert.throws(()=>admit(work(),{...policy,share}),/Invalid exploration/);
 const original=work();admit(original);
 const foreign={...work(),userId:randomUUID()};assert.equal(f.repo.admit(foreign,foreign,understandingDigest('foreign'),understandingDigest('foreign'),f.boundary,()=>true,policy).replay,false);
 f.repo.purge(f.scope.relationshipId);
 assert.throws(()=>admit({...work(),topicRef:'topic:basalt'}),/coverage unavailable/);
 // With no competing eligible approved topic, the unused reserve is released.
 assert.equal(admit(work(),{share:0.5,approvedTopicRefs:['topic:quartz']}).replay,false);
});

test('Discovery exploration rounding never exceeds its share and supports the full configured topic bound',t=>{
 for(const share of [0,0.2]){
  const f=fixture();t.after(()=>f.db.close());
  const policy={share,approvedTopicRefs:Array.from({length:256},(_,index)=>`topic:${index}`)};
  for(let index=0;index<3;index++){
   const w={...f.work(),budget:{...extensionSettings.understanding.budget,jobsPerDay:3}};
   assert.equal(f.repo.admit(f.scope,w,understandingDigest(w.idempotencyKey),understandingDigest(w.idempotencyKey),f.boundary,()=>true,policy).replay,false);
  }
 }
});

test('Discovery input keeps exact source version, uncertainty and contradiction notes without changing candidate identity',t=>{
 const f=fixture();t.after(()=>f.db.close());const w=f.work();f.admit(w);f.repo.start(f.scope,String(w.workId));
 const parent=f.brief(),claim=(parent.claims as Record<string,unknown>[])[0]!;
 claim.qualifier='contradicted';claim.versionScope='synthetic edition 2';claim.contradictionRefs=['claim:conflicting-source'];
 (parent.sources as Record<string,unknown>[])[0]!.reliability='low';
 const candidate=f.candidate(parent),before=structuredClone(candidate);
 assert.equal(f.repo.publish(f.scope,String(w.workId),f.boundary,[parent,candidate],()=>true),true);
 const content=f.repo.select(f.scope,f.boundary,'quartz')[0]!.content;
 assert.match(content,/contradicted; version: synthetic edition 2/);
 assert.match(content,/declared reliability: source:synthetic=low/);
 assert.match(content,/contradictions: claim:conflicting-source/);
 assert.deepEqual(candidate,before,'source qualification must not change suppression identity');
 assert.deepEqual(f.repo.list(f.scope,f.boundary).find(r=>r.candidateId===candidate.candidateId),before);
});

test('unresolved claim grounding cannot enter Discovery context as an unqualified fact',t=>{
 const f=fixture();t.after(()=>f.db.close());const w=f.work();f.admit(w);f.repo.start(f.scope,String(w.workId));
 const parent=f.brief(),candidate={...f.candidate(parent),content:'Quartz ungrounded assertion.'};
 assert.equal(f.repo.publish(f.scope,String(w.workId),f.boundary,[parent,candidate],()=>true),true);
 assert.deepEqual(f.repo.select(f.scope,f.boundary,'quartz'),[]);
 assert.ok(f.repo.list(f.scope,f.boundary).some(r=>r.candidateId===candidate.candidateId),'retain the record for inspection without usable context');
});

test('pre-qualification databases withhold legacy context until bounded source-note repair without rewriting records',t=>{
 const directory=mkdtempSync(join(tmpdir(),'ls-source-notes-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const f=fixture(),parent=f.brief(),candidate=f.candidate(parent);f.db.close();
 const path=join(directory,'legacy.sqlite'),old=new Database({path,migrations:loadMigrations().filter(m=>m.id<40)}),before=old.migrate();
 const key=understandingDigest([f.scope.assistantId,f.scope.userId,f.scope.relationshipId,f.scope.deploymentId]);
 for(const record of [parent,candidate])old.connection.prepare('INSERT INTO understanding_artifacts VALUES (?,?,?,?,?,?,?,?,?)').run(String(record.briefId??record.candidateId),key,f.scope.relationshipId,f.boundary,1,String(record.recordType),'topic:quartz',Date.parse(String(record.freshUntil??record.expiresAt)),JSON.stringify(record));
 old.connection.prepare('INSERT INTO understanding_projection(artifact_id,scope_key,boundary,content,fresh_until_ms) VALUES (?,?,?,?,?)').run(String(candidate.candidateId),key,f.boundary,String(candidate.content),Date.parse(String(candidate.expiresAt)));old.close();
 const db=new Database({path});t.after(()=>db.close());const migrations=db.migrate();assert.deepEqual(migrations.slice(0,before.length),before);assert.equal(migrations.at(-1)!.id,40);
 const repo=new UnderstandingRepository(db);assert.deepEqual(repo.select(f.scope,f.boundary,'quartz'),[],'legacy text cannot silently pass as qualified source input');
 repo.recover();const input=repo.select(f.scope,f.boundary,'quartz');assert.equal(input.length,1);assert.match(input[0]!.content,/Source notes: attributed; version: synthetic/);
 assert.deepEqual(repo.list(f.scope,f.boundary).find(r=>r.candidateId===candidate.candidateId),candidate);
 assert.deepEqual(repo.list(f.scope,f.boundary).find(r=>r.briefId===parent.briefId),parent);
});

test('source qualifications cannot be silently truncated to fit optional projection bounds',t=>{
 const f=fixture();t.after(()=>f.db.close());const w=f.work();f.admit(w);f.repo.start(f.scope,String(w.workId));
 const parent=f.brief(),source=(parent.sources as Record<string,unknown>[])[0]!,refs=Array.from({length:4},(_,i)=>`source:${i}:`+'x'.repeat(990));
 parent.sources=refs.map(ref=>({...source,sourceRef:ref}));
 (parent.claims as Record<string,unknown>[])[0]!.sourceRefs=refs;
 (parent.claims as Record<string,unknown>[])[0]!.versionScope='v'.repeat(500);
 const candidate=f.candidate(parent);assert.equal(f.repo.publish(f.scope,String(w.workId),f.boundary,[parent,candidate],()=>true),true);
 assert.deepEqual(f.repo.select(f.scope,f.boundary,'quartz'),[],'withhold oversized qualified content rather than dropping its caveats');
});
