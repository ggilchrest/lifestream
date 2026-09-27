import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {AudienceCoordinator, type AudienceObservation} from '../src/runtime/audience.ts';

const identity={principalId:'owner',sessionId:'session',endpointId:'phone'};
function fixture(t){
 let now=Date.parse('2026-09-27T12:00:00Z'),valid=true;
 const guard=new AudienceCoordinator({sourceIds:['presence'],now:()=>now});t.after(()=>guard.close());
 const change=(operation:'begin'|'renew'|'end',leaseId:string,expectedAudienceRevision=guard.snapshot(identity).revision)=>guard.lease(identity,{operation,leaseId,expectedAudienceRevision},()=>valid);
 const observation=(overrides:Partial<AudienceObservation>={}):AudienceObservation=>({sourceId:'presence',evidenceRef:'synthetic',endpointId:'phone',principalId:'owner',observedAt:new Date(now).toISOString(),expiresAt:new Date(now+4000).toISOString(),coverageKnown:true,ownerPresent:true,occupants:1,...overrides});
 return {guard,change,observation,advance:(ms:number)=>{now+=ms;},revoke:()=>{valid=false;}};
}
test('native lease renews past five minutes without revision churn, then expires and cannot renew',t=>{
 const f=fixture(t),id=randomUUID(),initial=f.change('begin',id);assert.equal(initial.privateAllowed,true);assert.equal(initial.leaseId,id);
 for(let n=0;n<100;n++){f.advance(5000);const renewed=f.change('renew',id,initial.revision);assert.equal(renewed.revision,initial.revision);assert.equal(renewed.privateAllowed,true);}
 f.advance(20000);const expired=f.guard.snapshot(identity);assert.equal(expired.privateAllowed,false);assert.equal(expired.leaseId,null);assert.ok(expired.revision>initial.revision);
 assert.throws(()=>f.change('renew',id),/expired|inactive/i);assert.equal(f.guard.snapshot(identity).privateAllowed,false);
});
test('a process can supersede a lease using CAS; stale renew and cleanup preserve the new process',t=>{
 const f=fixture(t),one=randomUUID(),two=randomUUID(),first=f.change('begin',one);
 assert.throws(()=>f.change('begin',two,first.revision-1),/revision/i);
 const second=f.change('begin',two,first.revision);assert.ok(second.revision>first.revision);
 assert.throws(()=>f.change('renew',one,second.revision),/inactive|owner/i);
 assert.equal(f.change('end',one,first.revision).leaseId,two,'late old-process cleanup must not clear the replacement');
 assert.equal(f.change('end',two,second.revision).privateAllowed,false);
});
test('manual audience controls retire a native lease and its old heartbeat cannot restore private access',t=>{
 for(const mode of ['shared','clear','lock','unlock','solo'] as const){
  const f=fixture(t),id=randomUUID();f.change('begin',id);const manual=f.guard.declare(identity,mode);
  assert.equal(manual.leaseId,null);assert.throws(()=>f.change('renew',id),/expired|inactive/i);
  assert.deepEqual(f.change('end',id),manual,'lease cleanup must respect the later manual decision');
 }
});
test('a manual clear while already unknown fences a pending lease begin',t=>{
 const f=fixture(t),before=f.guard.snapshot(identity);f.guard.declare(identity,'clear');
 assert.ok(f.guard.snapshot(identity).revision>before.revision,'an explicit privacy decision must advance its CAS revision even if classification stays unknown');
 assert.throws(()=>f.change('begin',randomUUID(),before.revision),/revision/i);
 assert.equal(f.guard.snapshot(identity).privateAllowed,false);
});
test('automatic contradictions retire native fallback permanently and block a new lease while current',t=>{
 for(const detail of [{occupants:2},{ownerPresent:false},{occupants:0}]){
  const f=fixture(t),id=randomUUID();f.change('begin',id);f.guard.observe(identity,f.observation(detail));
  assert.equal(f.guard.snapshot(identity).leaseId,null);assert.equal(f.guard.snapshot(identity).privateAllowed,false);
  assert.throws(()=>f.change('begin',randomUUID()),/restrict|contradict|shared/i);
  f.advance(5000);assert.equal(f.guard.snapshot(identity).privateAllowed,false);assert.throws(()=>f.change('renew',id),/inactive|expired/i);
 }
});
test('revocation and endpoint changes retire the lease even without a renewal request',t=>{
 const f=fixture(t),id=randomUUID();f.change('begin',id);f.revoke();f.guard.tick();
 assert.equal(f.guard.snapshot(identity).privateAllowed,false);assert.equal(f.guard.snapshot(identity).leaseId,null);
 assert.throws(()=>f.change('renew',id),/inactive|expired/i);
});
test('lease cleanup preserves independent automatic evidence and removes an older manual fallback',t=>{
 const f=fixture(t),id=randomUUID();f.guard.declare(identity,'solo',900);f.change('begin',id);f.change('end',id);
 assert.equal(f.guard.snapshot(identity).privateAllowed,false,'old manual solo must not survive ownership transfer');
 f.guard.observe(identity,f.observation());f.change('begin',randomUUID());const owned=f.guard.snapshot(identity);
 assert.equal(f.change('end',owned.leaseId!).basis,'automatic');assert.equal(f.guard.snapshot(identity).privateAllowed,true);
});
test('the native lease exposes its own liveness horizon separately from automatic evidence freshness',t=>{
 const f=fixture(t),evidence=f.observation();f.guard.observe(identity,evidence);const active=f.change('begin',randomUUID());
 assert.equal(active.expiresAt,evidence.expiresAt,'automatic freshness remains truthful');
 assert.equal(Date.parse(active.leaseExpiresAt!)-Date.parse(evidence.observedAt),20000,'native ownership lasts through the 5s heartbeat interval');
 assert.equal(f.change('end',active.leaseId!).leaseExpiresAt,null);
});
test('owned end safely removes its contribution after the independent audience evidence revision changed',t=>{
 const f=fixture(t),id=randomUUID(),active=f.change('begin',id);f.guard.observe(identity,f.observation());
 assert.ok(f.guard.snapshot(identity).revision>active.revision);
 const ended=f.change('end',id,active.revision);assert.equal(ended.leaseId,null);assert.equal(ended.basis,'automatic');assert.equal(ended.privateAllowed,true);
 f.advance(5000);assert.equal(f.guard.snapshot(identity).privateAllowed,false,'the removed native contribution must not return after automatic evidence expires');
});
