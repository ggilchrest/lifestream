import {createNativeOwnerFailureWitness} from '../src/native-owner-failure-witness.ts';
import {captureGameSanityTiming} from '../src/game-sanity-timing.ts';
import {createNativeInspectionTiming} from '../src/native-refresh-timing.ts';
import {types} from 'node:util';
// Exact selected physical-owner closure; no engine, child, filesystem or authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileFunction} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const source=readFileSync(process.env.CT_INSPECTION_OWNER??new URL('../src/owned-c72-native.ts',import.meta.url),'utf8');
const a=source.search(/const inspectionOwnerCurrent\s*=/),tail=source.slice(a),b=tail.search(/const acceptWakeProof\s*=/);assert(a>=0&&b>0);const selected=stripTypeScriptTypes(tail.slice(0,b),{mode:'strip'});
export function createInspectionFixture(sanityTiming={}){
 let timeoutReads=0;let wall=102500,mono=3500,calls=0,sourceCurrent=true,sourceReads=0,postSourceCost=0;const signal=new AbortController(),scope={},pins='a'.repeat(64),id='b'.repeat(64);let release,reject;const originalInspect=new Promise((yes,no)=>{release=yes;reject=no;});
 const reports=[],witnesses=new WeakMap();const ownerError=(stage,predicate,message)=>{const error=Error(message),witness=createNativeOwnerFailureWitness(stage,predicate,error);if(witness)witnesses.set(error,witness);return error;};
 const args={ownerError,types,createNativeOwnerFailureWitness,reportNativeOpenFailure:(stage,error,fallback)=>{reports.push({stage,witness:witnesses.get(error)??fallback});},timing:captureGameSanityTiming(sanityTiming),Date:{now:()=>wall,parse:Date.parse},performance:{now:()=>mono},facts:{expiresAt:new Date(220000).toISOString()},scope,pins,evidence:{installationAvailable:(s,p)=>{sourceReads++;if(sourceReads>1){wall+=postSourceCost;mono+=postSourceCost;}return sourceCurrent&&s===scope&&p===pins;}},inspect:async(cid,running)=>{calls++;if(timeoutReads-->0)throw Object.assign(Error('Read timeout'),{code:'ETIMEDOUT'});assert.equal(cid,id);assert.equal(running,true);await originalInspect;}};
 const body="let inspectionOperation,inspectChecked=100000,lastWall=100000,clockCurrent=true,closed=false,nativeSignal=signal,child={pid:123,exitCode:null,signalCode:null},cid=id,verifiedRunning=true,expiresMono=121000,custodyDiagnosticArmed=true;"+selected+"\nreturn {refreshCustody,refreshInspection,age:()=>Date.now()-inspectChecked,state:()=>({inspectChecked,clockCurrent}),close:()=>{closed=true;},changeCid:()=>{cid='c'.repeat(64);}};";
 const measured=createNativeInspectionTiming(()=>mono);
 const ports=compileFunction(body,[...Object.keys(args),'signal','id','inspectionTiming'])(...Object.values(args),signal.signal,id,measured);
 return {...ports,reports,witnessFor:error=>witnesses.get(error),timeoutOnce:()=>{timeoutReads=1;},signal:signal.signal,release,reject,onInspectionResult:callback=>originalInspect.then(callback),calls:()=>calls,abort:()=>signal.abort(),ownerChanged:()=>{sourceCurrent=false;},postSourceCost:value=>{postSourceCost=value;},wall:value=>{wall=value;},mono:value=>{mono=value;}};
}
test('refresh awaits the exact unresolved original poll operation and coalesces without another inspection',async()=>{
 const f=createInspectionFixture(),poll=f.refreshInspection();void poll.catch(()=>{});let settled=false;const wait=f.refreshCustody(f.signal).then(()=>{settled=true;});await Promise.resolve();await Promise.resolve();assert.equal(f.calls(),1);assert.equal(settled,false);assert.equal(f.age(),2500);f.release();await Promise.all([poll,wait]);assert.equal(f.calls(),1);assert.equal(f.age(),0);
});
for(const age of [0,499])test('explicit demand refreshes a '+age+'ms cache before1614ms source qualification',async()=>{
 const f=createInspectionFixture();f.wall(100000+age);f.postSourceCost(1614);
 let settled=false;const wait=f.refreshCustody(f.signal).then(()=>{settled=true;});
 await Promise.resolve();await Promise.resolve();assert.equal(f.calls(),1);assert.equal(settled,false);
 f.release();await wait;assert.equal(f.state().inspectChecked,100000+age);assert.equal(f.age(),1614);
});
test('a caller queued after completed demand starts another exact inspection',async()=>{
 const f=createInspectionFixture(),first=f.refreshCustody(f.signal);
 const next=first.then(()=>f.refreshCustody(f.signal));
 await Promise.resolve();f.release();await next;assert.equal(f.calls(),2);
});
test('a pre-registered inspect-result reaction joins pending qualification, never completed cache',async()=>{
 const f=createInspectionFixture();let joined;
 const reaction=f.onInspectionResult(()=>{joined=f.refreshCustody(f.signal);});
 const first=f.refreshCustody(f.signal);await Promise.resolve();f.release();
 await reaction;await Promise.all([first,joined]);assert.equal(f.calls(),1);
 await f.refreshCustody(f.signal);assert.equal(f.calls(),2);
});
for(const [change,predicate] of [['abort','signal_current'],['ownerChanged','installation_current'],['close','owner_closed'],['changeCid','cid_current']])test('late inspection after '+change+' cannot publish or qualify its cache',async()=>{
 const f=createInspectionFixture(),poll=f.refreshInspection();void poll.catch(()=>{});const wait=f.refreshCustody(f.signal);void wait.catch(()=>{});await Promise.resolve();f[change]();f.release();await assert.rejects(wait,/^Error: Native inspection refresh (cancelled|unavailable)$/);await assert.rejects(poll,error=>{assert.equal(error.name,'Error');assert.deepEqual(f.witnessFor(error),{stage:'inspect-poll',predicate,exceptionClass:'Error'});return true;});assert.equal(f.state().inspectChecked,100000);
});
for(const [clock,value,predicate] of [['wall',220000,'native_wall_current'],['mono',121000,'native_monotonic_current'],['wall',99999,'clock_current']])test('original native '+clock+' bound remains authoritative at completion '+value,async()=>{
 const f=createInspectionFixture(),poll=f.refreshInspection(),wait=f.refreshCustody(f.signal);void poll.catch(()=>{});void wait.catch(()=>{});await Promise.resolve();f[clock](value);f.release();await assert.rejects(wait,/^Error: Native inspection refresh unavailable$/);await assert.rejects(poll,error=>{assert.equal(f.witnessFor(error)?.predicate,predicate);return true;});assert.equal(f.state().inspectChecked,100000);
});
test('failed original exact inspection rejects without cache publication or retry',async()=>{const f=createInspectionFixture(),poll=f.refreshInspection(),wait=f.refreshCustody(f.signal),error=Error('Exact inspect refused');void poll.catch(()=>{});void wait.catch(()=>{});await Promise.resolve();f.reject(error);await assert.rejects(wait,/^Error: Native inspection refresh unavailable$/);await assert.rejects(poll,caught=>caught===error);assert.equal(f.calls(),1);assert.equal(f.state().inspectChecked,100000);});
test('poll remains a500ms cadence and inspection execution gets the captured bounded read timeout',()=>{assert.match(source,/poll\s*=\s*setInterval\([\s\S]*?refreshInspection\(\)\.catch\(error=>ownedFailure\('inspect-poll','inspection_rejected',error\)\)[\s\S]*?},\s*500\)/);assert.match(source,/execute\(\['inspect',\s*'--format',\s*inspectTemplate,\s*expected\],\s*timeoutMs\)/);});

