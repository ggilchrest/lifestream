import {captureGameSanityTiming} from '../src/game-sanity-timing.ts';
import {types} from 'node:util';
import {captureNativeSource,nativeSourceAge,nativeSourceException} from '../src/native-source-witness.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileFunction} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import {join} from 'node:path';
const source=readFileSync(process.env.CT75_CUSTODY_SOURCE??new URL('../src/owned-c72-native.ts',import.meta.url),'utf8');
const start=(/let custodyDiagnosticArmed\s*=/.test(source))?source.search(/let custodyDiagnosticArmed\s*=/):source.search(/\bconst custodyCurrent\s*=/),tail=source.slice(start),end=tail.search(/\n\s*const evidence\s*=/);assert(start>=0&&end>0);const selected=stripTypeScriptTypes(tail.slice(0,end),{mode:'strip'});
function fixture(change={}){
 const events=[];
 let wall=100000,mono=100,sequence=1;const scope={runId:'00000000-0000-4000-8000-000000000001'},pins='a'.repeat(64),nonce='b'.repeat(32),IMAGE='c'.repeat(64),sourcePins={},imagePins={};
 const facts={runDirectory:'/synthetic-private-run',expiresAt:new Date(wall+120000).toISOString(),continuation:{bytes:147717,sha256:'d'.repeat(64)},imagePins,wakePreparation:'ct50-prefix33/1'};
 const deps={types,timing:captureGameSanityTiming({inspectionFreshnessMs:2000,receiptFreshnessMs:3000,noProgressTimeoutMs:3000}),captureNativeSource,nativeSourceAge,nativeSourceException,options:{onFailure:v=>{events.push(v);if(change.throwReporter)throw Error('private arbitrary text');}},Object,Date:{now:()=>wall,parse:Date.parse},performance:{now:()=>mono},readNativeFile:()=>{wall+=change.wallAdvance??1;mono+=change.monoAdvance??1;return change.invalidJson?Buffer.from('PRIVATE_INVALID_JSON'):Buffer.from(JSON.stringify({schemaVersion:'ct-native-custody/1',invocation:nonce,image:IMAGE,scopeDigest:change.changedScope?'x'.repeat(64):'e'.repeat(64),pinsDigest:pins,sourcePins,imagePins,viewable:true,startupPaused:true,pid:15,startTicks:1,sequence:change.sequence??sequence,checkedAtMs:wall+(change.receiptDelta??0),configSha256:'f'.repeat(64),disposableContinuation:{...facts.continuation,readOnly:true,independentCopy:true}}));},join,isDeepStrictEqual,scopeDigest:()=> 'e'.repeat(64),fileDigest:()=>{throw Error('No file needed without wakeProof');},facts,nonce,C72_IMAGE:IMAGE,scope,pins,sourcePins};
 deps.readNativePublishedFile=deps.readNativeFile;
 const state="let closed=false,lastWall=100000,clockCurrent=true,expiresMono=1000,child={pid:10,exitCode:null,signalCode:null},cid='a'.repeat(64),verifiedRunning=true,inspectChecked=100000,lastSequence=0,lastReceiptWall=0,lastReceiptMono=0,startTicks,monoPid,configurationHash,wakeProof=null;";
 return compileFunction(state+selected+'\nreturn {check:custodyCurrent,arm:()=>{custodyDiagnosticArmed=true;},close:()=>{closed=true;},events, state:()=>({clockCurrent,lastWall,lastSequence,lastReceiptWall,lastReceiptMono})};',[...Object.keys(deps),'events'])(...Object.values(deps),events);
}
test('actual custody closure accepts an integer receipt published during its read using validation-time wall/mono',()=>{
 const f=fixture();assert.equal(f.check(),true);assert.deepEqual(f.state(),{clockCurrent:true,lastWall:100001,lastSequence:1,lastReceiptWall:100001,lastReceiptMono:101});
});
test('future, stale, fractional, reversed-clock, expired, stale-inspect, changed-scope and regressing receipts remain refused',()=>{
 for(const fault of [{receiptDelta:1},{receiptDelta:-3001},{receiptDelta:.25},{wallAdvance:-1},{monoAdvance:-1},{wallAdvance:120000},{monoAdvance:900},{wallAdvance:2001},{changedScope:true}])assert.equal(fixture(fault).check(),false,JSON.stringify(fault));
 const f=fixture({wallAdvance:0,monoAdvance:0});assert.equal(f.check(),true);assert.equal(f.check(),true);assert.equal(f.state().lastSequence,1);
 const invalid=fixture({sequence:0});assert.equal(invalid.check(),false);
});
test('a reversed clock during capture latches original custody closed rather than recovering on another read',()=>{
 const f=fixture({wallAdvance:-1});assert.equal(f.check(),false);assert.equal(f.state().clockCurrent,false);assert.equal(f.check(),false);
});

