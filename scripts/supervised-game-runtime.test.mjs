import test from 'node:test';
import assert from 'node:assert/strict';
import {createSupervisedGameRuntime} from './supervised-game-runtime.mjs';

// Source callbacks are scripted here. These checks prove orchestration fences,
// not native qualification, actual inference, gameplay or memory acceptance.
function fixture({outcome='published',shutdown=true,retireMemory=false,onRetire,selection=true}={}){
 const events=[];let active=true;
 const runtime={isCurrent:()=>active,controllerCurrent:()=>active,
  preparePlanning:(selection,bounds)=>{events.push(['prepare',selection,bounds]);return {selection,bounds};},
  runPlanning:async step=>{events.push(['plan',step]);return {state:outcome,reason:outcome==='suppressed'?'foregroundPreempted':undefined};},
  publishEpisode:episode=>{events.push(['memory',episode]);if(retireMemory)active=false;return {state:'retained',memoryId:'synthetic-memory'};},
  close:()=>{active=false;events.push(['close']);}};
 const native={resolveAttachment:(_actor,metadata)=>metadata,bindingCurrent:()=>active,controllerCurrent:()=>active,sourceCurrent:()=>active,sourceAvailable:()=>active,acceptObservation:()=>active,acceptAction:()=>active,reconcileEffect:async()=>active,admitRelease:async()=>active,usageFor:()=>({synthetic:true}),shutdownExactOldLease:async join=>{events.push(['shutdown',join]);return shutdown;}};
 const campaign={selectPlanning:async()=>selection?({selection:{synthetic:true},bounds:{synthetic:true}}):null,planningCurrent:()=>active,terminalRef:()=>null,publishDecision:()=>false,prepareController:async()=>({synthetic:true}),controllerCurrent:()=>active,recordSettledStep:async()=>({journalCommitted:true,episode:{synthetic:true}})};
 const composition=createSupervisedGameRuntime({native,campaign,createRepository:()=>({synthetic:true}),resolveApproval:()=>null,maximumSteps:2,maximumRunMs:1000,maximumCommandMs:100,onStatus:value=>events.push(['status',value]),onRetire});
 const join={runtime,runController:async input=>{events.push(['controller',input]);return {state:'settled'};}};
 composition.gameHost.createRepository({synthetic:true});
 return {composition,join,events,native,campaign};
}

test('supervision uses the authenticated join and retires after memory fences its context',async()=>{
 const f=fixture({retireMemory:true});f.composition.gameHost.onAttached(f.join);await f.composition.completion();
 assert.deepEqual(f.events.filter(e=>['prepare','plan','controller','memory','close','shutdown'].includes(e[0])).map(e=>e[0]),['prepare','plan','controller','memory','close','shutdown']);
 assert.equal(f.events.find(e=>e[0]==='shutdown')[1],f.join);
 assert.throws(()=>f.composition.gameHost.onAttached(f.join),/unavailable/);
});

test('foreground suppression dispatches no controller or memory and still shuts down the old lease',async()=>{
 const f=fixture({outcome:'suppressed'});f.composition.gameHost.onAttached(f.join);await f.composition.completion();
 assert.equal(f.events.some(e=>['controller','memory'].includes(e[0])),false);
 assert.equal(f.events.filter(e=>e[0]==='shutdown').length,1);
 assert.equal(f.events.find(e=>e[0]==='status'&&e[1].state==='suppressed')[1].reason,'foregroundPreempted');
});

test('explicit stop during source selection prevents planning and awaits exact native shutdown once',async()=>{
 const f=fixture();let release;f.campaign.selectPlanning=()=>new Promise(resolve=>release=resolve);
 // Replacing a pinned callback fences this composition. Construct with the
 // deferred callback in place to exercise stop after an actual attachment.
 const options={native:f.native,campaign:f.campaign,createRepository:()=>({}),resolveApproval:()=>null,maximumSteps:1,maximumRunMs:1000,maximumCommandMs:100};
 const c=createSupervisedGameRuntime(options);c.gameHost.createRepository({});c.gameHost.onAttached(f.join);
 await c.stop();assert.equal(f.events.filter(e=>e[0]==='shutdown').length,1);
 release({selection:{},bounds:{}});await c.completion();await c.stop();
 assert.equal(f.events.some(e=>e[0]==='plan'),false);assert.equal(f.events.filter(e=>e[0]==='shutdown').length,1);
});

