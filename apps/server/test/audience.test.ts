import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {AudienceCoordinator,type AudienceObservation} from '../src/runtime/audience.ts';
import type {CameraAudienceBinding,CameraAudienceEvidence} from '../src/runtime/audience.ts';
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

test('source withdrawal immediately invalidates cached solo and fences an older in-flight reply',async t=>{
 let invalidate:()=>void=()=>{},release:(value:AudienceObservation|null)=>void=()=>{},unsubscribed=false;
 const now=Date.parse('2026-09-24T12:00:00Z');
 const solo:AudienceObservation={sourceId:'enrolled-source',evidenceRef:'evidence.synthetic',endpointId:'endpoint',principalId:'owner',observedAt:new Date(now).toISOString(),expiresAt:new Date(now+4000).toISOString(),coverageKnown:true,ownerPresent:true,occupants:1};
 const guard=new AudienceCoordinator({sourceIds:['enrolled-source'],now:()=>now,subscribeInvalidation:listener=>{invalidate=listener;return ()=>{unsubscribed=true;};},poll:()=>new Promise(resolve=>{release=resolve;})});t.after(()=>guard.close());
 guard.observe(identity,solo);assert.equal(guard.snapshot(identity).privateAllowed,true);
 guard.tick();await new Promise(setImmediate);invalidate();assert.equal(guard.snapshot(identity).privateAllowed,false,'no polling interval required');
 release(solo);await new Promise(setImmediate);assert.equal(guard.snapshot(identity).privateAllowed,false,'late source reply cannot restore permission');
 guard.close();assert.equal(unsubscribed,true);
});

test('new pushed shared evidence cannot be overwritten by a preexisting poll',async t=>{
 let release:(value:AudienceObservation|null)=>void=()=>{};const now=Date.parse('2026-09-24T12:00:00Z');
 const observation:AudienceObservation={sourceId:'enrolled-source',evidenceRef:'evidence.synthetic',endpointId:'endpoint',principalId:'owner',observedAt:new Date(now).toISOString(),expiresAt:new Date(now+4000).toISOString(),coverageKnown:true,ownerPresent:true,occupants:1};
 const guard=new AudienceCoordinator({sourceIds:['enrolled-source'],now:()=>now,poll:()=>new Promise(resolve=>{release=resolve;})});t.after(()=>guard.close());guard.snapshot(identity);guard.tick();await new Promise(setImmediate);
 guard.observe(identity,{...observation,occupants:2});release(observation);await new Promise(setImmediate);assert.equal(guard.snapshot(identity).classification,'shared');assert.equal(guard.snapshot(identity).privateAllowed,false);
});

function cameraSetup(t:import('node:test').TestContext){
 let now=Date.parse('2026-09-29T12:00:00Z'),mono=1000,generic=0;const changes:Array<{reason:string;classification:string;revision:number}>=[];
 const guard=new AudienceCoordinator({sourceIds:['independent-room'],cameraSourceIds:['camera'],now:()=>now,monotonicMs:()=>mono,onCameraChanged:(_identity,value,reason)=>changes.push({reason,classification:value.classification,revision:value.revision})},()=>generic++);t.after(()=>guard.close());
 const binding:CameraAudienceBinding={sourceId:'camera',sourceBindingRef:'host:camera',leaseId:randomUUID(),captureEpoch:randomUUID(),configurationRevision:1};
 const evidence=(overrides:Partial<CameraAudienceEvidence>={}):CameraAudienceEvidence=>({evidenceRef:'count:'+randomUUID(),sequence:0,value:'one',capturedAtEarliest:new Date(now).toISOString(),capturedAtLatest:new Date(now).toISOString(),interpretedAt:new Date(now).toISOString(),expiresAt:new Date(now+2000).toISOString(),declaredFieldOfView:'Configured camera view; room exterior unobserved',coverage:'frameOnly',confidence:null,limitations:['Only visible pixels are counted'],uncertaintyReasons:[],...overrides});
 const owner=(overrides:Partial<AudienceObservation>={}):AudienceObservation=>({sourceId:'independent-room',evidenceRef:'owner:'+randomUUID(),endpointId:'endpoint',principalId:'owner',observedAt:new Date(now).toISOString(),expiresAt:new Date(now+4000).toISOString(),coverageKnown:true,ownerPresent:true,occupants:1,...overrides});
 return {guard,binding,evidence,owner,changes,generic:()=>generic,advance:(ms:number)=>{now+=ms;mono+=ms;},wall:(ms:number)=>{now+=ms;},monotonic:(ms:number)=>{mono+=ms;},qualify:()=>guard.requalifyCamera(identity,{binding,expectedAudienceRevision:guard.snapshot(identity).revision,ownerEvidence:owner()})};
}

