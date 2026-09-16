import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { createContractValidator } from "@lifestream/contracts";
import { Database } from "../src/database.ts";
import { loadMigrations } from "../src/migrations/index.ts";
import { InitiativeDeliveryRepository, type InitiativeScope, type InitiativeOpportunity, type InitiativeDeliveryRecord, type InitiativeDeliveryAction } from "../src/initiative-delivery.ts";

const scope:InitiativeScope={assistantId:randomUUID(),userId:randomUUID(),relationshipId:randomUUID(),deploymentId:randomUUID()};
const sessionId=randomUUID(),configurationId=randomUUID(),endpointId=randomUUID(),conversationId=randomUUID();
const start=Date.parse("2026-09-14T12:00:00Z"),limits={perHour:2,perDay:8,minimumGapMs:120_000},current=()=>true;
function fixture(){const database=new Database({path:":memory:"});database.migrate();let time=start;return {database,ledger:new InitiativeDeliveryRepository(database,()=>time),now:()=>time,advance:(ms:number)=>{time+=ms;}};}
function opportunity(now:number,overrides:Partial<InitiativeOpportunity>={}):InitiativeOpportunity{return {schemaVersion:"1.0.0",recordType:"opportunity",...scope,opportunityId:randomUUID(),correlationId:randomUUID(),conversationId,sessionId,endpointId,configurationId,configurationRevision:1,policyRevision:"synthetic-policy:1",kind:"availableCheckIn",category:"social",urgency:"low",sourceKind:"runtimeContext",sourceRefs:["synthetic-source:1"],executionMode:"simulation",observedAt:new Date(now).toISOString(),receivedAt:new Date(now).toISOString(),expiresAt:new Date(now+300_000).toISOString(),dedupKey:randomUUID(),topicKey:randomUUID(),...overrides};}
function change(ledger:InitiativeDeliveryRepository,record:InitiativeDeliveryRecord,action:InitiativeDeliveryAction){return ledger.transition(scope,record.opportunity.opportunityId,record.version,action);}
function generate(ledger:InitiativeDeliveryRepository,item:InitiativeOpportunity){let r=ledger.admit(scope,item,current);r=change(ledger,r,{type:"eligible"});return change(ledger,r,{type:"generated",preparedViewId:randomUUID(),interactionId:randomUUID()});}
function queue(ledger:InitiativeDeliveryRepository,item:InitiativeOpportunity){return change(ledger,generate(ledger,item),{type:"queue",limits,current});}
function emit(ledger:InitiativeDeliveryRepository,r:InitiativeDeliveryRecord,receiptId=randomUUID()){r=change(ledger,r,{type:"beginEmission",receiptId,current});return {record:change(ledger,r,{type:"emitted",receiptId}),receiptId};}
const schema=createContractValidator();

test("S083 lifecycle: actual emission, endpoint acceptance and playback are separate; response is orthogonal",()=>{
 const f=fixture();try{
  let r=queue(f.ledger,opportunity(f.now()));assert.equal(r.outcome.lastDeliveryStage,"queued");assert.equal(r.budget,"held");
  const receiptId=randomUUID();r=change(f.ledger,r,{type:"beginEmission",receiptId,current});assert.equal(r.outcome.state,"queued");assert.equal(r.outcome.deliveryReceiptRef,null);assert.equal(r.budget,"charged");
  assert.throws(()=>change(f.ledger,r,{type:"acknowledge",sessionId,receiptId,kind:"endpointAccepted"}),/transition/u);
  r=change(f.ledger,r,{type:"emitted",receiptId});
  for(const wrong of [{sessionId:randomUUID(),receiptId},{sessionId,receiptId:randomUUID()}])assert.throws(()=>change(f.ledger,r,{type:"acknowledge",...wrong,kind:"endpointAccepted"}),/acknowledgment/u);
  r=change(f.ledger,r,{type:"acknowledge",sessionId,receiptId,kind:"endpointAccepted"});assert.equal(r.outcome.acknowledgmentKind,"endpointAccepted");assert.equal(r.outcome.response,"notObserved");
  r=change(f.ledger,r,{type:"acknowledge",sessionId,receiptId,kind:"playbackCompleted"});assert.equal(r.outcome.response,"notObserved");assert.equal(r.outcome.lastDeliveryStage,"acknowledged");
  assert.throws(()=>change(f.ledger,r,{type:"acknowledge",sessionId,receiptId,kind:"endpointAccepted"}),/regress/u);
  r=change(f.ledger,r,{type:"respond",sessionId,response:"noResponse"});assert.equal(r.outcome.acknowledgmentKind,"playbackCompleted");
  r=change(f.ledger,r,{type:"respond",sessionId,response:"replied"});assert.equal(r.outcome.state,"acknowledged");
  assert.equal(schema.validate("https://lifestream.dev/contracts/relational-initiative/1.0.0#/$defs/RelationalInitiativeOutcome",r.outcome).valid,true);
  const raw=f.database.connection.prepare("SELECT opportunity_json,outcome_json FROM initiative_delivery").get()!;
  assert.equal(JSON.stringify(raw).includes('userInput'),false);assert.equal(JSON.stringify(raw).includes('candidateText'),false);
 }finally{f.database.close();}
});