test('truly stale post-inspection qualification cannot hide the actual completion age',async()=>{const f=createInspectionFixture();f.postSourceCost(30001);const poll=f.refreshInspection(),wait=f.refreshCustody(f.signal);void poll.catch(()=>{});void wait.catch(()=>{});await Promise.resolve();f.release();await assert.rejects(wait,/^Error: Native inspection refresh unavailable$/);await assert.rejects(poll,error=>{assert.equal(f.witnessFor(error)?.predicate,'inspect_fresh');return true;});assert.equal(f.state().inspectChecked,100000);assert.equal(f.calls(),1);});
test('bounded source validation publishes the actual inspection completion time, not the later qualification time',async()=>{const f=createInspectionFixture();f.postSourceCost(700);const wait=f.refreshCustody(f.signal);await Promise.resolve();f.release();await wait;assert.equal(f.state().inspectChecked,102500);assert.equal(f.age(),700);});

test('clock reversal during post-inspection source validation refuses publication without retry',async()=>{const f=createInspectionFixture();f.postSourceCost(-1);const poll=f.refreshInspection(),wait=f.refreshCustody(f.signal);void poll.catch(()=>{});void wait.catch(()=>{});await Promise.resolve();f.release();await assert.rejects(wait,/^Error: Native inspection refresh unavailable$/);await assert.rejects(poll,error=>{assert.equal(f.witnessFor(error)?.predicate,'inspect_clock_current');return true;});assert.equal(f.state().inspectChecked,100000);assert.equal(f.state().clockCurrent,false);assert.equal(f.calls(),1);});

