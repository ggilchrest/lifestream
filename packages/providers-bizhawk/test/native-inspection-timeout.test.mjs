// Original inspection closure with controlled clocks; the only process is /bin/true.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFile,execFileSync} from 'node:child_process';
import {compileFunction} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {types} from 'node:util';
import {captureGameSanityTiming} from '../src/game-sanity-timing.ts';
import {createNativeOwnerFailureWitness} from '../src/native-owner-failure-witness.ts';
import {nativeProcessTimeoutMs} from '../src/owned-c72-native.ts';
const baselineCommit='37dd84ae8b75247fd2898e2ebd8ac41095eb87ff';
const root=new URL('../../../',import.meta.url);
const baseline=execFileSync('git',['show',baselineCommit+':packages/providers-bizhawk/src/owned-c72-native.ts'],{cwd:root,encoding:'utf8'});
const candidate=readFileSync(new URL('../src/owned-c72-native.ts',import.meta.url),'utf8');
function fixture(source,elapsedMs){
 const begin=source.indexOf(' const inspectionOwnerCurrent='),end=source.indexOf(' const acceptWakeProof=',begin);
 assert(begin>=0&&end>begin);
 const original=stripTypeScriptTypes(source.slice(begin,end),{mode:'strip'});
 let monoReads=0,inspectCalls=0,children=0,spawnEvents=0;const timeouts=[],witnesses=new WeakMap();
 const timing=captureGameSanityTiming(),scope={},pins='a'.repeat(64),id='b'.repeat(64);
 const ownerError=(stage,predicate,message)=>{const error=Error(message),witness=createNativeOwnerFailureWitness(stage,predicate,error);if(witness)witnesses.set(error,witness);return error;};
 const ports={types,timing,scope,pins,id,ownerError,
  Date:{now:()=>100000,parse:Date.parse},performance:{now:()=>monoReads++===0?0:elapsedMs},
  facts:{expiresAt:new Date(220000).toISOString()},evidence:{installationAvailable:()=>true},
  inspect:async(selected,running,timeout)=>{
   inspectCalls++;assert.equal(selected,id);assert.equal(running,true);timeouts.push(timeout);
   await new Promise((resolve,reject)=>{
    // execFile validates timeout synchronously, before a child can be returned.
    const child=execFile('/bin/true',[],{timeout},error=>error?reject(error):resolve());
    children++;child.once('spawn',()=>{spawnEvents++;});
   });
  }};
 const declarations='let inspectionOperation,inspectChecked=99000,lastWall=100000,clockCurrent=true,closed=false,nativeSignal=new AbortController().signal,child={pid:123,exitCode:null,signalCode:null},cid=id,verifiedRunning=true,expiresMono=120000,custodyDiagnosticArmed=true;';
 const selected=compileFunction(declarations+original+'\nreturn {refreshInspection,checked:()=>inspectChecked};',Object.keys(ports))(...Object.values(ports));
 return {...selected,timeouts,remaining:timing.readRefreshTimeoutMs-elapsedMs,witnessFor:error=>witnesses.get(error),counts:()=>({inspectCalls,children,spawnEvents})};
}
test('deployed original fractional inspection timeout rejects before /bin/true starts',async()=>{
 const f=fixture(baseline,2.640083999999);
 await assert.rejects(f.refreshInspection(),error=>{assert.equal(error.name,'RangeError');assert.equal(error.code,'ERR_OUT_OF_RANGE');return true;});
 assert.deepEqual(f.timeouts,[14997.359916000001]);assert.deepEqual(f.counts(),{inspectCalls:1,children:0,spawnEvents:0});assert.equal(f.checked(),99000);
});
test('fixed original inspection passes a positive integer timeout without extending remaining time',async()=>{
 const f=fixture(candidate,2.640083999999);await f.refreshInspection();
 assert.equal(f.timeouts.length,1);const timeout=f.timeouts[0];assert(Number.isSafeInteger(timeout));assert(timeout>=1&&timeout<=f.remaining);assert.equal(timeout,14997);
 assert.deepEqual(f.counts(),{inspectCalls:1,children:1,spawnEvents:1});assert.equal(f.checked(),100000);
});
test('less than one millisecond remaining refuses before invoking inspect or starting a process',async()=>{
 const f=fixture(candidate,14999.25);
 await assert.rejects(f.refreshInspection(),error=>{assert.equal(error.name,'Error');assert.equal(error.message,'Native inspection refresh deadline');assert.equal(f.witnessFor(error)?.predicate,'readback_deadline');return true;});
 assert.deepEqual(f.timeouts,[]);assert.deepEqual(f.counts(),{inspectCalls:0,children:0,spawnEvents:0});assert.equal(f.checked(),99000);
});
test('actual subprocess boundary rounds every supported allowance down and refuses invalid or exhausted budgets',async()=>{
 for(const [remaining,expected] of [[1,1],[1.999,1],[14997.359916000001,14997],[120000,120000]])assert.equal(nativeProcessTimeoutMs(remaining),expected);
 let calls=0;
 const start=(...args)=>{calls++;return execFile(...args);};
 for(const remaining of [undefined,null,true,'15000',NaN,Infinity,-Infinity,-1,0,0.75,120000.001,4294967296])assert.throws(()=>start('/bin/true',[],{timeout:nativeProcessTimeoutMs(remaining)}),/Native subprocess timeout budget unavailable/);
 assert.equal(calls,0);
 await new Promise((resolve,reject)=>start('/bin/true',[],{timeout:nativeProcessTimeoutMs(14997.359916000001)},error=>error?reject(error):resolve()));
 assert.equal(calls,1);
});