test('camera count lane retires prior solo and native clearance; one visible human is never identity',t=>{
 const f=cameraSetup(t);f.guard.declare(identity,'solo',900);const native=randomUUID();f.guard.lease(identity,{operation:'begin',leaseId:native,expectedAudienceRevision:f.guard.snapshot(identity).revision});
 f.guard.beginCamera(identity,f.binding);assert.equal(f.guard.snapshot(identity).classification,'unknown');assert.equal(f.guard.snapshot(identity).leaseId,null);
 let sequence=0;for(const value of ['one','zero','uncertain'] as const){f.advance(1);assert.equal(f.guard.observeCamera(identity,f.binding,f.evidence({value,sequence:sequence++})),true);assert.equal(f.guard.snapshot(identity).privateAllowed,false);}
 assert.throws(()=>f.guard.lease(identity,{operation:'renew',leaseId:native,expectedAudienceRevision:f.guard.snapshot(identity).revision}),/inactive|expired/);
 assert.throws(()=>f.guard.lease(identity,{operation:'begin',leaseId:randomUUID(),expectedAudienceRevision:f.guard.snapshot(identity).revision}),/restrict/);
 assert.equal(f.guard.declare(identity,'solo').privateAllowed,false,'a new manual-only assertion cannot substitute for camera requalification');
});

test('fresh multiple restricts synchronously; expiry and source end stay unknown without resurrecting manual fallback',t=>{
 const f=cameraSetup(t);f.guard.declare(identity,'solo',900);f.guard.beginCamera(identity,f.binding);const baseline=f.generic();f.advance(1);
 assert.equal(f.guard.observeCamera(identity,f.binding,f.evidence({value:'multiple'})),true);assert.equal(f.changes.at(-1)?.classification,'shared');assert.equal(f.guard.snapshot(identity).classification,'shared');assert.equal(f.generic(),baseline,'camera transition uses its dedicated hook without generic capture teardown');
 f.advance(1999);assert.equal(f.guard.snapshot(identity).classification,'shared');f.advance(1);assert.equal(f.guard.snapshot(identity).classification,'unknown');assert.equal(f.changes.at(-1)?.reason,'countExpired');
 assert.equal(f.guard.cameraEvidence(identity),null);f.guard.endCamera(identity,f.binding);f.guard.observe(identity,null);assert.equal(f.guard.snapshot(identity).privateAllowed,false);assert.equal(f.guard.declare(identity,'unlock').privateAllowed,false);
});

test('camera private requalification needs current CAS, fresh independent owner coverage and a fresh one-count',t=>{
 const f=cameraSetup(t),oldOwner=f.owner();f.guard.beginCamera(identity,f.binding);f.advance(1);f.guard.observeCamera(identity,f.binding,f.evidence());
 const revision=f.guard.snapshot(identity).revision;
 for(const ownerEvidence of [oldOwner,f.owner({sourceId:'camera'}),f.owner({coverageKnown:false}),f.owner({ownerPresent:false}),f.owner({occupants:0}),f.owner({endpointId:'other'})])assert.throws(()=>f.guard.requalifyCamera(identity,{binding:f.binding,expectedAudienceRevision:revision,ownerEvidence}),/requalification/);
 assert.throws(()=>f.guard.requalifyCamera(identity,{binding:f.binding,expectedAudienceRevision:revision-1,ownerEvidence:f.owner()}),/revision|scope/);
 const qualified=f.qualify();assert.equal(qualified.classification,'solo-supported');assert.ok(qualified.revision>revision);assert.equal(f.changes.at(-1)?.reason,'requalified');
 f.advance(1);f.guard.observeCamera(identity,f.binding,f.evidence({sequence:1,value:'multiple'}));assert.equal(f.guard.snapshot(identity).privateAllowed,false);
 f.advance(2001);f.guard.observeCamera(identity,f.binding,f.evidence({sequence:2}));assert.equal(f.guard.snapshot(identity).privateAllowed,false,'new one-count never restores old qualification');
 f.advance(1);assert.equal(f.qualify().privateAllowed,true);
 f.guard.observe(identity,null);assert.equal(f.guard.snapshot(identity).privateAllowed,false,'independent source withdrawal invalidates qualification');
 f.guard.observe(identity,f.owner());assert.equal(f.guard.snapshot(identity).privateAllowed,false,'independent evidence recovery still needs new revisioned requalification');
});