test("S083 cancellation refunds only unissued output, preserves partial emission and never retries",()=>{
 const f=fixture();try{
  const item=opportunity(f.now());let r=queue(f.ledger,item);
  r=change(f.ledger,r,{type:"finish",state:"cancelled",reasons:["userTurn"]});assert.equal(r.outcome.lastDeliveryStage,"queued");assert.equal(r.budget,"released");
  f.advance(1);r=queue(f.ledger,opportunity(f.now(),{topicKey:item.topicKey}));const sent=emit(f.ledger,r);r=sent.record;
  r=change(f.ledger,r,{type:"finish",state:"cancelled",reasons:["leaseLost"]});assert.equal(r.outcome.lastDeliveryStage,"emitted");assert.equal(r.outcome.deliveryReceiptRef,sent.receiptId);assert.equal(r.budget,"charged");
  assert.throws(()=>change(f.ledger,r,{type:"queue",limits,current}),/transition/u);
  assert.throws(()=>change(f.ledger,r,{type:"acknowledge",sessionId,receiptId:sent.receiptId,kind:"playbackCompleted"}),/transition/u);
  f.advance(120_000);assert.throws(()=>f.ledger.admit(scope,opportunity(f.now(),{topicKey:item.topicKey,endpointId:randomUUID(),configurationId:randomUUID()}),current),/Unanswered/u);
  const same=f.ledger.get(scope,r.opportunity.opportunityId)!;assert.equal(same.outcome.response,"notObserved");
  change(f.ledger,same,{type:"respond",sessionId,response:"replied"});f.ledger.admit(scope,opportunity(f.now(),{topicKey:item.topicKey}),current);
 }finally{f.database.close();}
});

test("S083 receipt observations remain recordable after source expiry without authorizing new output",()=>{
 const f=fixture();try{
  let r=queue(f.ledger,opportunity(f.now()));const receiptId=randomUUID();r=change(f.ledger,r,{type:"beginEmission",receiptId,current});
  f.advance(300_001);r=change(f.ledger,r,{type:"emitted",receiptId});r=change(f.ledger,r,{type:"acknowledge",sessionId,receiptId,kind:"endpointAccepted"});assert.equal(r.outcome.acknowledgmentKind,"endpointAccepted");
 }finally{f.database.close();}
});

test("S083 stage and schema violations roll back without releasing budgets or mutating records",()=>{
 const f=fixture();try{
  let r=f.ledger.admit(scope,opportunity(f.now()),current);
  assert.throws(()=>change(f.ledger,r,{type:"generated",preparedViewId:randomUUID(),interactionId:randomUUID()}),/transition/u);
  assert.throws(()=>change(f.ledger,r,{type:"respond",sessionId,response:"replied"}),/No emitted/u);
  r=change(f.ledger,r,{type:"eligible"});assert.throws(()=>change(f.ledger,r,{type:"generated",preparedViewId:"not-a-view",interactionId:randomUUID()}),/Invalid Initiative record/u);
  r=change(f.ledger,r,{type:"generated",preparedViewId:randomUUID(),interactionId:randomUUID()});r=change(f.ledger,r,{type:"queue",limits,current});
  assert.throws(()=>change(f.ledger,r,{type:"finish",state:"unknown",reasons:["ackTimeout"]}),/transition/u);
  assert.throws(()=>change(f.ledger,r,{type:"finish",state:"cancelled",reasons:["inventedReason"]}),/Invalid Initiative record/u);
  assert.deepEqual(f.ledger.get(scope,r.opportunity.opportunityId),r);
  assert.throws(()=>change(f.ledger,r,{type:"beginEmission",receiptId:randomUUID(),current:()=>false}),/boundary changed/u);
  assert.deepEqual(f.ledger.get(scope,r.opportunity.opportunityId),r);
 }finally{f.database.close();}
});

