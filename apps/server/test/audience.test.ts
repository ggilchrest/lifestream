import assert from 'node:assert/strict';
import test from 'node:test';
import {AudienceCoordinator,type AudienceObservation} from '../src/runtime/audience.ts';
const identity={principalId:'owner',sessionId:'session',endpointId:'endpoint'};
function setup(t){let now=Date.parse('2026-09-20T12:00:00Z'),invalidations=0;const guard=new AudienceCoordinator({sourceIds:['enrolled-source'],now:()=>now},()=>invalidations++);t.after(()=>guard.close());const observation=(overrides:Partial<AudienceObservation>={}):AudienceObservation=>({sourceId:'enrolled-source',evidenceRef:'pwce:evidence:synthetic',endpointId:'endpoint',principalId:'owner',observedAt:new Date(now).toISOString(),expiresAt:new Date(now+4000).toISOString(),coverageKnown:true,ownerPresent:true,occupants:1,...overrides});return {guard,observation,advance:ms=>now+=ms,count:()=>invalidations};}
test('automatic solo requires authorized fresh scoped coverage; unknown and shared restrict',t=>{const f=setup(t);assert.equal(f.guard.snapshot(identity).privateAllowed,false);for(const change of [{sourceId:'untrusted'},{endpointId:'other'},{principalId:'other'},{coverageKnown:false},{ownerPresent:false},{occupants:0}]){f.guard.observe(identity,f.observation(change));assert.equal(f.guard.snapshot(identity).privateAllowed,false);}f.guard.observe(identity,f.observation());assert.equal(f.guard.snapshot(identity).basis,'automatic');assert.equal(f.guard.snapshot(identity).privateAllowed,true);const n=f.count();f.advance(1000);f.guard.observe(identity,f.observation());assert.equal(f.count(),n,'fresh same-class heartbeat does not invalidate a turn');f.guard.observe(identity,f.observation({occupants:2}));assert.equal(f.guard.snapshot(identity).classification,'shared');assert.equal(f.guard.snapshot(identity).privateAllowed,false);});
test('manual fallback expires and cannot override automatic shared evidence or a locked endpoint',t=>{const f=setup(t);assert.equal(f.guard.declare(identity,'solo',2).basis,'manual');assert.equal(f.guard.snapshot({...identity,sessionId:'other'}).privateAllowed,false);f.advance(2001);assert.equal(f.guard.snapshot(identity).privateAllowed,false);f.guard.declare(identity,'solo');f.guard.observe(identity,f.observation({occupants:2}));assert.equal(f.guard.snapshot(identity).classification,'shared');f.guard.declare(identity,'lock');assert.equal(f.guard.snapshot(identity).basis,'restricted');f.guard.declare(identity,'unlock');assert.equal(f.guard.snapshot(identity).privateAllowed,false);});
test('fresh owner-absent evidence fences manual solo and notifies private consumers',t=>{
 const f=setup(t),states:ReturnType<AudienceCoordinator['snapshot']>[]=[];
 const declared=f.guard.declare(identity,'solo');f.guard.subscribe(identity,state=>states.push(state));const count=f.count();
 const evidence=f.observation({ownerPresent:false,occupants:1});f.guard.observe(identity,evidence);
 const current=f.guard.snapshot(identity);
 assert.equal(current.classification,'unknown');assert.equal(current.privateAllowed,false);assert.equal(current.basis,'automatic');
 assert.equal(current.evidenceRef,evidence.evidenceRef);assert.equal(current.expiresAt,evidence.expiresAt);
 assert.ok(current.revision>declared.revision);assert.equal(f.count(),count+1);assert.equal(states.at(-1)?.privateAllowed,false);
 assert.equal(f.guard.declare(identity,'solo').privateAllowed,false,'a new manual declaration cannot override the fresh contradiction');
 const restrictedRevision=f.guard.snapshot(identity).revision;f.advance(1000);f.guard.observe(identity,f.observation({ownerPresent:false,occupants:1}));
 assert.equal(f.guard.snapshot(identity).revision,restrictedRevision,'same-class evidence renewal does not repeatedly invalidate consumers');
 f.guard.observe(identity,f.observation({ownerPresent:true,occupants:0}));assert.equal(f.guard.snapshot(identity).privateAllowed,false,'inconsistent empty coverage cannot substantiate owner-only presence');
 f.guard.observe(identity,f.observation());assert.equal(f.guard.snapshot(identity).privateAllowed,true,'fresh supported solo evidence can restore private eligibility');
});
test('manual solo remains an expiring fallback when automatic coverage is unknown or absent',t=>{
 const f=setup(t);f.guard.declare(identity,'solo',10);
 for(const observation of [null,f.observation({coverageKnown:false,ownerPresent:false}),f.observation({sourceId:'untrusted',ownerPresent:false}),f.observation({endpointId:'other',ownerPresent:false}),f.observation({expiresAt:'2026-09-20T11:59:59Z',ownerPresent:false})]){
  f.guard.observe(identity,observation);assert.equal(f.guard.snapshot(identity).basis,'manual');assert.equal(f.guard.snapshot(identity).privateAllowed,true);
 }
 f.advance(10001);assert.equal(f.guard.snapshot(identity).privateAllowed,false);
});
test('evidence expiry notifies subscribers and fresh evidence after restart is required',t=>{const f=setup(t),states:string[]=[];f.guard.subscribe(identity,s=>states.push(s.classification));f.guard.observe(identity,f.observation());f.advance(5001);f.guard.tick();assert.deepEqual(states.slice(-2),['solo-supported','unknown']);assert.equal(f.guard.snapshot(identity).automatic,false);});
