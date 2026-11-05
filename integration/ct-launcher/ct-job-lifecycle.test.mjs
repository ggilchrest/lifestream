import test from 'node:test';
import assert from 'node:assert/strict';
import {createCtJobLifecycle} from './ct-job-lifecycle.mjs';

// Timing-only fixtures. These predicates never establish app authentication,
// native quiescence, provider health, original grants or actual Tifa gameplay.
const drain=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
class Clock {
 value=0;sequence=0;jobs=new Map();
 now(){return this.value;}
 setTimeout(fn,ms){const id=++this.sequence;this.jobs.set(id,{at:this.value+ms,fn});return id;}
 clearTimeout(id){this.jobs.delete(id);}
 async advance(ms){
  const target=this.value+ms;
  for(;;){
   const next=[...this.jobs].filter(([,v])=>v.at<=target).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
   if(!next)break;
   this.value=next[1].at;this.jobs.delete(next[0]);next[1].fn();await drain();
  }
  this.value=target;await drain();
 }
}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(patch={}){
 const clock=new Clock(),external=new AbortController();let current=true,execute=true,quiet=true,stops=0;
 const limits={owner_prepare:100,native_prepare:100,native_start:100,model:30,controller:5,settle:100};
 const options={maximumGameplayMs:100,operationLimits:limits,cleanupTimeoutMs:10,clock,signal:external.signal,isCurrent:()=>current,canExecute:()=>execute,isQuiescent:()=>quiet,onStop:()=>{stops++;return true;},...patch};
 const life=createCtJobLifecycle(options);
 return {clock,life,external,options,limits,setCurrent:v=>current=v,setExecute:v=>execute=v,setQuiet:v=>quiet=v,stops:()=>stops};
}
const rejected=(promise,reason)=>assert.rejects(promise,{code:'ct_lifecycle_'+reason});

test('days of setup and ready waiting consume no execution budget or timer',async()=>{
 const f=fixture();await f.clock.advance(7*86400000);assert.equal(f.life.snapshot().activeGameplayMs,0);assert.equal(f.clock.jobs.size,0);
 f.life.ready();await f.clock.advance(7*86400000);assert.equal(f.life.snapshot().gameplayStarted,false);assert.equal(f.clock.jobs.size,0);
 f.life.beginGameplay();await f.clock.advance(99);assert.equal(f.life.snapshot().state,'playing');
 await f.clock.advance(1);const end=await f.life.completion();assert.equal(end.reason,'gameplay_budget_exhausted');assert.equal(end.activeGameplayMs,100);assert.equal(end.cleanup,'confirmed');
});

test('review wait excludes only quiescent time and preserves the used budget across resume',async()=>{
 const f=fixture();f.life.ready();f.life.beginGameplay();await f.clock.advance(25);f.life.waitForReview();
 await f.clock.advance(86400000);assert.equal(f.life.snapshot().activeGameplayMs,25);assert.equal(f.life.snapshot().remainingGameplayMs,75);assert.equal(f.clock.jobs.size,0);
 f.life.beginGameplay();await f.clock.advance(74);assert.equal(f.life.snapshot().state,'playing');await f.clock.advance(1);
 assert.equal((await f.life.completion()).activeGameplayMs,100);
});

test('real host readiness is checked at every resume without refilling or starting a timer on denial',async()=>{
 const f=fixture();f.life.ready();f.setExecute(false);assert.throws(()=>f.life.beginGameplay(),{code:'ct_lifecycle_execution_not_ready'});assert.equal(f.clock.jobs.size,0);
 f.setExecute(true);f.life.beginGameplay();await f.clock.advance(20);f.life.waitForReview();f.setExecute(false);
 await f.clock.advance(10000);assert.throws(()=>f.life.beginGameplay(),{code:'ct_lifecycle_execution_not_ready'});assert.equal(f.life.snapshot().remainingGameplayMs,80);
 await f.life.stop();assert.equal((await f.life.completion()).reason,'cancelled');
});

test('unsafe pause is rejected while execution keeps consuming its original budget',async()=>{
 const f=fixture();f.life.ready();f.life.beginGameplay();f.setQuiet(false);
 assert.throws(()=>f.life.waitForReview(),{code:'ct_lifecycle_not_quiescent'});await f.clock.advance(100);
 assert.equal((await f.life.completion()).reason,'gameplay_budget_exhausted');
});

