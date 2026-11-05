// Deterministic original HostPort with no DB, native process, model, or authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {GameHostPort,gameHostExpiryDetail} from '../src/runtime/game-host-port.ts';
import {observe} from '../../../packages/providers-bizhawk/test/game-host-fixtures.ts';
const protocol='lifestream.game-host.v1',flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
async function fixture(t,{legacy=false,maxAttachments=2}={}){
 let wall=1700000000000,mono=1000,closed=0;const intervals=[],timers=[];
 t.mock.method(Date,'now',()=>wall);t.mock.method(performance,'now',()=>mono);
 t.mock.method(globalThis,'setInterval',fn=>{intervals.push(fn);return {unref(){}};});t.mock.method(globalThis,'clearInterval',()=>{});
 t.mock.method(globalThis,'setTimeout',(fn,ms)=>{const timer={fn,ms,active:true,unref(){}};timers.push(timer);return timer;});t.mock.method(globalThis,'clearTimeout',timer=>{timer.active=false;});
 const state={runtime:true,native:true,read:async()=>{}},r=observe(),actor={principalId:r.scope.principalId,sessionId:r.scope.contextBinding.sessionId,isCurrent:()=>true,runtimeFor:()=>({isCurrent:()=>state.runtime,close:()=>{closed++;}})};
 const port=new GameHostPort({}, {sanityTiming:{readRefreshTimeoutMs:3000,hostIdleTimeoutMs:10000},maxAttachments,maxDurationMs:3000,createRepository:()=>({}),resolveAttachment:(_a,m)=>{const {protocol,...binding}=m;return binding;},bindingCurrent:()=>true,controllerCurrent:()=>false,boundary:{sourceAvailable:(_s,_p,capture)=>{if(!state.native)capture?.({stage:'custody-pre',predicate:'inspect_not_fresh',ageMs:30001});return state.native;}},...(legacy?{}:{refreshSourceCustody:async()=>state.read()})});
 t.after(()=>port.close());
 const attach=async()=>{state.runtime=true;state.native=true;return port.attach(actor,{protocol,hostId:randomUUID(),scope:{...r.scope,runId:randomUUID()},pinsDigest:'a'.repeat(64),providerRef:'synthetic',sourceRevision:'b'.repeat(64)});};
 const a=await attach(),poll=(id=a.attachmentId,who=actor)=>port.next(who,{protocol,attachmentId:id},new AbortController().signal);
 const sweep=async()=>{intervals[0]();await flush();};
 return {port,actor,state,a,attach,poll,sweep,timers,closed:()=>closed,advance:n=>{wall+=n;mono+=n;},rollback:()=>{wall--;}};
}
const detailed=(site,predicate)=>(error)=>{assert.equal(error.status,410);assert.equal(error.code,'game_host_expired');assert.equal(error.diagnosticCause,undefined);assert.equal(error.cancellationSite,site);assert.equal(error.cancellationPredicate,predicate);assert.equal(Object.getOwnPropertyDescriptor(error,'cancellationSite').writable,false);return true;};
const generic=error=>error.status===410&&error.code==='game_host_expired'&&error.cancellationSite===undefined&&error.cancellationPredicate===undefined;
for(const legacy of [false,true])test('idle '+(legacy?'legacy':'fresh')+' host retains original runtime cancellation for next poll',async t=>{
 const f=await fixture(t,{legacy}),a=f.port.attachments.get(f.a.attachmentId);assert.equal(a.pending,null);f.state.runtime=false;await f.sweep();
 assert.equal(f.closed(),1);assert.equal(f.port.attachments.size,0);await assert.rejects(f.poll(),detailed(legacy?'legacy_sweep':'sweep_current','current_runtime'));assert.equal(f.port.attachments.size,0);
});
test('same initial poll returns its first cancellation without inventing a pending command',async t=>{
 const f=await fixture(t);f.state.runtime=false;await assert.rejects(f.poll(),detailed('poll_initial_attachment','current_runtime'));assert.equal(f.closed(),1);
});
test('in-flight idle poll retains sweep cause before abort cleanup',async t=>{
 const f=await fixture(t),pending=f.poll();void pending.catch(()=>{});await flush();f.state.runtime=false;await f.sweep();await assert.rejects(pending,detailed('sweep_current','current_runtime'));
});
test('retired metadata checks both principal and session without invoking stale actor callbacks',async t=>{
 const f=await fixture(t);f.state.runtime=false;await f.sweep();
 for(const changed of [{principalId:randomUUID()},{sessionId:randomUUID()}])await assert.rejects(f.poll(f.a.attachmentId,{...f.actor,...changed,isCurrent:()=>assert.fail('Retired lookup must not call actor')}),generic);
 await assert.rejects(f.poll(randomUUID()),generic);await assert.rejects(f.poll(),detailed('sweep_current','current_runtime'));
 const retained=f.port.retiredAttachments.get(f.a.attachmentId);assert.deepEqual(Object.keys(retained).sort(),['monotonic','origin','principalId','sessionId','wall']);assert.deepEqual(Object.keys(retained.origin).sort(),['predicate','site']);
});
test('later cleanup cannot replace original retained cause or refresh retention',async t=>{
 const f=await fixture(t),a=f.port.attachments.get(f.a.attachmentId);f.state.runtime=false;await f.sweep();f.advance(1000);f.port.fence(a,'scopeChanged',{site:'poll_finish_current',predicate:'current_attachment_closed'});await assert.rejects(f.poll(),detailed('sweep_current','current_runtime'));f.advance(59000);await assert.rejects(f.poll(),generic);assert.equal(f.port.retiredAttachments.size,0);
});
test('retention cap evicts oldest metadata and never retains live capabilities',async t=>{
 const f=await fixture(t,{maxAttachments:1}),ids=[f.a.attachmentId];f.state.runtime=false;await f.sweep();const next=await f.attach();ids.push(next.attachmentId);f.state.runtime=false;await f.sweep();assert.equal(f.port.retiredAttachments.size,1);await assert.rejects(f.poll(ids[0]),generic);await assert.rejects(f.poll(ids[1]),detailed('sweep_current','current_runtime'));
});
test('clock rollback discards diagnostic tombstone without changing expired denial',async t=>{
 const f=await fixture(t);f.state.runtime=false;await f.sweep();f.rollback();await assert.rejects(f.poll(),generic);
});
test('native source witness is retained only through the existing closed validator',async t=>{
 const f=await fixture(t);f.state.native=false;await f.sweep();await assert.rejects(f.poll(),error=>{detailed('sweep_current','current_native_source')(error);assert.deepEqual(error.nativeSourceWitness,{stage:'custody-pre',predicate:'inspect_not_fresh',ageMs:30001});return true;});
});
test('pure current probe creates no diagnostic tombstone or terminal effect',async t=>{
 const f=await fixture(t);f.state.runtime=false;assert.equal(f.port.current(f.port.attachments.get(f.a.attachmentId)),false);assert.equal(f.port.retiredAttachments.size,0);assert.equal(f.closed(),0);
});
test('expiry detail projection never executes proxy or accessor input',()=>{
 let traps=0;const accessor={status:410,code:'game_host_expired',get cancellationSite(){traps++;throw Error('PRIVATE');},cancellationPredicate:'current_runtime'};assert.equal(gameHostExpiryDetail(accessor),undefined);assert.equal(gameHostExpiryDetail(new Proxy({},{getOwnPropertyDescriptor(){traps++;throw Error('PRIVATE');}})),undefined);assert.equal(traps,0);
});

