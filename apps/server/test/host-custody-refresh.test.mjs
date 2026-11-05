import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getEventListeners} from 'node:events';
import {createSupervisedGameRuntime} from '../../../scripts/supervised-game-runtime.mjs';
import {GAME_HOST_PROTOCOL as protocol} from '@lifestream/contracts/game-host';
import {gameCampaignFixture} from '../../../packages/runtime/test/fixtures/game-campaign.ts';
import {nativeCustodyFixture} from '../../../packages/providers-bizhawk/test/fixtures/native-custody-boundary.mjs';
const {GameHostPort}=await import(process.env.CT80_HOST_MODULE??new URL('../src/runtime/game-host-port.ts',import.meta.url));
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
async function setup(t,{legacy=false,slowActor=false,maximum=3000}={}){
 const timers=[],intervals=[];t.mock.method(globalThis,'setTimeout',(fn,ms)=>{const timer={fn,ms,active:true,unref(){}};timers.push(timer);return timer;});t.mock.method(globalThis,'clearTimeout',timer=>{if(timer)timer.active=false;});t.mock.method(globalThis,'setInterval',(fn,ms)=>{const timer={fn,ms,unref(){}};intervals.push(timer);return timer;});t.mock.method(globalThis,'clearInterval',()=>{});
 const f=nativeCustodyFixture(),scope=gameCampaignFixture().input.observation.scope;let actorCurrent=true,hooks=0,joined,initial=true,initialHooks=0;
 const actor={principalId:scope.principalId,sessionId:scope.contextBinding.sessionId,isCurrent:()=>{if(slowActor&&!initial&&hooks>initialHooks)f.advance(2001);return actorCurrent;}};
 const port=new GameHostPort({}, {sanityTiming:{readRefreshTimeoutMs:3000,hostIdleTimeoutMs:10000},maxAttachments:1,maxDurationMs:maximum,createRepository:()=>({}),resolveAttachment:(_a,m)=>{const {protocol,...binding}=m;return binding;},bindingCurrent:()=>true,controllerCurrent:()=>false,boundary:{sourceAvailable:()=>f.check()},...(legacy?{}:{refreshSourceCustody:async(candidate,pins,signal)=>{hooks++;assert.deepEqual(candidate,scope);assert.equal(pins,'a'.repeat(64));await f.refresh(signal);}}),onAttached:join=>{joined=join;}});
 const attached=await port.attach(actor,{protocol,hostId:randomUUID(),scope,pinsDigest:'a'.repeat(64),providerRef:'inert',sourceRevision:'b'.repeat(64)}),controller=new AbortController(),a=port.attachments.get(attached.attachmentId);initial=false;initialHooks=hooks;
 t.after(()=>{port.close();f.release();});
 const poll=()=>port.next(actor,{protocol,attachmentId:attached.attachmentId},controller.signal);
 return {f,port,a,poll,controller,actor,scope,joined:()=>joined,hooks:()=>hooks-initialHooks,timers,withdrawActor:()=>{actorCurrent=false;},sweep:()=>{assert.equal(intervals[0].ms,250);intervals[0].fn();},finish:()=>{const timer=timers.findLast(v=>v.ms===1000&&v.active);assert(timer,'Original poll timer present');timer.fn();}};
}
test('original sweep waits for held exact inspection then runs unchanged full current',async t=>{
 const s=await setup(t),before=s.f.calls();s.f.advance(2100);s.f.hold();s.sweep();await flush();assert.equal(s.f.calls(),before+1);assert.equal(s.a.closed,false,'Sweep cannot retire while exact refresh is pending');s.sweep();s.sweep();await flush();assert.equal(s.hooks(),1);assert.equal(s.f.calls(),before+1);s.f.release();await flush();assert.equal(s.a.closed,false);assert.equal(s.f.check(),true);
});
test('original poll finish waits across active handoff gap and returns only freshly qualified idle',async t=>{
 const s=await setup(t),pending=s.poll();void pending.catch(()=>{});await flush();const before=s.f.calls();s.f.advance(2100);s.f.hold();s.finish();await flush();assert.equal(s.a.closed,false,'Poll must not retire during its exact refresh');assert.equal(s.f.calls(),before+1);let done=false;void pending.then(()=>done=true,()=>done=true);s.finish();s.sweep();await flush();assert.equal(done,false);assert.equal(s.f.calls(),before+1);s.f.release();await flush();assert.equal((await pending).kind,'idle');assert.equal(s.a.closed,false);
});
test('initial poll reserves conflict slot without extending lease before exact original qualification',async t=>{
 const s=await setup(t),expires=s.a.expires,lastPoll=s.a.lastPoll;s.f.advance(2100);s.f.hold();const pending=s.poll();void pending.catch(()=>{});await flush();assert.equal(s.a.expires,expires);assert.equal(s.a.lastPoll,lastPoll);await assert.rejects(s.poll(),e=>e.status===409);s.f.release();await flush();s.finish();assert.equal((await pending).kind,'idle');
});
for(const stage of ['initial','finish'])test('original '+stage+' poll abort remains prompt during held refresh and late completion cannot revive',async t=>{
 const s=await setup(t);if(stage==='initial'){s.f.advance(2100);s.f.hold();}const pending=s.poll();void pending.catch(()=>{});await flush();if(stage==='finish'){s.f.advance(2100);s.f.hold();s.finish();await flush();}assert(getEventListeners(s.controller.signal,'abort').length>0);s.controller.abort();await assert.rejects(pending);assert.equal(s.a.closed,true);s.f.release();await flush();assert.equal(s.port.attachments.size,0);
});
test('original host close during held poll inspection cannot admit a late idle',async t=>{
 const s=await setup(t);s.f.advance(2100);s.f.hold();const pending=s.poll();void pending.catch(()=>{});await flush();s.port.close();await assert.rejects(pending);s.f.release();await flush();assert.equal(s.port.attachments.size,0);
});
test('wrong original actor cannot trigger read-only inspection',async t=>{
 const s=await setup(t);await assert.rejects(s.port.next({...s.actor,sessionId:randomUUID()},{protocol,attachmentId:s.a.id},s.controller.signal),e=>e.status===403);assert.equal(s.hooks(),0);
});
test('source withdrawal during held sweep refresh still invokes original retirement',async t=>{
 const s=await setup(t),before=s.f.calls();s.f.advance(2100);s.f.hold();s.sweep();await flush();s.f.withdraw();s.f.release();await flush();assert.equal(s.a.closed,true);assert.equal(s.f.calls(),before+1);
});
test('original actor withdrawal after read-only inspection still denies the full poll current guard',async t=>{
 const s=await setup(t);s.f.advance(2100);s.f.hold();const pending=s.poll();void pending.catch(()=>{});await flush();s.withdrawActor();s.f.release();await assert.rejects(pending);assert.equal(s.a.closed,true);
});
test('original attachment expiry before preparation refuses without inspecting',async t=>{
 const s=await setup(t);s.a.expires=Date.now()-1;await assert.rejects(s.poll());assert.equal(s.hooks(),0);assert.equal(s.a.closed,true);
});
test('bounded inspection wait timeout refuses and late inspection cannot recreate attachment',async t=>{
 const s=await setup(t);s.f.advance(2100);s.f.hold();const pending=s.poll();void pending.catch(()=>{});await flush();const timeout=s.timers.find(v=>v.active&&v.ms>2900&&v.ms<=3000);assert(timeout);timeout.fn();await assert.rejects(pending);s.f.release();await flush();assert.equal(s.port.attachments.size,0);
});
test('slow original actor work after fresh measurement still refuses original2s source guard',async t=>{
 const s=await setup(t,{slowActor:true});s.f.advance(2100);await assert.rejects(s.poll());assert.equal(s.a.closed,true);assert.equal(s.f.check(),false);
});
test('absent optional refresh keeps original synchronous sweep and poll branches',async t=>{
 const s=await setup(t,{legacy:true}),pending=s.poll();void pending.catch(()=>{});assert.equal(s.a.poll instanceof Function,true);assert(s.timers.some(v=>v.ms===1000));assert.equal(s.hooks(),0);s.finish();assert.equal((await pending).kind,'idle');s.f.advance(2100);s.sweep();assert.equal(s.a.closed,true);
});