test('loaded4s qualification fits the default30s sanity window without moving completion timestamp',async()=>{const f=createInspectionFixture();f.postSourceCost(4000);const pending=f.refreshCustody(f.signal);await Promise.resolve();f.release();await pending;assert.equal(f.state().inspectChecked,102500);assert.equal(f.age(),4000);});
test('one classified read timeout retries only inspection with the same owner',async()=>{const f=createInspectionFixture();f.timeoutOnce();const pending=f.refreshCustody(f.signal);await Promise.resolve();await Promise.resolve();f.release();await pending;assert.equal(f.calls(),2);});
test('genuinely stuck read has a finite watchdog and cancellation remains prompt',async()=>{const f=createInspectionFixture({readRefreshTimeoutMs:30});await assert.rejects(f.refreshCustody(f.signal),/deadline/);assert.equal(f.calls(),1);f.release();});
test('explicit short sanity configuration remains finite, not an authorization extension',async()=>{const f=createInspectionFixture({inspectionFreshnessMs:2000});f.postSourceCost(2001);const poll=f.refreshInspection(),pending=f.refreshCustody(f.signal);void poll.catch(()=>{});await Promise.resolve();f.release();await assert.rejects(pending,/^Error: Native inspection refresh unavailable$/);await assert.rejects(poll,error=>{assert.equal(f.witnessFor(error)?.predicate,'inspect_fresh');return true;});});


test('demand-owned refresh reports original classified failure before client rejection',async()=>{
 const f=createInspectionFixture(),pending=f.refreshCustody(f.signal);await Promise.resolve();f.ownerChanged();f.release();
 await assert.rejects(pending,/Native inspection refresh unavailable/);
 assert.deepEqual(f.reports,[{stage:'inspect-poll',witness:{stage:'inspect-poll',predicate:'installation_current',exceptionClass:'Error'}}]);
 assert.equal(f.calls(),1);assert.equal(f.state().inspectChecked,100000);
});
test('demand-owned read deadline reports its cause exactly once and ignores late failure',async()=>{
 const f=createInspectionFixture({readRefreshTimeoutMs:20}),pending=f.refreshCustody(f.signal);
 await assert.rejects(pending,/Native inspection refresh deadline/);
 assert.deepEqual(f.reports,[{stage:'inspect-poll',witness:{stage:'inspect-poll',predicate:'readback_deadline',exceptionClass:'Error'}}]);
 f.reject(Object.assign(Error('PRIVATE error'),{code:'EIO'}));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.reports.length,1);
});
test('caller cancellation of demand refresh cannot become a late inspection failure report',async()=>{
 const f=createInspectionFixture(),pending=f.refreshCustody(f.signal);await Promise.resolve();f.abort();await assert.rejects(pending,/cancelled/);
 f.reject(Error('PRIVATE error'));await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.reports,[]);
});
test('raw demand inspection rejection exports only bounded original errno witness',async()=>{
 const f=createInspectionFixture(),pending=f.refreshCustody(f.signal);await Promise.resolve();f.reject(Object.assign(Error('PRIVATE error'),{code:'EIO',nonce:'PRIVATE'}));await assert.rejects(pending,/unavailable/);
 assert.deepEqual(f.reports,[{stage:'inspect-poll',witness:{stage:'inspect-poll',predicate:'inspection_rejected',exceptionClass:'Error',errno:'EIO'}}]);assert(!JSON.stringify(f.reports).includes('PRIVATE'));
});