test('camera scope/epoch/sequence and two-second evidence bounds reject late or unrelated evidence without clearing restriction',t=>{
 const f=cameraSetup(t);f.guard.beginCamera(identity,f.binding);f.advance(1);const first=f.evidence({value:'multiple',sequence:4});assert.equal(f.guard.observeCamera(identity,f.binding,first),true);const revision=f.guard.snapshot(identity).revision;
 for(const binding of [{...f.binding,leaseId:randomUUID()},{...f.binding,captureEpoch:randomUUID()},{...f.binding,configurationRevision:2},{...f.binding,sourceBindingRef:'other'},{...f.binding,sourceId:'unknown'}])assert.equal(f.guard.observeCamera(identity,binding,f.evidence({sequence:5})),false);
 for(const change of [{sequence:3},{expiresAt:new Date(Date.parse(first.capturedAtEarliest)+2001).toISOString()},{coverage:'complete' as CameraAudienceEvidence['coverage']},{confidence:NaN},{declaredFieldOfView:''}])assert.equal(f.guard.observeCamera(identity,f.binding,f.evidence({sequence:5,...change})),false);
 assert.equal(f.guard.snapshot(identity).revision,revision);assert.equal(f.guard.snapshot(identity).classification,'shared');
 const successor={...f.binding,leaseId:randomUUID(),captureEpoch:randomUUID()};f.guard.beginCamera(identity,successor);assert.equal(f.guard.observeCamera(identity,f.binding,f.evidence({sequence:6})),false);f.guard.endCamera(identity,f.binding);assert.equal(f.guard.observeCamera(identity,successor,f.evidence()),true,'old cleanup cannot end successor');
 assert.equal(f.guard.snapshot({...identity,sessionId:'other'}).privateAllowed,false);
});

test('camera uncertainty, obstructed coverage, clock rollback and explicit privacy restrictions revoke qualification',t=>{
 for(const cause of ['uncertain','zero','obstructed','clock','manualShared'] as const){
  const f=cameraSetup(t);f.guard.beginCamera(identity,f.binding);f.advance(1);f.guard.observeCamera(identity,f.binding,f.evidence());f.qualify();assert.equal(f.guard.snapshot(identity).privateAllowed,true);
  if(cause==='clock')f.wall(-1);else if(cause==='manualShared'){f.guard.declare(identity,'shared');f.guard.declare(identity,'clear');}else{f.advance(1);f.guard.observeCamera(identity,f.binding,f.evidence({sequence:1,...(cause==='obstructed'?{coverage:'obstructed'}:{value:cause})}));}
  assert.equal(f.guard.snapshot(identity).privateAllowed,false,cause);
 }
});

test('camera evidence is copied and bounded, while unrelated noncamera manual fallback remains unchanged',t=>{
 const f=cameraSetup(t);f.guard.beginCamera(identity,f.binding);f.advance(1);const evidence=f.evidence({value:'multiple'});f.guard.observeCamera(identity,f.binding,evidence);evidence.value='one';evidence.limitations.push('mutated');
 const returned=f.guard.cameraEvidence(identity)!;assert.equal(returned.value,'multiple');assert.equal(returned.limitations.length,1);returned.value='one';assert.equal(f.guard.cameraEvidence(identity)?.value,'multiple');
 const other={...identity,sessionId:'text-only'};f.guard.declare(other,'solo');f.guard.observe(other,null);assert.equal(f.guard.snapshot(other).privateAllowed,true);
});