test('native preparation has a separate operation watchdog but consumes no gameplay time',async()=>{
 const f=fixture();const result=f.life.runOperation('native_start',()=>new Promise(resolve=>f.clock.setTimeout(()=>resolve('prepared'),20)));
 await f.clock.advance(20);assert.equal(await result,'prepared');assert.equal(f.life.snapshot().gameplayStarted,false);assert.equal(f.life.snapshot().activeGameplayMs,0);
 f.life.ready();assert.equal(f.life.snapshot().remainingGameplayMs,100);await f.life.stop();
});

test('hung preparation times out, aborts its original port and does not spend gameplay budget',async()=>{
 const f=fixture();let aborted=false;
 const result=f.life.runOperation('native_prepare',({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('inert cancelled preparation'));},{once:true})));
 const rejection=rejected(result,'operation_timeout');await f.clock.advance(100);await rejection;
 const end=await f.life.completion();assert.equal(aborted,true);assert.equal(end.gameplayStarted,false);assert.equal(end.activeGameplayMs,0);assert.equal(end.cleanup,'confirmed');
});

test('overlap and suspension of an in-flight model operation cannot hide held resources',async()=>{
 const f=fixture();f.life.ready();f.life.beginGameplay();
 const result=f.life.runOperation('model',({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('inert model cancelled')),{once:true})));
 const rejection=rejected(result,'operation_timeout');
 assert.throws(()=>f.life.runOperation('controller',()=>{}),{code:'ct_lifecycle_operation_in_flight'});
 assert.throws(()=>f.life.waitForReview(),{code:'ct_lifecycle_invalid_transition'});
 assert.throws(()=>f.life.stop('completed'),{code:'ct_lifecycle_operation_in_flight'});
 await f.clock.advance(30);await rejection;assert.equal((await f.life.completion()).reason,'operation_timeout');
});

test('global active budget can abort a longer execution operation before its own watchdog',async()=>{
 const f=fixture({maximumGameplayMs:20});f.life.ready();f.life.beginGameplay();
 const result=f.life.runOperation('settle',({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('inert settlement cancelled')),{once:true})));
 const rejection=rejected(result,'gameplay_budget_exhausted');await f.clock.advance(20);await rejection;
 assert.equal((await f.life.completion()).activeGameplayMs,20);
});

test('idle preparation cancels immediately through the original invalidation signal',async()=>{
 const f=fixture();f.external.abort();const end=await f.life.completion();assert.equal(end.reason,'revoked');assert.equal(end.gameplayStarted,false);assert.equal(f.stops(),1);
 assert.equal(f.clock.jobs.size,0);assert.equal(f.life.check(),false);
});

test('currentness loss is terminal even before owner readiness, never a reason to keep preparation alive',async()=>{
 const f=fixture();f.setCurrent(false);assert.equal(f.life.check(),false);assert.equal((await f.life.completion()).reason,'currentness_lost');assert.equal(f.stops(),1);
 assert.throws(()=>f.life.ready(),{code:'ct_lifecycle_currentness_lost'});
});

test('already revoked selection never becomes ready',async()=>{
 const signal=new AbortController();signal.abort();const f=fixture({signal:signal.signal});
 assert.equal((await f.life.completion()).reason,'revoked');assert.throws(()=>f.life.ready(),{code:'ct_lifecycle_revoked'});
});

test('cancellation rejects late success and waits for exact late resource disposal before confirmed cleanup',async()=>{
 const f=fixture(),work=deferred();let disposed=0;
 const result=f.life.runOperation('owner_prepare',()=>work.promise,{disposeLateResult:async value=>{assert.equal(value,'late owned fixture');disposed++;return true;}});
 const rejection=rejected(result,'cancelled');const first=f.life.stop();assert.equal(f.life.stop('shutdown'),first);await rejection;await drain();
 assert.equal(f.life.snapshot().cleanup,'pending');work.resolve('late owned fixture');await drain();
 assert.equal((await first).cleanup,'confirmed');assert.equal(disposed,1);assert.equal(f.stops(),1);assert.equal(f.life.snapshot().state,'stopped');
});

test('uncooperative late resource cannot block stop forever or revive terminal acceptance',async()=>{
 const f=fixture(),work=deferred();let disposed=0;
 const result=f.life.runOperation('native_start',()=>work.promise,{disposeLateResult:async()=>{disposed++;return true;}});
 const rejection=rejected(result,'shutdown');const stopping=f.life.stop('shutdown');await rejection;
 await f.clock.advance(10);assert.equal((await stopping).cleanup,'unconfirmed');
 work.resolve({inert:true});await drain();assert.equal(disposed,1);assert.equal(f.life.snapshot().cleanup,'unconfirmed');assert.equal(f.life.snapshot().workPending,0);
 assert.throws(()=>f.life.beginGameplay(),{code:'ct_lifecycle_shutdown'});
});