test('runtime source currency callback cannot recursively invoke runtime currency',async()=>{
 const f=fixture({retireMemory:true});let depth=0;
 const original=f.join.runtime.isCurrent;
 f.join.runtime.isCurrent=()=>{assert.equal(depth,0,'Recursive runtime currency');depth++;try{return original()&&f.composition.gameRuntime.sourceCurrent({});}finally{depth--;}};
 f.composition.gameHost.onAttached(f.join);await f.composition.completion();
 assert.equal(f.events.filter(e=>e[0]==='controller').length,1);
});

test('unconfirmed native shutdown remains reconciliation, even after a settled controller',async()=>{
 const f=fixture({shutdown:false,retireMemory:true});f.composition.gameHost.onAttached(f.join);await f.composition.completion();
 const final=f.events.filter(e=>e[0]==='status').at(-1)[1];assert.deepEqual(final,{state:'requiresReconciliation',nativeShutdownConfirmed:false});
});

test('source-port replacement fences attachment and production source admission',()=>{
 const f=fixture();f.native.sourceCurrent=()=>true;
 assert.equal(f.composition.gameRuntime.sourceCurrent({}),false);assert.throws(()=>f.composition.gameHost.onAttached(f.join),/unavailable/);
});

test('missing approval and bounded native ports cannot create an active composition',()=>{
 assert.throws(()=>createSupervisedGameRuntime({native:{},campaign:{}}),/Missing qualified native port/);
 const f=fixture();assert.equal(f.composition.gameRuntime.resolveApproval({}),null);
 assert.throws(()=>f.composition.gameHost.createRepository({}),/Second game repository/);
});

for(const throws of [false,true])test('retirement callback is once-only and finishes before reentrant cleanup'+(throws?' when it throws':''),async()=>{
 const f=fixture();let release,signal,nested;
 f.campaign.selectPlanning=(_join,_repository,selectedSignal)=>{signal=selectedSignal;return new Promise(resolve=>{release=resolve;});};
 const c=createSupervisedGameRuntime({native:f.native,campaign:f.campaign,createRepository:()=>({}),resolveApproval:()=>null,maximumSteps:1,maximumRunMs:1000,maximumCommandMs:100,onRetire:()=>{
  f.events.push(['retire-start']);nested=c.stop();assert.equal(c.current(),false);f.events.push(['retire-end']);if(throws)throw Error('Synthetic notification failure');
 }});
 c.gameHost.createRepository({});c.gameHost.onAttached(f.join);
 await c.stop();await nested;release(null);await c.completion();await c.stop();
 assert.equal(signal.aborted,true);
 assert.deepEqual(f.events.filter(e=>['retire-start','retire-end','close','shutdown'].includes(e[0])).map(e=>e[0]),['retire-start','retire-end','close','shutdown']);
});

for(const failure of ['selection','suppressed','exception'])test('failure retirement does not notify orderly closure: '+failure,async()=>{
 let notices=0;const f=fixture({outcome:failure==='suppressed'?'suppressed':'published',selection:failure!=='selection',onRetire:()=>notices++});
 if(failure==='exception')f.join.runtime.runPlanning=async()=>{throw Error('Synthetic operation failure');};
 f.composition.gameHost.onAttached(f.join);await f.composition.completion();await f.composition.stop();
 assert.equal(notices,0);assert.equal(f.events.filter(e=>e[0]==='shutdown').length,1);
});

test('finite successful completion notifies orderly closure once',async()=>{
 let notices=0;const f=fixture({onRetire:()=>notices++});f.composition.gameHost.onAttached(f.join);await f.composition.completion();await f.composition.stop();
 assert.equal(notices,1);assert.equal(f.events.filter(e=>e[0]==='controller').length,2);
});

test('watchdog expiry keeps failure retirement even when an explicit stop follows',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();let release,notices=0;
 f.campaign.selectPlanning=()=>new Promise(resolve=>{release=resolve;});
 const c=createSupervisedGameRuntime({native:f.native,campaign:f.campaign,createRepository:()=>({}),resolveApproval:()=>null,maximumSteps:1,maximumRunMs:1000,maximumCommandMs:100,onRetire:()=>notices++});
 c.gameHost.createRepository({});c.gameHost.onAttached(f.join);t.mock.timers.tick(1000);await c.completion();await c.stop();release(null);
 assert.equal(notices,0);assert.equal(f.events.filter(e=>e[0]==='shutdown').length,1);
});
