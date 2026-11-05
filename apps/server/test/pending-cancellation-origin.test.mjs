// Original HostPort/provider and native custody closure, isolated deterministic
// ports only. No engine, SQLite/auth store, browser or model is constructed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {compileFunction} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {GameAdapterBoundaryError,guardGameActivityAdapter} from '../../../packages/providers-bizhawk/src/provider.ts';
import {createAuthenticatedGameRuntime} from '../src/runtime/game-host-runtime.ts';
import {observe,observed} from '../../../packages/providers-bizhawk/test/game-host-fixtures.ts';
import {nativeCustodyFixture} from '../../../packages/providers-bizhawk/test/fixtures/native-custody-boundary.mjs';
import {captureSupervisedGameFailure} from '../../../scripts/supervised-game-runtime.mjs';
const {GameHostPort,GameHostError}=await import(process.env.CT83_HOST_MODULE??new URL('../src/runtime/game-host-port.ts',import.meta.url));
const protocol='lifestream.game-host.v1',flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
const indexSource=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
const fixtureSource=readFileSync(new URL('./ct-first-cause-diagnostics.test.mjs',import.meta.url),'utf8');
const fa=fixtureSource.indexOf('function actorFixture(){'),fz=fixtureSource.indexOf("\ntest('",fa);
const reportLine=indexSource.split('\n').find(v=>v.includes('private reportDedicatedCtDiagnostic('));
const originalReport=compileFunction('return '+stripTypeScriptTypes('({'+reportLine.replace('private ','')+'})',{mode:'strip'})+'.reportDedicatedCtDiagnostic;')();
let fixtureBody=fixtureSource.slice(fa,fz);
const oldFactory="createAuthenticatedGameRuntime:(_s,_o,_r,ports)=>ports.current()?{isCurrent:ports.current,close(){}}:null";
assert.equal(fixtureBody.split(oldFactory).length,2);
fixtureBody=fixtureBody.replace(oldFactory,"createAuthenticatedGameRuntime:(s,o,r,ports)=>realRuntime(s,{...o,resolveApproval:()=>null,preparation:{current:()=>true,begin:()=>true},sourceCurrent:()=>true},r,ports)");
const originalActorFixture=compileFunction(fixtureBody+';return actorFixture;',['source','report','randomUUID','compileFunction','stripTypeScriptTypes','assert','realRuntime'])(indexSource,originalReport,randomUUID,compileFunction,stripTypeScriptTypes,assert,createAuthenticatedGameRuntime);
async function setup(t,{actual=false,legacy=false}={}){
 const timers=[],intervals=[];t.mock.method(globalThis,'setTimeout',(fn,ms)=>{const x={fn,ms,active:true,unref(){}};timers.push(x);return x;});t.mock.method(globalThis,'clearTimeout',x=>{if(x)x.active=false;});t.mock.method(globalThis,'setInterval',(fn,ms)=>{const x={fn,ms,unref(){}};intervals.push(x);return x;});t.mock.method(globalThis,'clearInterval',()=>{});
 delete process.env.CT79_NATIVE_OWNER_FILE;const f=nativeCustodyFixture(),wall=f.now(),mono=performance.now();t.mock.method(Date,'now',()=>f.now());t.mock.method(performance,'now',()=>mono+f.now()-wall);
 const original=actual?originalActorFixture():null,r=observe();if(original)r.scope={...r.scope,...original.scope,contextBinding:{...r.scope.contextBinding,...original.scope.contextBinding}};const scope=r.scope,trace=[];let joined,actorCurrent=true,runtimeCurrent=true,bindingCurrent=true,contextCurrent=true,closed=0,phase='setup';
 const runtime={isCurrent:()=>{trace.push('runtime');return runtimeCurrent;},close:()=>{trace.push('cleanup-runtime');closed++;runtimeCurrent=false;}};
 const actor=original?.actor??{principalId:scope.principalId,sessionId:scope.contextBinding.sessionId,isCurrent:()=>{trace.push('actor');return actorCurrent;},runtimeFor:()=>runtime};
 const port=new GameHostPort({}, {maxAttachments:1,maxDurationMs:3000,createRepository:()=>({}),resolveAttachment:(_a,m)=>{const {protocol,...b}=m;return b;},bindingCurrent:()=>{trace.push('binding');return bindingCurrent;},controllerCurrent:()=>false,boundary:{sourceAvailable:()=>{trace.push('native');return f.check();},acceptObservation:()=>true},...(legacy?{}:{refreshSourceCustody:async(_s,_p,signal)=>f.refresh(signal)}),onAttached:j=>{joined=j;}});
 const a0=await port.attach(actor,{protocol,hostId:randomUUID(),scope,pinsDigest:'a'.repeat(64),providerRef:'synthetic-bridge',sourceRevision:'b'.repeat(64)}),a=port.attachments.get(a0.attachmentId),context=new AbortController(),pollSignal=new AbortController();
 t.after(()=>{port.close();f.release();f.close();});
 const start=async()=>{r.deadlineAt=new Date(Date.now()+3000).toISOString();const p=joined.adapter.observe(r,{signal:context.signal,isCurrent:()=>{trace.push('caller-context');return contextCurrent;}});void p.catch(()=>{});await flush();assert(a.pending,'Original pending observation must exist');return {promise:p,pending:a.pending};};
 const deliver=async()=>{const event=await port.next(actor,{protocol,attachmentId:a.id},pollSignal.signal);assert.equal(event.kind,'command');return {protocol,attachmentId:a.id,commandId:event.commandId,requestDigest:event.requestDigest};};
 return {port,a,f,r,actor,original,trace,timers,intervals,context,pollSignal,start,deliver,closed:()=>closed,withdraw:kind=>{if(kind==='actor')actorCurrent=false;if(kind==='runtime')runtimeCurrent=false;if(kind==='binding')bindingCurrent=false;if(kind==='context')contextCurrent=false;},reset:()=>{trace.length=0;},sweep:()=>{assert.equal(intervals[0].ms,250);intervals[0].fn();}};
}
async function rejected(p,site,predicate){let error;try{await p;assert.fail('Original pending must reject');}catch(e){error=e;}assert.equal(error.code,'invalidResponse');assert.equal(error.diagnosticCause,'host_pending_cancel_scopeChanged');assert.equal(error.cancellationSite,site);assert.equal(error.cancellationPredicate,predicate);assert.equal(Object.getOwnPropertyDescriptor(error,'cancellationSite').writable,false);const dto=captureSupervisedGameFailure(error,'select-planning');assert.equal(dto.reason,'adapter_invalidResponse_host_pending_cancel_scopeChanged');assert.equal(dto.cancellationSite,site);assert.equal(dto.cancellationPredicate,predicate);return error;}
for(const group of ['runtime','actor','binding'])test('original sweep retains '+group+' first false before cleanup with exact ordered callbacks',async t=>{
 const s=await setup(t),run=await s.start();s.withdraw(group);s.reset();s.sweep();await flush();await rejected(run.promise,'sweep_current','current_'+group);
 assert.deepEqual(s.trace,{runtime:['runtime','cleanup-runtime'],actor:['runtime','actor','cleanup-runtime'],binding:['runtime','actor','binding','cleanup-runtime']}[group]);assert.equal(s.closed(),1);assert.equal(s.a.pending,null);
});
test('original preparation gate attachment failure cancels pending with native cause before runtime cleanup',async t=>{
 const s=await setup(t),run=await s.start(),admission=await s.deliver();s.f.advance(2101);s.reset();assert.equal(s.port.preparationObservationCurrent(s.actor,'admit',admission),false);await rejected(run.promise,'preparation_gate_attachment','current_native_source');assert.deepEqual(s.trace,['actor','runtime','actor','binding','native','cleanup-runtime']);assert.equal(s.f.events[0].reason,'inspect_not_fresh');assert.equal(s.closed(),1);
});
test('original preparation gate later mismatch is boolean only and does not fabricate pending cancellation',async t=>{
 const s=await setup(t),run=await s.start(),admission=await s.deliver();assert.equal(s.port.preparationObservationCurrent(s.actor,'admit',{...admission,requestDigest:'c'.repeat(64)}),false);assert.equal(s.a.pending,run.pending);assert.equal(s.a.closed,false);s.port.close();await assert.rejects(run.promise,e=>e.diagnosticCause==='host_pending_cancel_shutdown'&&e.cancellationSite===undefined);
});
for(const site of ['admit_pre','admit_final','complete_final'])test('original '+site+' retains same-call pending context false',async t=>{
 const s=await setup(t),run=await s.start(),admission=await s.deliver();let calls=0;
 const originalCurrent=run.pending.context.isCurrent;
 // Same immutable public fixture port; first/second real pendingCurrent callback
 // select the second admission or second completion check, no product rewrite.
 const context={...run.pending.context,isCurrent:scope=>{calls++;return calls!==(site==='admit_pre'?1:2)&&originalCurrent(scope);}};
 if(site!=='complete_final')run.pending.context=context;
 if(site==='complete_final'){
  s.port.admit(s.actor,admission);run.pending.context=context;calls=0;const result=observed(s.r);result.completedAt=new Date(Date.now()).toISOString();
  assert.throws(()=>s.port.complete(s.actor,{...admission,resultDigest:gameHostDigest(result),result}),e=>e.status===410);
 }else assert.throws(()=>s.port.admit(s.actor,admission),e=>e.status===410);
 await rejected(run.promise,site,'pending_context');assert.equal(calls,site==='admit_pre'?1:2);
});
import {gameHostDigest} from '../../../packages/contracts/dist/game-host.js';
for(const group of ['wall','mono','signal'])test('original admit aggregates '+group+' loss into scopeChanged with exact new predicate',async t=>{
 const s=await setup(t),run=await s.start(),admission=await s.deliver();if(group==='wall')run.pending.command={...run.pending.command,expiresAt:new Date(Date.now()-1).toISOString()};if(group==='mono')run.pending.deadline=performance.now()-1;
 // The context signal fixture models already-aborted metadata before listener
 // servicing, without calling abort() (which would select original cancelled).
 if(group==='signal')run.pending.context={...run.pending.context,signal:{aborted:true,removeEventListener(){}}};
 assert.throws(()=>s.port.admit(s.actor,admission),e=>e.status===410);await rejected(run.promise,'admit_pre',{wall:'command_wall_deadline',mono:'command_monotonic_deadline',signal:'pending_signal_aborted'}[group]);
});
test('original next initial attachment qualification retains precise caller site',async t=>{
 const s=await setup(t),run=await s.start();s.withdraw('runtime');await assert.rejects(s.port.next(s.actor,{protocol,attachmentId:s.a.id},s.pollSignal.signal));await rejected(run.promise,'poll_initial_attachment','current_runtime');assert.equal(s.closed(),1);
});
test('sweep structural expiry records original predicate rather than cleanup-generated closed',async t=>{
 const s=await setup(t),run=await s.start();s.a.expires=Date.now()-1;s.reset();s.sweep();await rejected(run.promise,'sweep_preparation','structure_wall_lease');assert.deepEqual(s.trace,['cleanup-runtime']);
});
test('sweep inspection refusal retains closed unknown operation group without error body',async t=>{
 const s=await setup(t),run=await s.start();s.f.advance(501);s.f.withdraw();s.sweep();await flush();await rejected(run.promise,'sweep_refresh_failed','operation_failed');assert.equal(s.closed(),1);
});
test('real original indexed actor and authenticated runtime produce runtime group with inert public query ports',async t=>{
 const s=await setup(t,{actual:true}),run=await s.start();assert(s.original.queries()>0);s.original.owner.profileSwitching=true;s.sweep();await flush();await rejected(run.promise,'sweep_current','current_runtime');assert(s.original.events.some(x=>x.reason==='runtime_profile_switching'));
});
test('pure stale current remains nonterminal/unfenced and freshness recovery does not retain a cancellation',async t=>{
 const s=await setup(t);s.f.advance(2101);assert.equal(s.port.current(s.a),false);assert.equal(s.a.closed,false);assert.equal(s.a.pending,null);assert.equal(s.f.events[0].reason,'inspect_not_fresh');await s.f.refresh(s.f.signal);assert.equal(s.port.current(s.a),true);
});
test('original pending timer delivered first retains deadline cause with no fabricated scopeChanged detail',async t=>{
 const s=await setup(t),run=await s.start();run.pending.timer.fn();await assert.rejects(run.promise,e=>e.diagnosticCause==='host_pending_cancel_deadline'&&e.cancellationSite===undefined&&e.cancellationPredicate===undefined);
});
test('provider timer delivered first outranks later pending cancellation detail',async t=>{
 const s=await setup(t),run=await s.start(),timer=s.timers.find(x=>x.active&&x.ms===3000);assert(timer);s.f.advance(3000);timer.fn();await assert.rejects(run.promise,e=>e.code==='timedOut'&&e.cancellationSite===undefined);
});
async function wrapped(error){const r=observe();r.deadlineAt=new Date(Date.now()+3000).toISOString();const reject=async()=>{throw error;};const adapter=guardGameActivityAdapter({observe:reject,applyController:reject,controlSave:reject,releaseControls:reject},{providerRef:'synthetic',maxDurationMs:3000,sourceAvailable:()=>true});try{await adapter.observe(r,{signal:new AbortController().signal,isCurrent:()=>true});assert.fail();}catch(e){return e;}}
test('paired detail requires closed own primitive values without getter or proxy evaluation',async()=>{
 let traps=0;for(const invalid of ['getter','proxy','missing','unknown','wrong-cause']){
  const e=new GameHostError(410,'game_host_expired',invalid==='wrong-cause'?'host_pending_cancel_deadline':'host_pending_cancel_scopeChanged');
  if(invalid==='getter')Object.defineProperty(e,'cancellationSite',{get(){traps++;throw Error('PRIVATE');}});else Object.defineProperty(e,'cancellationSite',{value:invalid==='proxy'?new Proxy({},{get(){traps++;throw Error('PRIVATE');}}):invalid==='unknown'?'PRIVATE':'sweep_current'});
  if(invalid!=='missing')Object.defineProperty(e,'cancellationPredicate',{value:'current_actor'});
  const result=await wrapped(e);assert.equal(result.cancellationSite,undefined);assert.equal(captureSupervisedGameFailure(result,'select-planning').cancellationSite,undefined);
 }assert.equal(traps,0);
});