test('incoming original actor already withdrawn cannot reserve poll or trigger inspection',async t=>{
 const s=await setup(t);s.withdrawActor();await assert.rejects(s.poll(),e=>e.status===403);assert.equal(s.a.poll,null);assert.equal(s.a.closed,false);assert.equal(s.hooks(),0);
});
test('replacement attachment survives old pending inspection completion and old-resource cleanup',async t=>{
 const s=await setup(t);s.f.advance(2100);s.f.hold();const pending=s.poll();void pending.catch(()=>{});await flush();const replacement={...s.a,poll:null,closed:false,controller:new AbortController()};s.port.attachments.set(s.a.id,replacement);s.f.release();await assert.rejects(pending);await flush();assert.equal(s.a.closed,true);assert.equal(s.port.attachments.get(s.a.id),replacement);assert.equal(replacement.closed,false);
});

for(const field of ['expires','monotonicExpiry'])test('original attachment '+field+' expiry during held inspection cannot deliver late idle',async t=>{
 const s=await setup(t);s.f.advance(2100);s.f.hold();const pending=s.poll();void pending.catch(()=>{});await flush();s.a[field]=(field==='expires'?Date.now():performance.now())-1;s.f.release();await assert.rejects(pending);assert.equal(s.port.attachments.size,0);
});
test('original native authority expiry during held inspection never publishes freshness or admits poll',async t=>{
 const s=await setup(t);s.f.advance(2100);s.f.hold();const pending=s.poll();void pending.catch(()=>{});await flush();const inspected=s.f.inspection();s.f.advance(120000);s.f.release();await assert.rejects(pending);assert.equal(s.f.inspection(),inspected);assert.equal(s.port.attachments.size,0);
});
for(const timerDelivered of [true,false])test('original invoke deadline during held finish refuses expired delivery; timerDelivered='+timerDelivered,async t=>{
 const s=await setup(t),poll=s.poll();void poll.catch(()=>{});await flush();s.f.hold();const inspection=s.f.startInspection();void inspection.catch(()=>{});await flush();
 const controller=new AbortController(),request={schemaVersion:'1.0.0',operation:'GameActivityAdapter.observe',requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:new Date(Date.now()+3000).toISOString(),cancellationId:randomUUID(),executionMode:'normal',scope:s.scope,idempotencyKey:randomUUID(),payload:{expectedPinsDigest:'a'.repeat(64),afterActionId:null,maxScreenshots:1}};
 const result=s.joined().adapter.observe(request,{signal:controller.signal,isCurrent:()=>true});void result.catch(()=>{});await flush();const command=s.a.pending;assert(command);assert.equal(command.delivered,false);const originalExpiry=command.command.expiresAt;
 if(timerDelivered)command.timer.fn();else command.deadline=performance.now()-1;
 if(timerDelivered)await assert.rejects(result);s.f.release();await inspection;await flush();const event=await poll;assert.equal(event.kind,'cancel');assert.equal(event.reason,'deadline');await assert.rejects(result);assert.equal(command.delivered,false);assert.equal(command.command.expiresAt,originalExpiry);assert.equal(s.a.pending,null);
});
test('changed captured scope cannot qualify the fixed physical refresh',async t=>{
 const s=await setup(t),before=s.f.calls();s.a.binding=Object.freeze({...s.a.binding,scope:{...s.scope,runId:randomUUID()}});await assert.rejects(s.poll());assert.equal(s.f.calls(),before);assert.equal(s.a.closed,true);
});
test('supervisor captures only fixed optional refresh and source identity drift remains unavailable',async()=>{
 let calls=0;const native=Object.fromEntries(['resolveAttachment','bindingCurrent','controllerCurrent','sourceCurrent','sourceAvailable','acceptObservation','acceptAction','reconcileEffect','admitRelease','usageFor','shutdownExactOldLease'].map(k=>[k,()=>true]));const fixed=async(...args)=>{calls++;assert.equal(args.length,3);};native.refreshSourceCustody=fixed;
 const campaign=Object.fromEntries(['selectPlanning','planningCurrent','terminalRef','publishDecision','prepareController','controllerCurrent','recordSettledStep'].map(k=>[k,()=>null]));const options={native,campaign,createRepository:()=>({}),resolveApproval:()=>null,maximumSteps:1,maximumRunMs:80000,maximumCommandMs:3000};const runtime=createSupervisedGameRuntime(options);await runtime.gameHost.refreshSourceCustody({},'a'.repeat(64),new AbortController().signal);assert.equal(calls,1);assert.equal(runtime.current(),true);native.refreshSourceCustody=async()=>{};assert.equal(runtime.current(),false);await runtime.stop();assert.throws(()=>createSupervisedGameRuntime({...options,native:{...native,refreshSourceCustody:true}}));
});