test('missing/failed late-resource cleanup stays unconfirmed rather than inventing a clean shutdown',async()=>{
 for(const dispose of [undefined,async()=>false,async()=>{throw Error('inert cleanup failure');}]){
  const f=fixture(),work=deferred();const result=f.life.runOperation('owner_prepare',()=>work.promise,{disposeLateResult:dispose});const rejection=rejected(result,'cancelled');const stop=f.life.stop();await rejection;work.resolve({inert:true});await drain();assert.equal((await stop).cleanup,'unconfirmed');assert.equal(f.life.snapshot().lateCleanupFailed,true);
 }
});

test('cleanup has its own finite watchdog and reports uncertainty for a hung original cleanup owner',async()=>{
 const f=fixture({onStop:()=>new Promise(()=>{})});const stop=f.life.stop('shutdown');await f.clock.advance(10);
 assert.equal((await stop).cleanup,'unconfirmed');assert.equal(f.life.snapshot().gameplayStarted,false);
});

test('operation failure is closed metadata, terminal and invokes cleanup once',async()=>{
 const f=fixture();const result=f.life.runOperation('owner_prepare',()=>{throw Error('FIXTURE_PRIVATE_ERROR_MUST_NOT_APPEAR');});
 await rejected(result,'operation_failed');const end=await f.life.completion();assert.equal(end.reason,'operation_failed');assert.equal(JSON.stringify(end).includes('FIXTURE_PRIVATE'),false);assert.equal(f.stops(),1);
});

test('regressing monotonic time fails closed without subtracting spent execution',async()=>{
 const f=fixture();f.life.ready();f.life.beginGameplay();await f.clock.advance(10);f.life.snapshot();f.clock.value=9;
 const observed=f.life.snapshot();assert.equal(observed.reason,'invalid_clock');assert.equal(observed.activeGameplayMs,10);assert.equal((await f.life.completion()).cleanup,'confirmed');
});

test('a slightly early gameplay timer is rearmed rather than dropping the watchdog',async()=>{
 const f=fixture();f.life.ready();f.life.beginGameplay();const [id,scheduled]=[...f.clock.jobs][0];f.clock.jobs.delete(id);f.clock.value=99;scheduled.fn();
 assert.equal(f.life.snapshot().state,'playing');assert.equal(f.clock.jobs.size,1);await f.clock.advance(1);assert.equal((await f.life.completion()).reason,'gameplay_budget_exhausted');
});

test('unknown operations, execution during setup and preparation after play cannot reclassify work',async()=>{
 const f=fixture();let called=0;const work=()=>called++;
 assert.throws(()=>f.life.runOperation('model',work),{code:'ct_lifecycle_wrong_operation_phase'});assert.throws(()=>f.life.runOperation('new_unbounded_operation',work),{code:'ct_lifecycle_invalid_operation'});
 f.life.ready();f.life.beginGameplay();assert.throws(()=>f.life.runOperation('native_prepare',work),{code:'ct_lifecycle_wrong_operation_phase'});assert.equal(called,0);
 assert.throws(()=>f.life.beginGameplay(),{code:'ct_lifecycle_invalid_transition'});await f.life.stop();
});

test('reviewed limits are captured and cannot be replaced to extend an in-flight deadline',async()=>{
 const f=fixture();f.life.ready();f.life.beginGameplay();f.limits.model=3000;
 const result=f.life.runOperation('model',({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('inert cancellation')),{once:true})));const rejection=rejected(result,'operation_timeout');
 await f.clock.advance(30);await rejection;assert.equal((await f.life.completion()).reason,'operation_timeout');
});

test('snapshots are descriptive, immutable and cannot be supplied as resume authority',async()=>{
 const f=fixture();const view=f.life.snapshot();assert(Object.isFrozen(view));assert.throws(()=>{view.state='playing';},TypeError);
 assert.throws(()=>createCtJobLifecycle({...f.options,snapshot:view}),{code:'ct_lifecycle_invalid_options'});await f.life.stop();assert.equal(f.life.check(),false);
});

test('there is no execution default and operation/cleanup bounds must be explicit trusted finite configuration',async()=>{
 const f=fixture();
 for(const patch of [{maximumGameplayMs:undefined},{maximumGameplayMs:90001},{maximumGameplayMs:Infinity},{cleanupTimeoutMs:undefined},{operationLimits:{...f.limits,controller:501}},{operationLimits:{...f.limits,model:120001}},{operationLimits:{...f.limits,hidden:1}},{isCurrent:undefined}])assert.throws(()=>createCtJobLifecycle({...f.options,...patch}));
 await f.life.stop();
});

