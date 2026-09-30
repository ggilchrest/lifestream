import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {VisualLifecycleEvidence} from '../src/runtime/visual-lifecycle-evidence.ts';

function fixture(){
 let utc=Date.now(),mono=1000;
 const actor={principalId:randomUUID(),assistantId:randomUUID(),sessionId:randomUUID()},scope={...actor,relationshipId:randomUUID(),environmentId:randomUUID(),conversationId:randomUUID(),endpointId:randomUUID(),sessionRevision:1,audienceRevision:2,scopeGeneration:3,sourceBindingRef:'PRIVATE_CAMERA_BINDING',captureConfigurationRevision:4};
 const evidence=new VisualLifecycleEvidence({utcMs:()=>utc,monotonicMs:()=>mono});
 return {actor,scope,evidence,advance:(ms:number)=>{utc+=ms;mono+=ms;},utcOnly:(ms:number)=>utc+=ms,monoOnly:(ms:number)=>mono+=ms};
}

test('bounded lifecycle outbox drains asynchronously, freezes metadata and isolates owner/session/Assistant',async()=>{
 const f=fixture();try{
  for(let i=0;i<140;i++)f.evidence.record(f.actor,{kind:'negotiated',scope:f.scope,selectedVersion:'1.0.0'});
  assert.deepEqual(f.evidence.receipts(f.actor),[]);await Promise.resolve();const first=f.evidence.receipts(f.actor);assert.equal(first.length,128);assert.equal(first[0]!.sequence,13);assert.equal(first.at(-1)!.sequence,140);assert.equal(new Set(first.map(row=>row.eventId)).size,128);assert.ok(first.every(row=>row.authority===false&&row.coverage==='bounded_best_effort'));assert.equal(Reflect.set(first[0]!.sourceEpochs!,'audience',999),false);
  for(const key of ['principalId','assistantId','sessionId'] as const)assert.deepEqual(f.evidence.receipts({...f.actor,[key]:randomUUID()}),[]);
  for(let i=0;i<20;i++)f.evidence.record(f.actor,{kind:'cameraRejected',reason:'permission_denied'});await Promise.resolve();assert.equal(f.evidence.receipts(f.actor).length,128);assert.equal(f.evidence.receipts(f.actor)[0]!.sequence,33);
 }finally{f.evidence.close();}
});

test('metadata sanitization never reads accessors/proxies, rejects foreign scope and omits raw IDs/scene/bytes',async()=>{
 const f=fixture();let calls=0;const hostile:any={};Object.defineProperty(hostile,'kind',{get(){calls++;return 'negotiated';}});
 f.evidence.record(f.actor,hostile);f.evidence.record(f.actor,new Proxy({kind:'negotiated'}, {}) as never);
 const hostileActor:any={...f.actor};Object.defineProperty(hostileActor,'principalId',{get(){calls++;return f.actor.principalId;}});f.evidence.record(hostileActor,{kind:'negotiated'});assert.deepEqual(f.evidence.receipts(hostileActor),[]);
 f.evidence.record(f.actor,{kind:'negotiated',scope:{...f.scope,principalId:randomUUID()}});
 const metadata:any={leaseId:'PRIVATE_LEASE',correlationId:'PRIVATE_CORRELATION',frames:[{frameId:'PRIVATE_FRAME',sequence:7,capturedMonotonicMs:5000.5,clockMappingId:'PRIVATE_CLOCK',bytes:Buffer.from('PRIVATE_RAW_BYTES'),scene:'PRIVATE_SCENE'}]};
 f.evidence.record(f.actor,{kind:'batchRejected',reason:'frame_invalid',metadata});await Promise.resolve();const rows=f.evidence.receipts(f.actor);assert.equal(rows.length,1);assert.equal(rows[0]!.frames[0]!.sequence,7);assert.equal(rows[0]!.frames[0]!.capturedMonotonicMs,5000.5);assert.doesNotMatch(JSON.stringify(rows),/PRIVATE_|bytes|scene/);assert.equal(calls,0);
 f.evidence.close();
});

test('UTC and monotonic expiry independently evict receipts; rollback/reset/close fence old scheduled drains',async()=>{
 for(const mode of ['utc','mono','rollback','reset','close'] as const){
  const f=fixture();f.evidence.record(f.actor,{kind:'negotiated'});
  if(mode==='utc'){await Promise.resolve();f.utcOnly(60000);}else if(mode==='mono'){await Promise.resolve();f.monoOnly(60000);}else if(mode==='rollback'){f.utcOnly(-1);}else if(mode==='reset')f.evidence.reset();else f.evidence.close();
  assert.deepEqual(f.evidence.receipts(f.actor),[]);await Promise.resolve();assert.deepEqual(f.evidence.receipts(f.actor),[]);
  if(mode!=='close'){f.advance(60001);f.evidence.record(f.actor,{kind:'cameraRejected',reason:'stale_lease'});await Promise.resolve();assert.equal(f.evidence.receipts(f.actor).length,1);}else {f.evidence.record(f.actor,{kind:'negotiated'});assert.deepEqual(f.evidence.receipts(f.actor),[]);}
  f.evidence.close();
 }
});

test('broken diagnostic clocks cannot throw into source-host callers or retain fresh claims',()=>{
 const actor={principalId:randomUUID(),assistantId:randomUUID(),sessionId:randomUUID()},evidence=new VisualLifecycleEvidence({utcMs:()=>{throw Error('PRIVATE_CLOCK_ERROR');},monotonicMs:()=>0});
 assert.doesNotThrow(()=>evidence.record(actor,{kind:'negotiated'}));assert.deepEqual(evidence.receipts(actor),[]);evidence.close();
});
