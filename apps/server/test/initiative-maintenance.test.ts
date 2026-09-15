import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Database,InitiativeExpressionRepository,type InitiativeOpportunity,type InitiativeScope,type InitiativeDeliveryAction} from '@lifestream/storage-sqlite';
import {InitiativeMaintenance,initiativeRetentionCadence as cadence} from '../src/runtime/initiative-maintenance.ts';
import {InitiativeHost} from '../src/runtime/initiative-host.ts';

test('retention yields between full batches, returns to idle cadence and cancels on close',t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;
 const job=new InitiativeMaintenance(()=>{calls++;return {inferenceRemoved:calls===1?128:0,deliveryRemoved:calls===2?128:0};});
 assert.equal(calls,0);t.mock.timers.tick(1);assert.equal(calls,1);assert.equal(job.state(),'healthy');
 t.mock.timers.tick(cadence.catchUpMs-1);assert.equal(calls,1);t.mock.timers.tick(1);assert.equal(calls,2);
 t.mock.timers.tick(cadence.catchUpMs);assert.equal(calls,3);t.mock.timers.tick(cadence.idleMs-1);assert.equal(calls,3);
 t.mock.timers.tick(1);assert.equal(calls,4);job.close();t.mock.timers.tick(cadence.idleMs*2);assert.equal(calls,4);assert.equal(job.state(),'stopped');
});

test('retention failure retains generic degraded status and retries at the normal cadence',t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;
 const job=new InitiativeMaintenance(()=>{if(++calls===1)throw new Error('PRIVATE_DATABASE_DETAIL');return {inferenceRemoved:0,deliveryRemoved:0};});
 t.mock.timers.tick(1);assert.equal(job.state(),'degraded');t.mock.timers.tick(cadence.idleMs-1);assert.equal(calls,1);
 t.mock.timers.tick(1);assert.equal(calls,2);assert.equal(job.state(),'healthy');job.close();
});

test('host automatically prunes eligible metadata in bounded batches while preserving pending work and replay fences',t=>{
 const start=Date.parse('2026-09-16T00:00:00Z');t.mock.timers.enable({apis:['Date','setTimeout'],now:start});
 const db=new Database({path:':memory:'});db.migrate();const host=new InitiativeHost(db),ledger=host.ledger,expressions=new InitiativeExpressionRepository(db);
 const scope:InitiativeScope={assistantId:randomUUID(),userId:randomUUID(),relationshipId:randomUUID(),deploymentId:randomUUID()},sessionId=randomUUID();
 const opportunity=(topicKey=randomUUID()):InitiativeOpportunity=>{const now=Date.now();return {schemaVersion:'1.0.0',recordType:'opportunity',...scope,opportunityId:randomUUID(),correlationId:randomUUID(),conversationId:randomUUID(),sessionId,endpointId:randomUUID(),configurationId:randomUUID(),configurationRevision:1,policyRevision:'synthetic-policy:1',kind:'availableCheckIn',category:'social',urgency:'low',sourceKind:'runtimeContext',sourceRefs:['synthetic-source:retention'],executionMode:'simulation',observedAt:new Date(now).toISOString(),receivedAt:new Date(now).toISOString(),expiresAt:new Date(now+300000).toISOString(),dedupKey:randomUUID(),topicKey};};
 const transition=(op:InitiativeOpportunity,action:InitiativeDeliveryAction)=>ledger.transition(scope,op.opportunityId,ledger.get(scope,op.opportunityId)!.version,action);
 const seed=(playback:boolean)=>{
  const op=opportunity();ledger.admit(scope,op,()=>true);transition(op,{type:'eligible'});
  const claim=ledger.reserveInference(scope,op.opportunityId,ledger.get(scope,op.opportunityId)!.version,{perRelationshipHour:12,perRuntimeHour:24},()=>true);ledger.settleInference(scope,op.opportunityId,claim);
  expressions.note(scope,op.opportunityId,{requestedWarmth:0.5,modality:'speech',wording:'requested',speechStage:'notObserved',mappingRevision:null,disposition:'notObserved',degradedDimensions:[],appliedDelivery:{}},()=>true);
  transition(op,{type:'generated',preparedViewId:randomUUID(),interactionId:randomUUID()});transition(op,{type:'queue',limits:{perHour:2,perDay:8,minimumGapMs:120000},current:()=>true});
  transition(op,{type:'beginEmission',receiptId:op.correlationId,current:()=>true,awaitPlayback:playback});transition(op,{type:'emitted',receiptId:op.correlationId});
  transition(op,playback?{type:'acknowledge',sessionId,receiptId:op.correlationId,kind:'endpointAccepted'}:{type:'finish',state:'unknown',reasons:['ackTimeout']});return op;
 };
 try{
  const old=seed(false);t.mock.timers.setTime(start+180000);const pending=seed(true);
  t.mock.timers.setTime(start+180010);const unsettled=opportunity();ledger.admit(scope,unsettled,()=>true);transition(unsettled,{type:'eligible'});ledger.reserveInference(scope,unsettled.opportunityId,ledger.get(scope,unsettled.opportunityId)!.version,{perRelationshipHour:12,perRuntimeHour:24},()=>true);transition(unsettled,{type:'finish',state:'cancelled',reasons:['cancelled']});
  // More than one cleanup batch, all admitted through the real ledger.
  for(let n=0;n<129;n++){t.mock.timers.setTime(start+180020+n);const op=opportunity();ledger.admit(scope,op,()=>true);transition(op,{type:'finish',state:'suppressed',reasons:['quiet']});}
  const count=()=>Number(db.connection.prepare('SELECT count(*) AS n FROM initiative_delivery').get()!.n);
  assert.equal(count(),132);t.mock.timers.setTime(start+180200+86400001);t.mock.timers.tick(1);assert.equal(count(),4);
  assert.ok(ledger.get(scope,pending.opportunityId));assert.ok(ledger.get(scope,unsettled.opportunityId));
  t.mock.timers.tick(cadence.catchUpMs);assert.equal(count(),2);assert.equal(ledger.get(scope,old.opportunityId),undefined);assert.equal(expressions.get(scope,old.opportunityId),undefined);assert.ok(expressions.get(scope,pending.opportunityId));
  assert.equal(db.connection.prepare('SELECT count(*) AS n FROM initiative_inference_calls').get()!.n,2);assert.equal(db.connection.prepare('SELECT count(*) AS n FROM initiative_playback_pending').get()!.n,1);
  assert.throws(()=>ledger.admit(scope,old,()=>true),/Stale/u);assert.throws(()=>ledger.admit(scope,opportunity(old.topicKey),()=>true),/Unanswered/u);
  const note=host.runtimeExplanations().find(e=>e.code==='initiative_retention')!;assert.match(note.summary,/24-hour/u);assert.deepEqual(note.sourceRefs,[]);
 }finally{host.close();db.close();t.mock.timers.tick(cadence.idleMs*2);}
});
