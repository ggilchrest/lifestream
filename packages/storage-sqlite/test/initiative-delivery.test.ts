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