test('selected receipt sequence and timestamp regression guards remain terminal for each refused read',()=>{
 const change={sequence:2},f=fixture(change);assert.equal(f.check(),true);change.sequence=1;assert.equal(f.check(),false);
 const times={sequence:1},g=fixture(times);assert.equal(g.check(),true);times.sequence=2;times.receiptDelta=-2;assert.equal(g.check(),false);
});
test('pre-open custody polls report nothing; post-open first refusal is closed, single and cannot alter denial',()=>{
 const change={changedScope:true,throwReporter:true},f=fixture(change);assert.equal(f.check(),false);assert.deepEqual(f.events,[]);f.arm();assert.equal(f.check(),false);assert.deepEqual(f.events,[{schemaVersion:'ct-runtime-first-cause/1',source:'native',phase:'custody-current',reason:'receipt_identity_or_pins_changed'}]);change.changedScope=false;change.receiptDelta=1;assert.equal(f.check(),false);assert.equal(f.events.length,1);
});
test('actual ordered custody guards distinguish inspection, true-future, stale and clock refusal without extra reads',()=>{
 for(const [change,reason] of [[{wallAdvance:2001},'inspect_not_fresh'],[{receiptDelta:1},'receipt_future'],[{receiptDelta:-3001},'receipt_stale'],[{receiptDelta:.25},'receipt_time_invalid'],[{wallAdvance:-1},'clock_changed'],[{changedScope:true},'receipt_identity_or_pins_changed']]){const f=fixture(change);f.arm();assert.equal(f.check(),false);assert.equal(f.events[0].reason,reason);}
});
test('production arming is after the original final evidence qualification and immediately before successful open return',()=>{
 const compact=source.replace(/\s+/g,'');
 const guards=[['closed','owner_closed'],['context.signal.aborted','signal_current'],['!current()','readback_current'],['performance.now()>=deadline','readback_deadline'],['!evidence.sourceAvailable(scope,pins)','source_available']].map(([condition,predicate])=>`if(${condition})throwownerError('readback','${predicate}','Nativereadbackunavailable');`).join('');
 const final=compact.indexOf(guards);assert(final>0,'all five original final guards must remain contiguous and in short-circuit order');
 const arm=final+guards.length;assert.equal(compact.slice(arm,arm+'custodyDiagnosticArmed=true;return{adapter:'.length),'custodyDiagnosticArmed=true;return{adapter:');
});

test('post-close expected custody refusal does not synthesize a native failure diagnostic',()=>{const f=fixture({changedScope:true});f.arm();f.close();assert.equal(f.check(),false);assert.deepEqual(f.events,[]);});

test('original custody JSON parse refusal is distinct from file-read failure and exports no error text',t=>{
 const old=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS='1';
 t.after(()=>{if(old===undefined)delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;else process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS=old;});
 const logs=[];t.mock.method(console,'info',value=>{logs.push(JSON.parse(value));throw Error('PRIVATE_REPORTER');});
 const f=fixture({invalidJson:true});f.arm();assert.equal(f.check(),false);
 assert.deepEqual(logs,[{event:'native-custody-read-refusal',phase:'json-parse',reason:'invalid_json'}]);assert.equal(f.events[0].reason,'custody_read_failed');
});
