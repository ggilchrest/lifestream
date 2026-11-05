// Actual original openNative function; all effects are controlled inert ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileFunction} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {isDeepStrictEqual,types} from 'node:util';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {captureGameSanityTiming} from '../src/game-sanity-timing.ts';
import {createNativeOwnerFailureWitness} from '../src/native-owner-failure-witness.ts';
import {nativeSourceException} from '../src/native-source-witness.ts';
const root=new URL('../../../',import.meta.url);
const source=readFileSync(new URL('../src/owned-c72-native.ts',import.meta.url),'utf8');
const original=execFileSync('git',['show','3dbd50f4f3bdce683f9495170761cc2d0c6b76cb:packages/providers-bizhawk/src/owned-c72-native.ts'],{cwd:root,encoding:'utf8'});
function program(raw){
 const start=raw.indexOf(' const openNative=async('),end=raw.indexOf('\n return Object.freeze({evidence,openNative',start);
 assert(start>0&&end>start);
 const diagnostic=raw.includes(' const nativeOpenErrnos=')?raw.slice(raw.indexOf(' const nativeOpenErrnos='),start):'';
 const ownerStart=raw.indexOf(' const ownerFailureWitnesses='),ownerEnd=raw.indexOf(' let inspectionOperation:',ownerStart);
 const owner=ownerStart>=0?raw.slice(ownerStart,ownerEnd):'';
 return stripTypeScriptTypes(owner+diagnostic+raw.slice(start,end),{mode:'strip'});
}
function fixture({baseline=false,failAt,error=Error('PRIVATE original failure'),cleanupError,callbackThrows=false,sourceAvailable=true}={}){
 const trace=[],records=[],events=[],scope={},pins='PRIVATE pin',facts={runDirectory:'/CONTROLLED',expiresAt:'2099-01-01T00:00:00.000Z',wrapper:{path:'/CONTROLLED/wrapper'},continuation:{opaque:'PRIVATE'},imagePins:{},romSha1:'PRIVATE'},context={signal:new AbortController().signal,isCurrent:()=>{trace.push('scopeCurrent');return true;}};
 const step=(name,result)=>{trace.push(name);if(name===failAt)throw error;return result;};
 const transport={ready:Promise.resolve(),adapter:{applyController:()=>{}}};
 const child={once:name=>step('child.once:'+name),stdin:{on:name=>step('stdin.on:'+name)}};
 const ports={timing:captureGameSanityTiming(),createNativeOwnerFailureWitness,sourcePins:{},types,nativeSourceException,isDeepStrictEqual,join,scope,pins,facts,options:{configurationFile:'/CONTROLLED/facts',native:{sessionDurationMs:80000}},testBoundary:{spawn:()=>step('spawn',child),listen:async()=>step('listen',{connected:Promise.resolve(transport)})},plan:{argv:['CONTROLLED']},cidPattern:/^[a-f0-9]{64}$/,
  Date:{now:()=>step('wall',100),parse:()=>step('expiry',100000)},performance:{now:()=>step('mono',100)},setInterval:()=>step('poll',{unref(){trace.push('unref');}}),setTimeout,clearTimeout,
  current:()=>step('current',true),readC72NativeConfiguration:()=>step('readFacts',facts),writeFileSync:()=>step('consume'),scopeDigest:()=>step('scopeDigest','CONTROLLED'),
  freshCidTargets:()=>step('freshCid'),execute:async()=>step('create','a'.repeat(64)),readEngineCid:()=>step('engineCid','a'.repeat(64)),inspect:async(_cid,running)=>step('inspect:'+running),publishCid:()=>step('publish'),readCid:()=>step('readCid','a'.repeat(64)),
  environment:()=>step('environment',{}),evidence:{bindOwnedProcess:()=>step('bindProcess'),admitRelease:()=>{},evidenceFile:'/CONTROLLED/evidence',sourceAvailable:()=>step('sourceAvailable',sourceAvailable)},ownedFailure:()=>{},prepared:()=>{step('prepared');return Promise.resolve();},
  writeRecord:async record=>step('write:'+record.phase),takePairing:async()=>step('pair',Buffer.alloc(32,7)),refreshCustody:()=>{},captureWakePreludeConfiguration:()=>assert.fail('No wake branch'),nativeBridgeEnvironment:()=>step('bridge',{}),refreshInspection:()=>{},custodyCurrent:()=>step('custody',true),acceptWakeProof:()=>step('wake',true),nativeExecutionCustodyBounds:()=>assert.fail('No lifetime fixture'),
  close:async()=>{events.push('cleanup');trace.push('cleanup');if(cleanupError)throw cleanupError;},
  reportCustodyFailure:value=>{events.push('diagnostic');records.push(value);if(callbackThrows)throw Error('PRIVATE sink');},
  context,launch:{host:'127.0.0.1',port:12345,continuation:facts.continuation}};
 const declarations='let closed=false,launchConsumed=false,nativeSignal,createOperation,createAttempted=false,cid,child,host,transport,verifiedRunning=false,inspectChecked=0,poll,inspectionOperation,custodyDiagnosticArmed=false,lastAction,expiresMono=100000;const nonce="PRIVATE nonce";';
 const make=compileFunction(declarations+program(baseline?original:source)+'\nreturn ()=>openNative({},context,launch);',Object.keys(ports));
 return {open:make(...Object.values(ports)),trace,records,events,error};
}
test('engine create original rejection captured before cleanup can replace it',async()=>{
 const error=Object.assign(Error('PRIVATE message'),{code:125,stdout:'PRIVATE stdout',stderr:'PRIVATE stderr',path:'/PRIVATE',cmd:'PRIVATE argv'}),replacement=Error('PRIVATE cleanup');
 const f=fixture({failAt:'create',error,cleanupError:replacement});await assert.rejects(f.open(),e=>e===replacement);
 assert.deepEqual(f.events,['diagnostic','cleanup']);assert.deepEqual(f.records,[{schemaVersion:'ct-runtime-first-cause/1',source:'native',phase:'native-open',reason:'open_failed',nativeOpenWitness:{stage:'create',exceptionClass:'Error',exitCode:125,stderrClass:'unclassified'}}]);assert(!JSON.stringify(f.records).includes('PRIVATE'));
});
test('later native listener failure records original phase and allowlisted errno',async()=>{
 const error=Object.assign(TypeError('PRIVATE'),{code:'EADDRINUSE'}),f=fixture({failAt:'listen',error});await assert.rejects(f.open(),e=>e===error);
 assert.deepEqual(f.events,['diagnostic','cleanup']);assert.deepEqual(f.records[0].nativeOpenWitness,{stage:'listen',exceptionClass:'TypeError',errno:'EADDRINUSE'});
});
test('healthy original port/read/clock sequence and result unchanged, no success telemetry',async()=>{
 const before=fixture({baseline:true}),after=fixture();const a=await before.open(),b=await after.open();assert.deepEqual(after.trace,before.trace);assert.deepEqual(Object.keys(b),Object.keys(a));assert.deepEqual(after.records,[]);assert.deepEqual(after.events,[]);
});
test('diagnostic sink exception leaves original failure/cleanup and operation sequence unchanged',async()=>{
 const before=fixture({baseline:true,failAt:'create'}),after=fixture({failAt:'create',callbackThrows:true});await assert.rejects(before.open(),e=>e===before.error);await assert.rejects(after.open(),e=>e===after.error);assert.deepEqual(after.trace,before.trace);assert.deepEqual(after.events,['diagnostic','cleanup']);
});
for(const [name,code] of [['private string','PRIVATE'],['negative',-1],['oversized',256],['fraction',1.5]])test('error code omits '+name,async()=>{
 const f=fixture({failAt:'create',error:Object.assign(Error('PRIVATE'),{code})});await assert.rejects(f.open(),e=>e===f.error);assert.deepEqual(f.records[0].nativeOpenWitness,{stage:'create',exceptionClass:'Error'});assert(!JSON.stringify(f.records).includes('PRIVATE'));
});
test('error code getter and proxy traps are never invoked',async()=>{
 let reads=0;const error=Error('PRIVATE');Object.defineProperty(error,'code',{get(){reads++;throw Error('PRIVATE');}});const a=fixture({failAt:'create',error});await assert.rejects(a.open(),e=>e===a.error);assert.equal(reads,0);assert.deepEqual(a.records[0].nativeOpenWitness,{stage:'create',exceptionClass:'Error'});
 const proxy=new Proxy(error,{get(){reads++;throw Error('PRIVATE');},getPrototypeOf(){reads++;throw Error('PRIVATE');},getOwnPropertyDescriptor(){reads++;throw Error('PRIVATE');}});const b=fixture({failAt:'create',error:proxy});let caught;try{await b.open();}catch(e){caught=e;}assert.equal(caught,proxy);assert.equal(reads,0);assert.deepEqual(b.records[0].nativeOpenWitness,{stage:'create',exceptionClass:'Other'});
});
test('original pre-cleanup guard/fact/consume failures keep their no-cleanup behavior',async()=>{
 for(const [failAt,stage] of [['current','guard'],['readFacts','facts'],['consume','consume']]){const before=fixture({baseline:true,failAt}),after=fixture({failAt});await assert.rejects(before.open(),e=>e===before.error);await assert.rejects(after.open(),e=>e===after.error);assert.deepEqual(after.trace,before.trace);assert.deepEqual(after.events,['diagnostic']);assert.equal(after.records[0].nativeOpenWitness.stage,stage);}
});