test("S083 durable write failure never returns permission to emit",()=>{
 const f=fixture();try{
  const r=queue(f.ledger,opportunity(f.now()));f.database.exec("CREATE TRIGGER fail_emission BEFORE UPDATE OF emission_started ON initiative_delivery WHEN NEW.emission_started=1 BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;");
  assert.throws(()=>change(f.ledger,r,{type:"beginEmission",receiptId:randomUUID(),current}),/storage failure/u);
  assert.deepEqual(f.ledger.get(scope,r.opportunity.opportunityId),r);
  f.database.exec("DROP TRIGGER fail_emission");const attempted=change(f.ledger,r,{type:"beginEmission",receiptId:randomUUID(),current});
  assert.throws(()=>change(f.ledger,attempted,{type:"beginEmission",receiptId:randomUUID(),current}),/emission admission/u);
  const stopped=change(f.ledger,attempted,{type:"finish",state:"failed",reasons:["outputFailed"]});assert.equal(stopped.budget,"charged");assert.equal(stopped.outcome.lastDeliveryStage,"queued");assert.equal(stopped.outcome.deliveryReceiptRef,null);
 }finally{f.database.close();}
});

test("S083 restart at every durable stage prevents backlog and preserves exact observed progress",()=>{
 for(const stage of ["pending","eligible","generated","queued","intent","emitted","accepted","playback"]){
  const directory=mkdtempSync(join(tmpdir(),"initiative-restart-")),path=join(directory,"db.sqlite");let db=new Database({path});db.migrate();
  try{
   let ledger=new InitiativeDeliveryRepository(db,()=>start),r=ledger.admit(scope,opportunity(start),current);const receiptId=randomUUID();
   if(stage!=="pending")r=change(ledger,r,{type:"eligible"});
   if(!["pending","eligible"].includes(stage))r=change(ledger,r,{type:"generated",preparedViewId:randomUUID(),interactionId:randomUUID()});
   if(!["pending","eligible","generated"].includes(stage))r=change(ledger,r,{type:"queue",limits,current});
   if(["intent","emitted","accepted","playback"].includes(stage))r=change(ledger,r,{type:"beginEmission",receiptId,current});
   if(["emitted","accepted","playback"].includes(stage))r=change(ledger,r,{type:"emitted",receiptId});
   if(["accepted","playback"].includes(stage))r=change(ledger,r,{type:"acknowledge",sessionId,receiptId,kind:stage==="accepted"?"endpointAccepted":"playbackCompleted"});
   db.close();db=new Database({path});db.migrate();ledger=new InitiativeDeliveryRepository(db,()=>start+1);ledger.recover();
   const restored=ledger.get(scope,r.opportunity.opportunityId)!;
   assert.equal(restored.outcome.lastDeliveryStage,r.outcome.lastDeliveryStage,stage);
   assert.equal(restored.outcome.state,stage==="emitted"?"unknown":stage==="intent"?"failed":["accepted","playback"].includes(stage)?"acknowledged":"expired",stage);
   assert.equal(restored.budget,stage==="queued"?"released":r.budget,stage);
   assert.equal(restored.outcome.response,"notObserved",stage);
   assert.throws(()=>ledger.admit(scope,r.opportunity,current),/already consumed/u);
   assert.throws(()=>change(ledger,restored,{type:"beginEmission",receiptId:randomUUID(),current}),/transition/u);
   assert.equal(ledger.recover(),0);
  }finally{db.close();rmSync(directory,{recursive:true,force:true});}
 }
});

test("S083 independent SQLite clients serialize scope isolation, revisions, budgets and receipt identity",()=>{
 const directory=mkdtempSync(join(tmpdir(),"initiative-concurrency-")),path=join(directory,"db.sqlite");const a=new Database({path}),b=new Database({path});a.migrate();b.migrate();let time=start;
 try{
  const first=new InitiativeDeliveryRepository(a,()=>time),second=new InitiativeDeliveryRepository(b,()=>time);
  let r=generate(first,opportunity(time));time++;
  const other=generate(second,opportunity(time));
  r=change(first,r,{type:"queue",limits:{...limits,perHour:1},current});
  assert.throws(()=>change(second,other,{type:"queue",limits:{...limits,perHour:1},current}),/budget exhausted/u);
  assert.equal(second.get({...scope,userId:randomUUID()},r.opportunity.opportunityId),undefined);
  assert.throws(()=>second.transition({...scope,userId:randomUUID()},r.opportunity.opportunityId,r.version,{type:"finish",state:"cancelled",reasons:["cancelled"]}),/Unknown/u);
  const stale=r;r=change(first,r,{type:"beginEmission",receiptId:randomUUID(),current});assert.throws(()=>change(second,stale,{type:"beginEmission",receiptId:randomUUID(),current}),/revision conflict/u);
  assert.equal(second.get(scope,r.opportunity.opportunityId)!.budget,"charged");
 }finally{a.close();b.close();rmSync(directory,{recursive:true,force:true});}
});

