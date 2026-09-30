import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {VisualMemoryEvidence} from '../src/runtime/visual-memory-evidence.ts';

function fixture(){let utc=Date.now(),mono=1000;const owner={principalId:randomUUID(),assistantId:randomUUID(),relationshipId:randomUUID()},evidence=new VisualMemoryEvidence({utcMs:()=>utc,monotonicMs:()=>mono});return {owner,evidence,advance:(ms:number)=>{utc+=ms;mono+=ms;},utcOnly:(ms:number)=>utc+=ms,monoOnly:(ms:number)=>mono+=ms};}

test('background intake history preserves queued/retained stages without a Human identity or source prose',async()=>{
 const f=fixture(),requestId=randomUUID();f.evidence.record(f.owner,requestId,'queued');f.evidence.record(f.owner,requestId,'retained');assert.deepEqual(f.evidence.receipts(f.owner),[]);await Promise.resolve();const rows=f.evidence.receipts(f.owner);assert.deepEqual(rows.map(row=>row.state),['queued','retained']);assert.equal(rows[0]!.requestDigest,rows[1]!.requestDigest);assert.notEqual(rows[0]!.eventId,rows[1]!.eventId);assert.equal(rows[0]!.producerScope,'backgroundVisualMemoryIntake');assert.ok(rows.every(row=>row.authority===false));assert.doesNotMatch(JSON.stringify(rows),new RegExp(`${requestId}|${f.owner.principalId}|interactionId|sessionId|content`));assert.equal(Reflect.set(rows[0]!,'state','retained'),false);f.evidence.close();
});
test('bounded rings evict oldest and isolate every owner field without reading hostile getters',async()=>{
 const f=fixture();for(let i=0;i<140;i++)f.evidence.record(f.owner,randomUUID(),'queued');await Promise.resolve();assert.equal(f.evidence.receipts(f.owner).length,128);assert.equal(f.evidence.receipts(f.owner)[0]!.sequence,13);for(const key of ['principalId','assistantId','relationshipId'] as const)assert.deepEqual(f.evidence.receipts({...f.owner,[key]:randomUUID()}),[]);
 let calls=0;const owner:any={...f.owner};Object.defineProperty(owner,'principalId',{get(){calls++;return f.owner.principalId;}});f.evidence.record(owner,randomUUID(),'retained');assert.deepEqual(f.evidence.receipts(owner),[]);f.evidence.record(new Proxy(f.owner,{}),randomUUID(),'queued');assert.equal(calls,0);
 f.evidence.record(f.owner,'PRIVATE_REQUEST', 'PRIVATE_ERROR_WITH_SOURCE_PROSE');await Promise.resolve();const last=f.evidence.receipts(f.owner).at(-1)!;assert.equal(last.state,'unclassified');assert.doesNotMatch(JSON.stringify(last),/PRIVATE_/);f.evidence.close();
});
test('dual-clock expiry, rollback/reset/close fence prior history and broken clocks cannot affect admission',async()=>{
 for(const mode of ['utc','mono','rollback','reset','close'] as const){const f=fixture();f.evidence.record(f.owner,randomUUID(),'queued');if(mode==='utc'){await Promise.resolve();f.utcOnly(60000);}else if(mode==='mono'){await Promise.resolve();f.monoOnly(60000);}else if(mode==='rollback')f.utcOnly(-1);else if(mode==='reset')f.evidence.reset();else f.evidence.close();assert.deepEqual(f.evidence.receipts(f.owner),[]);await Promise.resolve();assert.deepEqual(f.evidence.receipts(f.owner),[]);f.evidence.close();}
 const f=fixture(),broken=new VisualMemoryEvidence({utcMs:()=>{throw Error('PRIVATE_CLOCK');},monotonicMs:()=>0});assert.doesNotThrow(()=>broken.record(f.owner,randomUUID(),'retained'));assert.deepEqual(broken.receipts(f.owner),[]);broken.close();f.evidence.close();
});
