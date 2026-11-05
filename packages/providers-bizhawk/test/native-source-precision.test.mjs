import {captureGameSanityTiming} from '../src/game-sanity-timing.ts';
import {types} from 'node:util';
// Original selected closures and inert synthetic native receipts only.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {join} from 'node:path';
import {compileFunction} from 'node:vm';import {stripTypeScriptTypes} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import {captureNativeSource,nativeSourceAge,nativeSourceException} from '../src/native-source-witness.ts';
const root=process.env.NATIVE_PRECISION_SOURCE?new URL('file://'+process.env.NATIVE_PRECISION_SOURCE+'/packages/providers-bizhawk/src/'):new URL('../src/',import.meta.url);
const selectedOwner=readFileSync(new URL('owned-c72-native.ts',root),'utf8'),selectedLifetime=readFileSync(new URL('native-execution-lifetime.ts',root),'utf8');
const baseline=process.env.NATIVE_PRECISION_BASELINE;
function custody(source,change={}){
 const a=source.indexOf(' let custodyDiagnosticArmed='),b=source.indexOf(' const evidence=',a);assert(a>=0&&b>a);
 const selected=stripTypeScriptTypes(source.slice(a,b),{mode:'strip'}),events=[],reads=[];let wall=change.preWall??100000,mono=change.preMono??100,wallReads=0,monoReads=0;
 const scope={},pins='a'.repeat(64),nonce='b'.repeat(32),image='c'.repeat(64),sourcePins={fixed:true},imagePins={fixed:true};
 const receipt={schemaVersion:'ct-native-custody/1',invocation:nonce,image,scopeDigest:'d'.repeat(64),pinsDigest:pins,sourcePins,imagePins,viewable:true,startupPaused:true,pid:15,startTicks:1,sequence:3,checkedAtMs:wall,configSha256:'e'.repeat(64),...change.receipt};
 const childData={pid:10,exitCode:null,signalCode:null,...change.child},child={};for(const key of Object.keys(childData))Object.defineProperty(child,key,{get(){reads.push('child.'+key);return childData[key];}});
 const facts={runDirectory:'/synthetic-only',expiresAt:new Date(change.expiryWall??220000).toISOString(),imagePins},deps={types,timing:captureGameSanityTiming({inspectionFreshnessMs:2000,receiptFreshnessMs:3000,noProgressTimeoutMs:3000}),captureNativeSource,nativeSourceAge,nativeSourceException,options:{onFailure:v=>events.push({probe:v.reason})},Date:{now:()=>{wallReads++;return wall;},parse:Date.parse},performance:{now:()=>{monoReads++;return mono;}},JSON:{parse:s=>{const data=JSON.parse(s),out={};for(const key of Object.keys(data))Object.defineProperty(out,key,{enumerable:true,get(){reads.push('receipt.'+key);return data[key];}});return out;}},readNativeFile:()=>{wall+=change.postWall??0;mono+=change.postMono??0;return Buffer.from(JSON.stringify(receipt));},join,isDeepStrictEqual,scopeDigest:()=>{reads.push('scopeDigest');return 'd'.repeat(64);},fileDigest:()=>assert.fail('No wake receipt read'),facts,scope,pins,nonce,C72_IMAGE:image,sourcePins,child};
 deps.readNativePublishedFile=deps.readNativeFile;
 const state="let closed=false,lastWall=100000,clockCurrent="+(change.clockCurrent??true)+",expiresMono=120000,cid="+JSON.stringify(change.cid??'x')+",verifiedRunning="+(change.running??true)+",inspectChecked="+(change.inspection??100000)+",lastSequence="+(change.priorSequence??0)+",lastReceiptWall=0,lastReceiptMono=0,startTicks="+(change.priorProcess?'1':'undefined')+",monoPid=15,configurationHash='e'.repeat(64),wakeProof=null;";
 const run=compileFunction(state+selected+'\ncustodyDiagnosticArmed=true;return {check:custodyCurrent,peek:()=>({lastSequence,startTicks,clockCurrent})};',Object.keys(deps))(...Object.values(deps));
 let witness;const result=run.check(v=>{witness=v;events.push({witness:v});});return {result,witness,events,reads,counts:{wallReads,monoReads},state:run.peek()};
}
const mismatches=[
 ['inspect_not_fresh',{preWall:102001,witnessAge:2001},'custody-pre'],['receipt_stale',{receipt:{checkedAtMs:96999},witnessAge:3001}],['receipt_sequence_stalled',{priorSequence:3,postMono:3001,witnessAge:3101}],
 ['cid_present',{cid:''},'custody-pre'],['verified_running_true',{running:false},'custody-pre'],['wall_not_regressed',{preWall:99999},'custody-pre'],['clock_latch_current',{clockCurrent:false},'custody-pre'],['monotonic_before_expiry',{preMono:120000},'custody-pre'],['wall_before_expiry',{preWall:220000,inspection:220000},'custody-pre'],['monotonic_before_expiry',{postMono:120000}],['wall_before_expiry',{expiryWall:100500,postWall:500}],
 ['receipt_schema_matches',{receipt:{schemaVersion:'wrong'}}],['receipt_invocation_matches',{receipt:{invocation:'wrong'}}],['receipt_image_matches',{receipt:{image:'wrong'}}],['receipt_scope_digest_matches',{receipt:{scopeDigest:'wrong'}}],['receipt_pins_digest_matches',{receipt:{pinsDigest:'wrong'}}],['receipt_source_pins_match',{receipt:{sourcePins:{changed:true}}}],['receipt_image_pins_match',{receipt:{imagePins:{changed:true}}}],['receipt_viewable_true',{receipt:{viewable:false}}],['receipt_startup_paused_true',{receipt:{startupPaused:false}}],['receipt_pid_integer',{receipt:{pid:1.5}}],['receipt_pid_positive',{receipt:{pid:0}}],['receipt_start_ticks_integer',{receipt:{startTicks:1.5}}],['receipt_start_ticks_positive',{receipt:{startTicks:0}}],['receipt_config_sha_shape',{receipt:{configSha256:'wrong'}}],['receipt_sequence_integer',{receipt:{sequence:1.5}}],['receipt_sequence_positive',{receipt:{sequence:0}}],['receipt_sequence_not_regressed',{priorSequence:4}],['process_start_ticks_match',{priorProcess:true,receipt:{startTicks:2}}],['process_pid_matches',{priorProcess:true,receipt:{pid:16}}],['process_configuration_matches',{priorProcess:true,receipt:{configSha256:'f'.repeat(64)}}],['child_pid_present',{child:{pid:0}},'custody-pre'],['child_exit_null',{child:{exitCode:0}},'custody-pre'],['child_signal_null',{child:{signalCode:'SIGTERM'}},'custody-pre'],['wall_not_regressed',{postWall:-1}],['monotonic_not_regressed',{postMono:-1}]
];
for(const [predicate,change,stage='custody-post'] of mismatches)test('exact original custody comparison '+predicate,()=>{
 const f=custody(selectedOwner,change);assert.equal(f.result,false);assert.deepEqual(f.witness,{stage,predicate,...(change.witnessAge?{ageMs:change.witnessAge}:{})});assert.deepEqual(Object.keys(f.witness).sort(),change.witnessAge?['ageMs','predicate','stage']:['predicate','stage']);assert.equal(f.events[0].witness.predicate,predicate,'Capture precedes unchanged first-probe callback');
 if(baseline){const old=custody(readFileSync(join(baseline,'packages/providers-bizhawk/src/owned-c72-native.ts'),'utf8'),change);assert.equal(old.result,f.result);assert.deepEqual(old.reads,f.reads,'No field/callback read added or reordered');assert.deepEqual(old.counts,f.counts);assert.deepEqual(old.state,f.state);assert.deepEqual(old.events.filter(x=>x.probe),f.events.filter(x=>x.probe));}
});
function lifetime(source,change){
 let wall=100000,mono=100,wallReads=0,monoReads=0,checkReads=0;const control=new AbortController();let afterCheck=()=>{};
 const lifecycle=Object.freeze({signal:control.signal,check(){checkReads++;afterCheck();return change==='check-false'?false:true;}});
 const args={captureNativeSource,nativeSourceException,AbortSignal,Date:{parse:Date.parse,now:()=>{wallReads++;return wall;}},performance:{now:()=>{monoReads++;return mono;}}};
 const code=stripTypeScriptTypes(source,{mode:'strip'}).replace(/^import .*;$/mg,'').replace(/^export /mg,'');
 const funcs=compileFunction(code+'\nreturn {createNativeExecutionLifetime,nativeExecutionLifetimeCurrent,peek:v=>captures.get(v)};',Object.keys(args))(...Object.values(args));
 // Constructor qualification is unchanged; controlled mutations start afterward.
 let ready=true;const construction=Object.freeze({signal:control.signal,check(){checkReads++;return ready;}});
 const value=funcs.createNativeExecutionLifetime(construction,new Date(220000).toISOString()),record=funcs.peek(value);record.lifecycle=lifecycle;record.check=lifecycle.check;
 if(change==='wall-nonfinite')wall=NaN;
 if(change==='mono-nonfinite')mono=NaN;
 if(change==='wall-regressed')wall--;
 if(change==='mono-regressed')mono--;
 if(change==='wall-expired')wall=220000;
 if(change==='mono-expired')mono=120100;
 if(change==='check-identity')record.check=()=>true;
 if(change==='signal-identity')record.signal=new AbortController().signal;
 if(change==='signal-aborted')control.abort();
 if(change==='post-wall-nonfinite')afterCheck=()=>wall=NaN;
 if(change==='post-mono-nonfinite')afterCheck=()=>mono=NaN;
 if(change==='post-wall-regressed')afterCheck=()=>wall--;
 if(change==='post-mono-regressed')afterCheck=()=>mono--;
 if(change==='post-wall')afterCheck=()=>wall=220000;
 if(change==='post-mono')afterCheck=()=>mono=120100;
 if(change==='post-abort')afterCheck=()=>control.abort();
 if(change==='check-throw')afterCheck=()=>{throw new TypeError('PRIVATE must never leave fixture');};
 wallReads=monoReads=checkReads=0;let witness,retiredWhenCaptured;
 const result=funcs.nativeExecutionLifetimeCurrent(value,v=>{witness=v;retiredWhenCaptured=record.retired;});
 return {result,witness,retiredWhenCaptured,retired:record.retired,counts:{wallReads,monoReads,checkReads}};
}
for(const [change,stage,predicate,exceptionClass] of [
 ['wall-nonfinite','lifetime-pre','wall_finite'],['mono-nonfinite','lifetime-pre','monotonic_finite'],['post-wall-nonfinite','lifetime-post','wall_finite'],['post-mono-nonfinite','lifetime-post','monotonic_finite'],['post-wall-regressed','lifetime-post','wall_not_regressed'],['post-mono-regressed','lifetime-post','monotonic_not_regressed'],
 ['wall-regressed','lifetime-pre','wall_not_regressed'],['mono-regressed','lifetime-pre','monotonic_not_regressed'],['wall-expired','lifetime-pre','wall_before_expiry'],['mono-expired','lifetime-pre','monotonic_before_expiry'],['check-identity','lifetime-pre','check_identity_matches'],['signal-identity','lifetime-pre','signal_identity_matches'],['signal-aborted','lifetime-pre','signal_not_aborted'],['check-false','lifetime-pre','check_returned_true'],['post-wall','lifetime-post','wall_before_expiry'],['post-mono','lifetime-post','monotonic_before_expiry'],['post-abort','lifetime-post','signal_not_aborted'],['check-throw','lifetime-pre','check_returned_true','TypeError']
])test('original opaque lifetime precise '+change,()=>{
 const f=lifetime(selectedLifetime,change);assert.equal(f.result,false);assert.deepEqual(f.witness,{stage,predicate,...(exceptionClass?{exceptionClass}:{})});assert.equal(f.retiredWhenCaptured,false,'Original first false captured BEFORE retired mutation');assert.equal(f.retired,true);
 if(baseline){const old=lifetime(readFileSync(join(baseline,'packages/providers-bizhawk/src/native-execution-lifetime.ts'),'utf8'),change);assert.equal(old.result,f.result);assert.deepEqual(old.counts,f.counts,'No original clock/check calls added or reordered');assert.equal(old.retired,f.retired);}
});
test('opaque lifetime success has original two wall/mono samples and one check, no witness',()=>{const f=lifetime(selectedLifetime,'success');assert.equal(f.result,true);assert.equal(f.witness,undefined);assert.deepEqual(f.counts,{wallReads:2,monoReads:2,checkReads:1});});