test("S083 opening ceilings, rolling windows, cooldown and conservative unknown charges",()=>{
 const f=fixture();try{
  let r=queue(f.ledger,opportunity(f.now()));r=emit(f.ledger,r).record;change(f.ledger,r,{type:"finish",state:"unknown",reasons:["ackTimeout"]});f.advance(1);
  const early=generate(f.ledger,opportunity(f.now()));assert.throws(()=>change(f.ledger,early,{type:"queue",limits,current}),/cooldown/u);
  f.advance(120_000);r=change(f.ledger,early,{type:"queue",limits,current});r=emit(f.ledger,r).record;change(f.ledger,r,{type:"finish",state:"unknown",reasons:["ackTimeout"]});
  f.advance(120_000);const full=generate(f.ledger,opportunity(f.now()));assert.throws(()=>change(f.ledger,full,{type:"queue",limits,current}),/budget exhausted/u);change(f.ledger,full,{type:"finish",state:"cancelled",reasons:["cancelled"]});
  f.advance(3_600_000);r=generate(f.ledger,opportunity(f.now()));assert.throws(()=>change(f.ledger,r,{type:"queue",limits:{...limits,perDay:2},current}),/budget exhausted/u);
  change(f.ledger,r,{type:"queue",limits,current});
 }finally{f.database.close();}
});

test("S083 admission bounds, source high-water, clock and unanswered metadata survive record pruning",()=>{
 const f=fixture();try{
  const item=opportunity(f.now());let r=queue(f.ledger,item);r=emit(f.ledger,r).record;change(f.ledger,r,{type:"finish",state:"unknown",reasons:["ackTimeout"]});
  assert.throws(()=>f.ledger.admit(scope,opportunity(f.now()),current),/already consumed/u);
  f.advance(-1);assert.throws(()=>f.ledger.resetSessionTopics(scope,sessionId),/clock discontinuity/u);f.advance(1);
  f.advance(86_400_001);f.ledger.prune();assert.equal(f.ledger.get(scope,item.opportunityId),undefined);
  assert.throws(()=>f.ledger.admit(scope,item,current),/Stale/u);
  assert.throws(()=>f.ledger.admit(scope,opportunity(f.now(),{topicKey:item.topicKey}),current),/Unanswered/u);
  assert.equal(f.database.connection.prepare("SELECT count(*) AS n FROM initiative_source_watermarks").get()!.n,1);
  f.ledger.resetSessionTopics(scope,sessionId);r=f.ledger.admit(scope,opportunity(f.now(),{topicKey:item.topicKey}),current,{perRelationship:1,perRuntime:1});
  f.advance(1);assert.throws(()=>f.ledger.admit(scope,opportunity(f.now()),current,{perRelationship:1,perRuntime:1}),/queue limit/u);
  assert.throws(()=>f.ledger.admit(scope,{...opportunity(f.now()),userId:randomUUID()},current),/scope/u);
  assert.throws(()=>f.ledger.admit(scope,opportunity(f.now()),()=>false),/boundary/u);
  assert.equal(f.ledger.list(scope).length,1);assert.equal(r.outcome.state,"pending");
 }finally{f.database.close();}
});

test("S083 expiry frees queue capacity but cannot reissue uncertain output or replay",()=>{
 const f=fixture();try{
  let r=queue(f.ledger,opportunity(f.now()));r=change(f.ledger,r,{type:"beginEmission",receiptId:randomUUID(),current});
  f.advance(300_001);assert.equal(f.ledger.expirePending(),1);const closed=f.ledger.get(scope,r.opportunity.opportunityId)!;
  assert.equal(closed.outcome.state,"failed");assert.equal(closed.outcome.lastDeliveryStage,"queued");assert.equal(closed.budget,"charged");assert.equal(f.ledger.expirePending(),0);
  let replay=generate(f.ledger,opportunity(f.now(),{executionMode:"replay"}));replay=change(f.ledger,replay,{type:"queue",limits,current});
  assert.throws(()=>change(f.ledger,replay,{type:"beginEmission",receiptId:randomUUID(),current}),/emission admission/u);
  f.advance(300_001);assert.equal(f.ledger.expirePending(),1);assert.equal(f.ledger.get(scope,replay.opportunity.opportunityId)!.budget,"released");
 }finally{f.database.close();}
});