test('synchronous original revocation during currentness evaluation never returns a current lifecycle',async()=>{
 const external=new AbortController();let revoke=false;
 const f=fixture({signal:external.signal,isCurrent:()=>{if(revoke)external.abort();return true;}});
 revoke=true;assert.equal(f.life.check(),false);assert.equal(f.life.snapshot().reason,'revoked');assert.equal((await f.life.completion()).cleanup,'confirmed');
});

test('revocation during execution readiness cannot resurrect the stopped lifecycle',async()=>{
 const external=new AbortController();
 const f=fixture({signal:external.signal,canExecute:()=>{external.abort();return true;}});f.life.ready();
 assert.throws(()=>f.life.beginGameplay(),{code:'ct_lifecycle_revoked'});const end=await f.life.completion();assert.equal(end.gameplayStarted,false);assert.equal(end.state,'stopped');assert.equal(f.clock.jobs.size,0);
});

test('revocation during a quiescence check cannot turn terminal cancellation into ready/review',async()=>{
 for(const during of ['ready','review']){
  const external=new AbortController();let revoke=false;
  const f=fixture({signal:external.signal,isQuiescent:()=>{if(revoke)external.abort();return true;}});
  if(during==='review'){f.life.ready();f.life.beginGameplay();await f.clock.advance(12);}
  revoke=true;assert.throws(()=>during==='ready'?f.life.ready():f.life.waitForReview(),{code:'ct_lifecycle_revoked'});
  assert.equal((await f.life.completion()).state,'stopped');assert.equal(f.clock.jobs.size,0);
 }
});

test('actual Node timers abort inert hung execution and clear the remaining watchdogs',{timeout:1000},async t=>{
 let stopped=0;const life=createCtJobLifecycle({maximumGameplayMs:20,cleanupTimeoutMs:100,operationLimits:{owner_prepare:100,native_prepare:100,native_start:100,model:500,controller:500,settle:500},isCurrent:()=>true,canExecute:()=>true,isQuiescent:()=>true,onStop:()=>{stopped++;return true;}});
 t.after(()=>life.stop());life.ready();life.beginGameplay();
 const pending=life.runOperation('model',({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('inert real-timer cancellation')),{once:true})));
 await rejected(pending,'gameplay_budget_exhausted');const end=await life.completion();assert.equal(end.reason,'gameplay_budget_exhausted');assert.equal(end.cleanup,'confirmed');assert(end.activeGameplayMs>=20);assert.equal(stopped,1);
});

test('first stop cause is captured before abort/cleanup with no extra current or clock evaluation',async()=>{
 const order=[];let checks=0,nowCalls=0,current=true;const clock=new Clock(),read=clock.now.bind(clock);clock.now=()=>{nowCalls++;return read();};
 const f=fixture({clock,isCurrent:()=>{checks++;return current;},onStopCause:why=>order.push(['cause',why]),onStop:()=>{order.push(['cleanup']);return true;}});
 f.life.signal.addEventListener('abort',()=>order.push(['abort']));const beforeChecks=checks,beforeNow=nowCalls;current=false;assert.equal(f.life.check(),false);
 assert.equal(checks,beforeChecks+1);assert.equal(nowCalls,beforeNow+1);assert.deepEqual(order,[['cause','currentness_lost'],['abort']]);await f.life.completion();assert.deepEqual(order,[['cause','currentness_lost'],['abort'],['cleanup']]);
 await f.life.stop('shutdown');assert.equal(order.filter(v=>v[0]==='cause').length,1);assert.equal(f.life.snapshot().reason,'currentness_lost');
});
test('reporter throw cannot prevent original operation failure rejection, abort or cleanup',async()=>{
 const order=[],f=fixture({onStopCause:why=>{order.push(why);throw Error('Diagnostic refused');}});f.life.signal.addEventListener('abort',()=>order.push('aborted'));
 await rejected(f.life.runOperation('native_start',()=>Promise.reject(Error('Private native error'))),'operation_failed');const end=await f.life.completion();assert.deepEqual(order,['operation_failed','aborted']);assert.equal(end.reason,'operation_failed');assert.equal(end.cleanup,'confirmed');
 assert.throws(()=>fixture({onStopCause:'not-a-port'}),{code:'ct_lifecycle_missing_host_port'});
});