for(const [name,stderr,expected] of [
 ['known cached boot error','PRIVATE prefix: current system boot ID differs from cached boot ID: PRIVATE suffix','cached_boot_id_mismatch'],
 ['other private stderr','PRIVATE unrelated output','unclassified'],['empty stderr','','empty'],
 ['oversized stderr','x'.repeat(8193),undefined],['oversized UTF8 stderr','é'.repeat(8192),undefined],['non-string stderr',Buffer.from('PRIVATE'),undefined]
])test('stderr classification '+name+' never retains original output',async()=>{
 const f=fixture({failAt:'create',error:Object.assign(Error('PRIVATE'),{code:125,stderr})});await assert.rejects(f.open(),e=>e===f.error);
 const witness=f.records[0].nativeOpenWitness;assert.deepEqual(witness,{stage:'create',exceptionClass:'Error',exitCode:125,...(expected?{stderrClass:expected}:{})});assert(!JSON.stringify(f.records).includes('PRIVATE'));
});
test('stderr accessor is not invoked',async()=>{
 let reads=0;const error=Error('PRIVATE');Object.defineProperty(error,'stderr',{get(){reads++;return 'PRIVATE';}});
 const f=fixture({failAt:'create',error});await assert.rejects(f.open(),e=>e===f.error);assert.equal(reads,0);assert.deepEqual(f.records[0].nativeOpenWitness,{stage:'create',exceptionClass:'Error'});
});

test('final original source guard keeps its false outcome and captures that exact predicate before cleanup',async()=>{
 const before=fixture({baseline:true,sourceAvailable:false}),after=fixture({sourceAvailable:false});
 for(const f of [before,after])await assert.rejects(f.open(),{name:'Error',message:'Native readback unavailable'});
 assert.deepEqual(after.trace,before.trace);assert.deepEqual(after.events,['diagnostic','cleanup']);
 assert.deepEqual(after.records[0].nativeOpenWitness,{stage:'readback',predicate:'source_available',exceptionClass:'Error'});
});