test("S083 transaction rollback protects source cursor and budget when issuance fails",()=>{
 const f=fixture();try{
  const item=opportunity(f.now());f.database.exec("CREATE TRIGGER fail_admission BEFORE INSERT ON initiative_delivery BEGIN SELECT RAISE(ABORT,'admission unavailable'); END;");
  assert.throws(()=>f.ledger.admit(scope,item,current),/admission unavailable/u);assert.equal(f.database.connection.prepare("SELECT count(*) AS n FROM initiative_source_watermarks").get()!.n,0);
  f.database.exec("DROP TRIGGER fail_admission");const first=emit(f.ledger,queue(f.ledger,item));change(f.ledger,first.record,{type:"finish",state:"unknown",reasons:["ackTimeout"]});
  f.advance(120_000);const next=queue(f.ledger,opportunity(f.now()));
  assert.throws(()=>change(f.ledger,next,{type:"beginEmission",receiptId:first.receiptId,current}),/UNIQUE/u);
  assert.deepEqual(f.ledger.get(scope,next.opportunity.opportunityId),next);
 }finally{f.database.close();}
});

test("S083 simultaneous workers admit one occurrence through the durable SQLite gate",{timeout:15_000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),"initiative-race-")),path=join(directory,"db.sqlite"),db=new Database({path});db.migrate();db.close();
 const source=`import {parentPort,workerData} from 'node:worker_threads';
 import {Database} from ${JSON.stringify(new URL("../src/database.ts",import.meta.url).href)};
 import {InitiativeDeliveryRepository} from ${JSON.stringify(new URL("../src/initiative-delivery.ts",import.meta.url).href)};
 const database=new Database({path:workerData.path});const ledger=new InitiativeDeliveryRepository(database,()=>workerData.now);
 parentPort.once('message',()=>{try{ledger.admit(workerData.scope,workerData.item,()=>true);parentPort.postMessage({admitted:true});}catch{parentPort.postMessage({admitted:false});}finally{database.close();}});parentPort.postMessage('ready');`;
 const item=opportunity(start),workers=[0,1].map(()=>new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`),{workerData:{path,scope,item,now:start}}));
 try{
  await Promise.all(workers.map(w=>once(w,"message")));const results=workers.map(w=>once(w,"message"));workers.forEach(w=>w.postMessage("start"));
  const outcomes=await Promise.all(results);assert.equal(outcomes.filter(([x])=>x.admitted).length,1);
  const readback=new Database({path});try{assert.equal(new InitiativeDeliveryRepository(readback).list(scope).length,1);}finally{readback.close();}
 }finally{await Promise.all(workers.map(w=>w.terminate()));rmSync(directory,{recursive:true,force:true});}
});

const inferenceLimits={perRelationshipHour:12,perRuntimeHour:24};
function eligible(ledger:InitiativeDeliveryRepository,item:InitiativeOpportunity){const r=ledger.admit(item,item,current);return ledger.transition(item,item.opportunityId,r.version,{type:"eligible"});}

test("S083 inference counts consumed calls independently of delivery, cancellation and rolling windows",()=>{
 const f=fixture();try{
  let r=eligible(f.ledger,opportunity(f.now()));const id=r.opportunity.opportunityId;
  const claim=f.ledger.reserveInference(scope,id,r.version,{perRelationshipHour:1,perRuntimeHour:2},current);
  assert.deepEqual(f.ledger.inferenceUsage(scope),{relationshipHour:1,runtimeHour:1,active:true});
  r=change(f.ledger,r,{type:"finish",state:"failed",reasons:["generationFailed"]});
  assert.equal(f.ledger.inferenceUsage(scope).active,true,"finishing an opportunity does not settle its provider");
  f.ledger.settleInference(scope,id,claim);f.ledger.settleInference(scope,id,claim);
  assert.deepEqual(f.ledger.inferenceUsage(scope),{relationshipHour:1,runtimeHour:1,active:false});
  f.advance(1);const other=eligible(f.ledger,opportunity(f.now()));
  assert.throws(()=>f.ledger.reserveInference(scope,other.opportunity.opportunityId,other.version,{perRelationshipHour:1,perRuntimeHour:2},current),/budget exhausted/u);
  f.advance(3_600_000);f.ledger.expirePending();const fresh=eligible(f.ledger,opportunity(f.now()));
  f.ledger.reserveInference(scope,fresh.opportunity.opportunityId,fresh.version,{perRelationshipHour:1,perRuntimeHour:2},current);
  assert.deepEqual(f.ledger.inferenceUsage(scope),{relationshipHour:1,runtimeHour:1,active:true});
 }finally{f.database.close();}
});

test("S083 inference admission enforces scope, revision, current priority, lifecycle, zero limits, expiry and no retry",()=>{
 const f=fixture();try{
  const item=opportunity(f.now());let r=f.ledger.admit(scope,item,current);
  const reserve=(overrides:Partial<typeof inferenceLimits>={},nowCurrent=current)=>f.ledger.reserveInference(scope,item.opportunityId,r.version,{...inferenceLimits,...overrides},nowCurrent);
  assert.throws(()=>reserve(),/admission/u);r=change(f.ledger,r,{type:"eligible"});
  assert.throws(()=>f.ledger.reserveInference({...scope,userId:randomUUID()},item.opportunityId,r.version,inferenceLimits,current),/Unknown/u);
  assert.throws(()=>f.ledger.reserveInference(scope,item.opportunityId,r.version-1,inferenceLimits,current),/revision/u);
  assert.throws(()=>reserve({},()=>false),/boundary/u);
  for(const x of [{perRelationshipHour:0},{perRuntimeHour:0}])assert.throws(()=>reserve(x),/budget exhausted/u);
  for(const x of [{perRelationshipHour:25},{perRuntimeHour:49},{perRelationshipHour:0.5},{perRuntimeHour:-1}])assert.throws(()=>reserve(x),/Invalid/u);
  assert.deepEqual(f.ledger.inferenceUsage(scope),{relationshipHour:0,runtimeHour:0,active:false});
  const claim=reserve();f.ledger.settleInference(scope,item.opportunityId,claim);assert.throws(()=>reserve(),/already reserved/u);
  f.advance(1);const replay=eligible(f.ledger,opportunity(f.now(),{executionMode:"replay"}));assert.throws(()=>f.ledger.reserveInference(scope,replay.opportunity.opportunityId,replay.version,inferenceLimits,current),/admission/u);
  f.advance(1);const expires=eligible(f.ledger,opportunity(f.now()));f.advance(300_000);assert.throws(()=>f.ledger.reserveInference(scope,expires.opportunity.opportunityId,expires.version,inferenceLimits,current),/expired/u);
 }finally{f.database.close();}
});

test("S083 inference limits share a runtime across relationships but preserve each relationship budget",()=>{
 const f=fixture();try{
  const own=eligible(f.ledger,opportunity(f.now()));const id=own.opportunity.opportunityId;
  const claim=f.ledger.reserveInference(scope,id,own.version,inferenceLimits,current);
  f.advance(1);const otherScope={...scope,userId:randomUUID(),relationshipId:randomUUID()},other=eligible(f.ledger,opportunity(f.now(),otherScope));
  assert.throws(()=>f.ledger.reserveInference(otherScope,other.opportunity.opportunityId,other.version,inferenceLimits,current),/occupied/u);
  assert.throws(()=>f.ledger.settleInference(otherScope,id,claim),/claim/u);assert.throws(()=>f.ledger.settleInference(scope,id,randomUUID()),/claim/u);
  f.ledger.settleInference(scope,id,claim);
  assert.throws(()=>f.ledger.reserveInference(otherScope,other.opportunity.opportunityId,other.version,{perRelationshipHour:12,perRuntimeHour:1},current),/budget exhausted/u);
  const second=f.ledger.reserveInference(otherScope,other.opportunity.opportunityId,other.version,{perRelationshipHour:1,perRuntimeHour:2},current);
  assert.deepEqual(f.ledger.inferenceUsage(otherScope),{relationshipHour:1,runtimeHour:2,active:true});
  f.ledger.settleInference(scope,id,claim);assert.equal(f.ledger.inferenceUsage(scope).active,true,"late settlement cannot free the new call");
  f.ledger.settleInference(otherScope,other.opportunity.opportunityId,second);
 }finally{f.database.close();}
});

test("S083 inference write failures and clock reversal cannot grant a call or release capacity",()=>{
 const f=fixture();try{
  const r=eligible(f.ledger,opportunity(f.now())),id=r.opportunity.opportunityId;
  f.database.exec("CREATE TRIGGER fail_call BEFORE INSERT ON initiative_inference_calls BEGIN SELECT RAISE(ABORT,'call storage failure'); END;");
  assert.throws(()=>f.ledger.reserveInference(scope,id,r.version,inferenceLimits,current),/storage failure/u);
  assert.deepEqual(f.ledger.inferenceUsage(scope),{relationshipHour:0,runtimeHour:0,active:false});f.database.exec("DROP TRIGGER fail_call");
  const claim=f.ledger.reserveInference(scope,id,r.version,inferenceLimits,current);
  f.database.exec("CREATE TRIGGER fail_settle BEFORE UPDATE ON initiative_inference_calls BEGIN SELECT RAISE(ABORT,'settlement storage failure'); END;");
  assert.throws(()=>f.ledger.settleInference(scope,id,claim),/storage failure/u);assert.equal(f.ledger.inferenceUsage(scope).active,true);f.database.exec("DROP TRIGGER fail_settle");
  f.advance(-1);assert.throws(()=>f.ledger.settleInference(scope,id,claim),/clock discontinuity/u);f.advance(1);
  f.ledger.settleInference(scope,id,claim);assert.equal(f.ledger.inferenceUsage(scope).relationshipHour,1);
 }finally{f.database.close();}
});

test("S083 inference reservations survive reopen; exclusive recovery expires work and retains consumed budget",()=>{
 const directory=mkdtempSync(join(tmpdir(),"initiative-inference-restart-")),path=join(directory,"db.sqlite");let db=new Database({path});db.migrate();let ledger=new InitiativeDeliveryRepository(db,()=>start);
 try{
  const r=eligible(ledger,opportunity(start)),id=r.opportunity.opportunityId;ledger.reserveInference(scope,id,r.version,inferenceLimits,current);
  db.close();db=new Database({path});db.migrate();ledger=new InitiativeDeliveryRepository(db,()=>start);
  assert.deepEqual(ledger.inferenceUsage(scope),{relationshipHour:1,runtimeHour:1,active:true});
  assert.equal(ledger.recover(),1);assert.deepEqual(ledger.inferenceUsage(scope),{relationshipHour:1,runtimeHour:1,active:false});
  assert.equal(ledger.get(scope,id)!.outcome.state,"expired");assert.equal(ledger.recover(),0);
  assert.throws(()=>ledger.reserveInference(scope,id,ledger.get(scope,id)!.version,inferenceLimits,current),/admission/u);
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});

test("S083 retention never releases an unsettled inference call and preserves source fencing after settlement",()=>{
 const f=fixture();try{
  const item=opportunity(f.now()),r=eligible(f.ledger,item),claim=f.ledger.reserveInference(scope,item.opportunityId,r.version,inferenceLimits,current);
  change(f.ledger,r,{type:"finish",state:"cancelled",reasons:["userTurn"]});
  f.advance(86_400_001);f.ledger.prune();assert.ok(f.ledger.get(scope,item.opportunityId));assert.equal(f.ledger.inferenceUsage(scope).active,true);
  f.ledger.settleInference(scope,item.opportunityId,claim);f.ledger.prune();assert.ok(f.ledger.get(scope,item.opportunityId));
  f.advance(86_400_001);f.ledger.prune();assert.equal(f.ledger.get(scope,item.opportunityId),undefined);assert.equal(f.ledger.inferenceUsage(scope).active,false);
  assert.equal(f.database.connection.prepare("SELECT count(*) AS n FROM initiative_inference_calls").get()!.n,0);
  assert.throws(()=>f.ledger.admit(scope,item,current),/Stale/u);
 }finally{f.database.close();}
});

test("S083 independent SQLite workers race for one runtime inference slot",{timeout:15_000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),"initiative-inference-race-")),path=join(directory,"db.sqlite"),db=new Database({path});db.migrate();let time=start;const ledger=new InitiativeDeliveryRepository(db,()=>time);
 const first=eligible(ledger,opportunity(time));time++;const second=eligible(ledger,opportunity(time));db.close();
 const source=`import {parentPort,workerData} from 'node:worker_threads';
 import {Database} from ${JSON.stringify(new URL("../src/database.ts",import.meta.url).href)};
 import {InitiativeDeliveryRepository} from ${JSON.stringify(new URL("../src/initiative-delivery.ts",import.meta.url).href)};
 const database=new Database({path:workerData.path});const ledger=new InitiativeDeliveryRepository(database,()=>workerData.now);
 parentPort.once('message',()=>{try{const claim=ledger.reserveInference(workerData.scope,workerData.id,workerData.version,workerData.limits,()=>true);parentPort.postMessage({claim});}catch(error){parentPort.postMessage({error:error.message});}finally{database.close();}});parentPort.postMessage('ready');`;
 const workers=[first,second].map(r=>new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`),{workerData:{path,scope,id:r.opportunity.opportunityId,version:r.version,limits:inferenceLimits,now:time}}));
 try{
  await Promise.all(workers.map(w=>once(w,"message")));const results=workers.map(w=>once(w,"message"));workers.forEach(w=>w.postMessage("start"));const outcomes=await Promise.all(results);
  assert.equal(outcomes.filter(([x])=>x.claim).length,1);assert.match(outcomes.find(([x])=>x.error)![0].error,/occupied/u);
  const readback=new Database({path});try{assert.deepEqual(new InitiativeDeliveryRepository(readback,()=>time).inferenceUsage(scope),{relationshipHour:1,runtimeHour:1,active:true});}finally{readback.close();}
 }finally{await Promise.all(workers.map(w=>w.terminate()));rmSync(directory,{recursive:true,force:true});}
});