for(const stage of ['sweep','poll'])test(stage+' idle read timer preserves explicit refresh deadline',async t=>{
 const f=await fixture(t);f.state.read=()=>new Promise(()=>{});let pending;
 if(stage==='sweep')await f.sweep();else {pending=f.poll();void pending.catch(()=>{});await flush();}
 const timer=f.timers.findLast(timer=>timer.active&&timer.ms===3000);assert(timer);timer.fn();await flush();
 const site=stage==='sweep'?'sweep_refresh_failed':'poll_initial_failed';if(pending)await assert.rejects(pending,detailed(site,'read_refresh_deadline'));await assert.rejects(f.poll(),detailed(site,'read_refresh_deadline'));assert.equal(f.closed(),1);
});
test('late completed read reports elapsed read budget without requiring timer delivery',async t=>{
 const f=await fixture(t);f.state.read=async()=>f.advance(3001);await assert.rejects(f.poll(),detailed('poll_initial_failed','read_refresh_deadline'));
});
test('original structural guard survives held read failure',async t=>{
 const f=await fixture(t);f.state.read=async()=>{f.port.attachments.get(f.a.attachmentId).monotonicExpiry=performance.now()-1;};await assert.rejects(f.poll(),detailed('poll_initial_failed','structure_monotonic_lease'));
});
test('arbitrary physical read failure is not relabeled as a deadline',async t=>{
 const f=await fixture(t);f.state.read=async()=>{throw Error('PRIVATE');};await f.sweep();await assert.rejects(f.poll(),detailed('sweep_refresh_failed','operation_failed'));assert(!JSON.stringify([...f.port.retiredAttachments.values()]).includes('PRIVATE'));
});

test('same read deadline remains distinct through an actual pending adapter cancellation',async t=>{
 const f=await fixture(t),a=f.port.attachments.get(f.a.attachmentId),request={...observe(),scope:a.binding.scope,deadlineAt:new Date(Date.now()+3000).toISOString()};
 const pending=a.adapter.observe(request,{signal:new AbortController().signal,isCurrent:()=>true});void pending.catch(()=>{});await flush();assert(a.pending);
 f.state.read=()=>new Promise(()=>{});await f.sweep();const timer=f.timers.findLast(timer=>timer.active&&timer.ms===3000);assert(timer);timer.fn();await flush();
 await assert.rejects(pending,error=>{assert.equal(error.code,'invalidResponse');assert.equal(error.diagnosticCause,'host_pending_cancel_scopeChanged');assert.equal(error.cancellationPredicate,'read_refresh_deadline');return true;});
});