test('fresh camera heartbeats preserve the audience revision while renewing metadata and the monotonic deadline',t=>{
 const f=cameraSetup(t);f.guard.beginCamera(identity,f.binding);f.advance(1);f.guard.observeCamera(identity,f.binding,f.evidence());f.qualify();
 const prior=f.guard.snapshot(identity),callbacks=f.changes.length;
 f.advance(1000);const next=f.evidence({sequence:1});assert.equal(f.guard.observeCamera(identity,f.binding,next),true);
 const current=f.guard.snapshot(identity);assert.equal(current.revision,prior.revision);assert.equal(current.privateAllowed,true);assert.equal(current.evidenceRef,next.evidenceRef);assert.equal(current.expiresAt,next.expiresAt);assert.equal(f.changes.length,callbacks);
 f.monotonic(1999);assert.equal(f.guard.snapshot(identity).privateAllowed,true);f.monotonic(1);
 assert.equal(f.guard.snapshot(identity).classification,'unknown');assert.equal(f.changes.length,callbacks+1);assert.equal(f.changes.at(-1)?.reason,'countExpired');assert.ok(f.guard.snapshot(identity).revision>current.revision);
});

test('camera expiry publishes its restriction without a poll or a subsequent read',async t=>{
 const fixture=cameraSetup(t);let expired:()=>void=()=>{};
 const event=new Promise<void>(resolve=>{expired=resolve;});
 const guard=new AudienceCoordinator({cameraSourceIds:['camera'],onCameraChanged:(_identity,_snapshot,reason)=>{if(reason==='countExpired')expired();}});t.after(()=>guard.close());
 guard.tick=()=>{};guard.beginCamera(identity,fixture.binding);
 const now=Date.now(),evidence=fixture.evidence({value:'multiple',capturedAtEarliest:new Date(now).toISOString(),capturedAtLatest:new Date(now).toISOString(),interpretedAt:new Date(now).toISOString(),expiresAt:new Date(now+40).toISOString()});
 assert.equal(guard.observeCamera(identity,fixture.binding,evidence),true);
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([event,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Camera expiry did not publish')),1000);})]);}finally{clearTimeout(timer);}
 assert.equal(guard.snapshot(identity).classification,'unknown');
});

test('withdrawing unusable camera count keeps capture binding active and cannot revive prior clearance',t=>{
 const f=cameraSetup(t);assert.equal(f.guard.configuredCameraSource('camera'),true);assert.equal(f.guard.configuredCameraSource('independent-room'),false);assert.equal(f.guard.configuredCameraSource('unknown'),false);f.guard.beginCamera(identity,f.binding);f.advance(1);f.guard.observeCamera(identity,f.binding,f.evidence());f.qualify();
 const qualified=f.guard.snapshot(identity);
 assert.equal(f.guard.withdrawCameraEvidence(identity,{...f.binding,captureEpoch:randomUUID()}).revision,qualified.revision,'late old-epoch withdrawal cannot erase current evidence');
 const withdrawn=f.guard.withdrawCameraEvidence(identity,f.binding),callbacks=f.changes.length;
 assert.equal(withdrawn.classification,'unknown');assert.equal(withdrawn.basis,'restricted');assert.ok(withdrawn.revision>qualified.revision);assert.equal(f.guard.cameraEvidence(identity),null);
 assert.equal(f.guard.withdrawCameraEvidence(identity,f.binding).revision,withdrawn.revision);assert.equal(f.changes.length,callbacks,'already unknown restrictions do not churn revisions');
 f.advance(1);assert.equal(f.guard.observeCamera(identity,f.binding,f.evidence({sequence:1})),true,'capture binding remains active');assert.equal(f.guard.snapshot(identity).privateAllowed,false,'fresh one-count cannot resurrect retired clearance');
 assert.equal(f.qualify().privateAllowed,true,'new independent revisioned qualification is still possible');
});