test("S083 inference migration upgrades an existing delivery database without rewriting its records or migrations",()=>{
 const directory=mkdtempSync(join(tmpdir(),"initiative-inference-upgrade-")),path=join(directory,"db.sqlite");let db=new Database({path,migrations:loadMigrations().filter(m=>m.id<=23)});const oldMigrations=db.migrate();
 try{
  // Seed the old schema directly; today's transition code requires migration 25.
  const oldLedger=new InitiativeDeliveryRepository(db,()=>start),admitted=oldLedger.admit(scope,opportunity(start),current);
  db.connection.prepare("UPDATE initiative_delivery SET state='eligible',outcome_json=?,version=version+1 WHERE opportunity_id=?").run(JSON.stringify({...admitted.outcome,state:'eligible'}),admitted.opportunity.opportunityId);
  const r=oldLedger.get(scope,admitted.opportunity.opportunityId)!;db.close();db=new Database({path});
  const upgraded=db.migrate();assert.deepEqual(upgraded.slice(0,oldMigrations.length),oldMigrations);assert.deepEqual(upgraded.slice(oldMigrations.length).map(m=>m.id),[24,25,26,27,28,29,30,31,32,33,34,35,36,37,38]);
  const ledger=new InitiativeDeliveryRepository(db,()=>start);assert.deepEqual(ledger.get(scope,r.opportunity.opportunityId),r);
  assert.deepEqual(ledger.inferenceUsage(scope),{relationshipHour:0,runtimeHour:0,active:false});
  const claim=ledger.reserveInference(scope,r.opportunity.opportunityId,r.version,inferenceLimits,current);ledger.settleInference(scope,r.opportunity.opportunityId,claim);
  assert.deepEqual(db.migrate(),upgraded);assert.equal(ledger.inferenceUsage(scope).relationshipHour,1);
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});


test('S083 speech playback remains pending after endpoint acceptance and recovers unknown with its observed stage',()=>{
 for(const completion of ['restart','expiry','cancel','playback','text']){
  const f=fixture();try{
   let r=queue(f.ledger,opportunity(f.now()));const receiptId=randomUUID();r=change(f.ledger,r,{type:'beginEmission',receiptId,current,awaitPlayback:completion!=='text'});r=change(f.ledger,r,{type:'emitted',receiptId});r=change(f.ledger,r,{type:'acknowledge',receiptId,sessionId,kind:'endpointAccepted'});
   const pending=()=>Number(f.database.connection.prepare('SELECT count(*) AS n FROM initiative_playback_pending').get()!.n);
   assert.equal(pending(),completion==='text'?0:1);
   if(completion==='cancel')r=change(f.ledger,r,{type:'finish',state:'cancelled',reasons:['cancelled']});
   if(completion==='playback')r=change(f.ledger,r,{type:'acknowledge',receiptId,sessionId,kind:'playbackCompleted'});
   if(completion==='expiry'){f.advance(300001);assert.equal(f.ledger.expirePending(),1);}else f.ledger.recover();
   r=f.ledger.get(scope,r.opportunity.opportunityId)!;assert.equal(pending(),0);assert.equal(r.budget,'charged');assert.equal(r.outcome.lastDeliveryStage,'acknowledged');
   assert.equal(r.outcome.state,['restart','expiry'].includes(completion)?'unknown':completion==='cancel'?'cancelled':'acknowledged');assert.equal(r.outcome.acknowledgmentKind,completion==='playback'?'playbackCompleted':'endpointAccepted');
   if(['restart','expiry','cancel'].includes(completion))assert.throws(()=>change(f.ledger,r,{type:'acknowledge',receiptId,sessionId,kind:'playbackCompleted'}));
  }finally{f.database.close();}
 }
});
