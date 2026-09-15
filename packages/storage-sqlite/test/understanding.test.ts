import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {Database} from "../src/database.ts";
import {UnderstandingRepository,understandingDigest,type UnderstandingRecord,type UnderstandingScope} from "../src/understanding.ts";
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
 const w=f.work();f.admit(w);f.repo.start(f.scope,String(w.workId));const parent=f.brief(),wanted={...f.candidate(parent),content:'Synthetic quartz calibration uses QTZ_MARKER_482.'};
 assert.equal(f.repo.publish(f.scope,String(w.workId),f.boundary,[parent,wanted],()=>true),true);
 const result=f.repo.select(f.scope,f.boundary,'Tell me about synthetic quartz.');assert.equal(result.length,1);assert.match(result[0]!.content,/QTZ_MARKER_482/);
 assert.match(f.repo.select(f.scope,f.boundary,'quartz unrepresentedword')[0]!.content,/QTZ_MARKER_482/,'ordinary optional wording retains the bounded union fallback');
 assert.deepEqual(f.repo.select({...f.scope,userId:randomUUID()},f.boundary,'synthetic quartz'),[]);
 assert.deepEqual(f.repo.select(f.scope,understandingDigest('old-boundary'),'synthetic quartz'),[]);
 f.advance(600001);assert.deepEqual(f.repo.select(f.scope,f.boundary,'synthetic quartz'),[]);
});
