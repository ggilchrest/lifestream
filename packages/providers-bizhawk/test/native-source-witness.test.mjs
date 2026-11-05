// Same-call metadata only; own fixture files and inert clocks/child callbacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createNativeExecutionLifetime} from '../src/native-execution-lifetime.ts';
import {NativeGameEvidence} from '../src/native-evidence.ts';
import {nativeSourceWitness,captureNativeSource,nativeSourceException} from '../src/native-source-witness.ts';
import {observe} from './game-host-fixtures.ts';
function fixture(t,lifetime=false){
 const dir=mkdtempSync(join(tmpdir(),'native-source-witness-')),source=join(dir,'source');writeFileSync(source,'fixture');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let now=100000,mono=100,current=true,custody=true,wallReads=0,monoReads=0,currentReads=0,custodyReads=0,lifetimeCurrent=true;
 t.mock.method(Date,'now',()=>{wallReads++;return now;});t.mock.method(performance,'now',()=>{monoReads++;return mono;});
 const executionLifetime=lifetime?createNativeExecutionLifetime(Object.freeze({signal:new AbortController().signal,check:()=>lifetimeCurrent}),new Date(now+120000).toISOString()):undefined;
 const scope=observe().scope,pins='a'.repeat(64),evidence=new NativeGameEvidence({directory:dir,scope,pinsDigest:pins,providerRef:'synthetic',romSha1:'b'.repeat(40),sourceFiles:[{path:source,sha256:createHash('sha256').update('fixture').digest('hex')}],custody:{},sessionDurationMs:120000,...(executionLifetime?{executionLifetime}:{}),isCurrent:()=>{currentReads++;if(current instanceof Error)throw current;return current;},ownedCustodyCurrent:capture=>{custodyReads++;if(typeof custody==='function')return custody(capture);return custody;}}),child={pid:1,exitCode:null,signalCode:null};evidence.bindOwnedProcess(child);
 const snapshot={schemaVersion:'1.0.0',recordType:'nativeGameEvidence',scope,pinsDigest:pins,providerRef:'synthetic',version:'2.11.1',system:'SNES',romSha1:'b'.repeat(40),sequence:1,frameNumber:84569,monotonicMs:mono,checkedAt:new Date(now).toISOString(),buttonsAvailable:true,buttons:Object.fromEntries(['Up','Down','Left','Right','A','B','X','Y','L','R','Start','Select'].map(k=>[k,false])),event:'idle'};
 const write=v=>writeFileSync(evidence.evidenceFile,typeof v==='string'?v:JSON.stringify(v));write(snapshot);
 const reset=()=>{wallReads=monoReads=currentReads=custodyReads=0;};reset();
 return {evidence,scope,pins,snapshot,child,write,source,reset,counts:()=>({wallReads,monoReads,currentReads,custodyReads}),withdrawLifetime:()=>lifetimeCurrent=false,current:v=>current=v,custody:v=>custody=v,advance:n=>{now+=n;mono+=n;}};
}
test('successful original checks emit no witness and preserve exact clock/callback counts',t=>{const f=fixture(t),events=[];assert.equal(f.evidence.sourceAvailable(f.scope,f.pins,v=>events.push(v)),true);assert.deepEqual(events,[]);assert.deepEqual(f.counts(),{wallReads:3,monoReads:1,currentReads:1,custodyReads:1});});
test('snapshot null is deferred until original proof-presence guard, not an earlier rejected pins/owned check',t=>{
 const f=fixture(t);f.write({...f.snapshot,version:'wrong'});let witness;
 assert.equal(f.evidence.sourceAvailable(f.scope,'c'.repeat(64),v=>witness=v),false);assert.deepEqual(witness,{stage:'source',predicate:'source_pins'});assert.equal(f.counts().custodyReads,0);
 f.reset();witness=undefined;f.custody(capture=>{captureNativeSource(capture,{stage:'custody-pre',predicate:'inspect_not_fresh',ageMs:2001});return false;});assert.equal(f.evidence.sourceAvailable(f.scope,f.pins,v=>witness=v),false);assert.deepEqual(witness,{stage:'custody-pre',predicate:'inspect_not_fresh',ageMs:2001});assert.equal(f.counts().currentReads,0);
 f.custody(true);assert.equal(f.evidence.sourceAvailable(f.scope,f.pins,v=>witness=v),false);assert.deepEqual(witness,{stage:'snapshot',predicate:'snapshot_version'});
});
test('valid snapshot sequence/monotonic state advances even when original later pins rejects',t=>{const f=fixture(t);f.write({...f.snapshot,sequence:9,monotonicMs:777});assert.equal(f.evidence.sourceAvailable(f.scope,'c'.repeat(64)),false);assert.equal(f.evidence.lastSequence,9);assert.equal(f.evidence.lastMono,777);});
test('read/parse exceptions identify original operation and fixed class, with no arbitrary text',t=>{const f=fixture(t);f.write('{not-json');let w;assert.equal(f.evidence.sourceAvailable(f.scope,f.pins,v=>w=v),false);assert.deepEqual(w,{stage:'snapshot',predicate:'snapshot_read_parse',exceptionClass:'SyntaxError'});assert(!JSON.stringify(w).includes('not-json'));});
test('original current callback throw differs from a throwing metadata sink; neither is reevaluated',t=>{const f=fixture(t);f.current(new TypeError('PRIVATE arbitrary body'));let w;assert.equal(f.evidence.sourceAvailable(f.scope,f.pins,v=>{w=v;throw new RangeError('SINK PRIVATE');}),false);assert.deepEqual(w,{stage:'source',predicate:'source_current',exceptionClass:'TypeError'});assert.equal(f.counts().currentReads,1);assert.equal(f.counts().custodyReads,1);assert(!JSON.stringify(w).includes('PRIVATE'));});
test('source file stat exception retains original Error class, not a previous successful digest guard',t=>{const f=fixture(t);rmSync(f.source);let w;assert.equal(f.evidence.sourceAvailable(f.scope,f.pins,v=>w=v),false);assert.deepEqual(w,{stage:'files',predicate:'file_stat',exceptionClass:'Error'});});
test('closed witness rejects arbitrary combinations, getters, proxies, bool ages, overflow and extra identities without traps',()=>{
 let traps=0;const valid={stage:'custody-pre',predicate:'inspect_not_fresh',ageMs:2001};assert.deepEqual(nativeSourceWitness(valid),valid);
 const getter={stage:'custody-pre',predicate:'inspect_not_fresh'};Object.defineProperty(getter,'ageMs',{enumerable:true,get(){traps++;throw Error();}});
 for(const invalid of [getter,new Proxy(valid,{get(){traps++;throw Error();},ownKeys(){traps++;throw Error();},getPrototypeOf(){traps++;throw Error();}}),{...valid,stage:'snapshot'},{...valid,ageMs:true},{...valid,ageMs:600002},{...valid,ageMs:2.5},{...valid,nonce:'PRIVATE'},{stage:'snapshot',predicate:'snapshot_read_parse'},{stage:'source',predicate:'source_current',exceptionClass:'PRIVATE'},{...valid,exceptionClass:'Error'}])assert.equal(nativeSourceWitness(invalid),undefined);
 const proxy=new Proxy({},{getPrototypeOf(){traps++;throw Error();}});assert.equal(nativeSourceException(proxy),'Other');assert.equal(nativeSourceException(Object.create(proxy)),'Other');assert.equal(traps,0);
});

test('original sourceAvailable delegates the SAME local capture into opaque lifetime check before outer fallback',t=>{const f=fixture(t,true);f.withdrawLifetime();let witness;assert.equal(f.evidence.sourceAvailable(f.scope,f.pins,v=>witness=v),false);assert.deepEqual(witness,{stage:'lifetime-pre',predicate:'check_returned_true'});assert.equal(f.counts().currentReads,0,'Later source callback stays short-circuited');});
