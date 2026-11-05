import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {isGameFrameVisionWitness} from '../../../packages/providers-sglang/src/game-frame-diagnostics.ts';
import {crc32,deflateSync} from 'node:zlib';
import {inspectGamePng} from '../../../packages/providers-bizhawk/src/frame-custody.ts';
import {compileFunction} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {createSelectedCtJobLifecycle,isSelectedCtJobLifecycle} from '../ct-job-lifecycle-owner.mjs';
import {createNativeOwnerFailureWitness,nativeOwnerFailureStages,nativeOwnerFailurePredicates,nativeOwnerTransportCodes} from '../../../packages/providers-bizhawk/src/native-owner-failure-witness.ts';
const schemaVersion='ct-runtime-first-cause/1';
const event=(source,phase,reason)=>({schemaVersion,source,phase,reason});
function archiveFixture(t,overrides={}){
 const parent=fs.mkdtempSync(path.join(tmpdir(),'ct75-diagnostic-'));fs.chmodSync(parent,0o700);const root=path.join(parent,'ct-owner-job-'+randomUUID());fs.mkdirSync(root,{mode:0o700});
 const original=fs.readFileSync(new URL('../ct-evidence-archive.mjs',import.meta.url),'utf8');assert.equal(original.split("const ROOT_PARENT='/srv/lifestream/workspace/runtime-state';").length,2);
 const body=original.replace(/^import .*;$/mg,'').replace('export function createDedicatedCtEvidenceArchive','function createDedicatedCtEvidenceArchive').replace("const ROOT_PARENT='/srv/lifestream/workspace/runtime-state';",'const ROOT_PARENT='+JSON.stringify(parent)+';');
 const args={...fs,...path,createHash,types,isGameFrameVisionWitness,inspectGamePng:()=>{throw Error('No PNG permitted in this diagnostic fixture');},...overrides};
 const make=compileFunction(body+'\nreturn createDedicatedCtEvidenceArchive;',Object.keys(args))(...Object.values(args)),archive=make(root);t.after(()=>{archive.close();fs.rmSync(parent,{recursive:true,force:true});});return {archive,root,parent};
}
const ordinaryAction=()=>({schemaVersion:'ct-accepted-native-action/1',scopeDigest:'a'.repeat(64),requestId:randomUUID(),actionId:randomUUID(),proposalId:randomUUID(),admissionId:randomUUID(),inputDigest:'b'.repeat(64),planningObservationId:randomUUID(),dispatchObservationId:randomUUID(),buttons:[],durationFrames:1,resultStatus:'rejected',disposition:'failed',beforeFrame:null,afterFrame:null,framesApplied:null,buttonsNeutralized:true,startedAt:null,completedAt:null,resultingObservationIds:[],evidenceMeaning:'AUTOMATIC: original native action result accepted by existing evidence owner; compare proposalId to actual validated model decision and actionId to resulting PNG observation',controllerAuthority:false});
test('private archive preserves only the first exact closed cause, without identifiers or later overwrite',t=>{
 const f=archiveFixture(t),first=event('lifecycle','stop','operation_failed');const a=f.archive.diagnostic(first),b=f.archive.diagnostic(event('client','cancellation','cancelled'));assert.deepEqual(a,b);
 const file=path.join(f.root,'ct-diagnostic-01.json'),stat=fs.lstatSync(file);assert.equal(stat.mode&0o777,0o400);assert.equal(stat.nlink,1);assert.deepEqual(JSON.parse(fs.readFileSync(file)),first);assert.equal(f.archive.snapshot().counts.diagnostic,1);assert.equal(f.archive.snapshot().failed,false);
});
test('invalid diagnostic DTO/getters cannot poison a later valid mandatory evidence write',t=>{
 for(const invalid of [{...event('client','attach','denied'),nonce:'PRIVATE'},event('client','attach','arbitrary-private-text'),{...event('client','attach','denied'),get message(){assert.fail('Getter was invoked');}}]){
  const f=archiveFixture(t);assert.throws(()=>f.archive.diagnostic(invalid),/ct_evidence_archive_refused/);assert.equal(f.archive.snapshot().failed,false);assert.equal(f.archive.snapshot().diagnosticFailed,true);assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));assert.equal(f.archive.snapshot().counts.action,1);
 }
});
test('diagnostic exclusive-write conflict is preserved without poisoning valid mandatory evidence',t=>{
 const f=archiveFixture(t),file=path.join(f.root,'ct-diagnostic-01.json');fs.writeFileSync(file,'HISTORICAL-DO-NOT-ADOPT',{flag:'wx',mode:0o400});assert.throws(()=>f.archive.diagnostic(event('client','attach','denied')));assert.equal(fs.readFileSync(file,'utf8'),'HISTORICAL-DO-NOT-ADOPT');assert.equal(f.archive.snapshot().failed,false);assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));
});
test('underlying original root custody corruption still fences subsequent mandatory evidence',t=>{
 const f=archiveFixture(t);fs.renameSync(f.root,f.root+'-original');fs.mkdirSync(f.root,{mode:0o700});assert.throws(()=>f.archive.diagnostic(event('client','attach','denied')));assert.equal(f.archive.snapshot().failed,true);assert.throws(()=>f.archive.action(ordinaryAction()));assert.equal(fs.readdirSync(f.root).length,0);
});
function selectedCurrent({now=100,last=100,closed=false,aborted=false,expiry=200,nonexpiring=false,check=()=>true,report=()=>{}}={}){
 const raw=fs.readFileSync(new URL('../dedicated-ct-job.mjs',import.meta.url),'utf8'),a=raw.indexOf(' const diagnostic=Object.getOwnPropertyDescriptor('),b=raw.indexOf('\n const safePublish=',a);assert(a>=0&&b>a);const abort=new AbortController();if(aborted)abort.abort();
 return compileFunction('let lastWall=last;'+raw.slice(a,b)+'\nreturn current;',['input','ports','closed','abort','nonexpiring','end','lifecycle','last','fail'])({evidenceOwner:{diagnostic:report}},{now:()=>now},closed,abort,nonexpiring,expiry,{check},last,code=>{throw Object.assign(Error(code),{code});});
}
test('actual launcher current keeps original short-circuit order, generic failure and one lifecycle check',()=>{
 for(const [patch,expected,calls]of [[{closed:true},'closed',0],[{aborted:true},'aborted',0],[{now:99},'wall_clock_changed',0],[{now:NaN},'invalid_clock',0],[{now:200},'selection_expired',0],[{check:()=>false},'lifecycle_not_current',1]]){
  const records=[];let checked=0;const original=patch.check??(()=>true),current=selectedCurrent({...patch,check:()=>{checked++;return original();},report:v=>records.push(v)});assert.throws(current,{code:'ct_job_expired_or_closed'});assert.equal(checked,calls);assert.deepEqual(records,[event('launcher','current',expected)]);
 }
 let checked=0;assert.equal(selectedCurrent({check:()=>{checked++;return true;}})(),100);assert.equal(checked,1);
});
test('original lifecycle first reason wins shared archive before launcher generic and client cancellation',async t=>{
 const f=archiveFixture(t),policy={maximumGameplayMs:80000,operationLimits:{owner_prepare:30000,native_prepare:30000,native_start:30000,model:3000,controller:500,settle:5000},cleanupTimeoutMs:10000};let current=true;
 const life=createSelectedCtJobLifecycle(policy,{isCurrent:()=>current,canExecute:()=>false,isQuiescent:()=>true,onStop:async()=>true,onStopCause:reason=>f.archive.diagnostic(event('lifecycle','stop',reason))});assert(isSelectedCtJobLifecycle(life,policy));life.signal.addEventListener('abort',()=>f.archive.diagnostic(event('client','cancellation','cancelled')));current=false;
 const check=selectedCurrent({nonexpiring:true,check:life.check,report:v=>f.archive.diagnostic(v)});assert.throws(check,{code:'ct_job_expired_or_closed'});await life.completion();assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'ct-diagnostic-01.json'))),event('lifecycle','stop','currentness_lost'));
 assert.throws(()=>createSelectedCtJobLifecycle({...policy,onStopCause:()=>{}},{}));
});

test('native custody diagnostics use only the closed code set and preserve the original first-cause latch',t=>{
 const f=archiveFixture(t),first=event('native','custody-current','inspect_not_fresh');const receipt=f.archive.diagnostic(first);assert(receipt);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'ct-diagnostic-01.json'))),first);assert.deepEqual(f.archive.diagnostic(event('client','native-current','scopeChanged')),receipt);
 const invalid=archiveFixture(t);assert.throws(()=>invalid.archive.diagnostic(event('native','custody-current','unreviewed-private-message')));assert.doesNotThrow(()=>invalid.archive.action(ordinaryAction()));
});

test('composition original boundary reason wins before derivative client denial and rejects open text',t=>{
 const f=archiveFixture(t),first=event('composition','wake-handoff','plain_wake_handoff_join_required');const ref=f.archive.diagnostic(first);assert.deepEqual(f.archive.diagnostic(event('client','poll','denied')),ref);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'ct-diagnostic-01.json'))),first);
 const invalid=archiveFixture(t);assert.throws(()=>invalid.archive.diagnostic(event('composition','native-observe','PRIVATE')));assert.equal(invalid.archive.snapshot().failed,false);assert.doesNotThrow(()=>invalid.archive.action(ordinaryAction()));
});

const terminal=(source,phase,reason)=>({...event(source,phase,reason),schemaVersion:'ct-runtime-terminal-cause/1'});
test('recoverable stale probe and different actual terminal reason retain two independent fixed private records',t=>{
 const f=archiveFixture(t),probe=event('native','custody-current','inspect_not_fresh'),fatal=terminal('client','attach','denied');f.archive.diagnostic(probe);const a=f.archive.diagnostic(fatal),b=f.archive.diagnostic(terminal('lifecycle','stop','cancelled'));assert.deepEqual(a,b);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'ct-diagnostic-01.json'))),probe);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'ct-terminal-01.json'))),fatal);for(const n of ['ct-diagnostic-01.json','ct-terminal-01.json']){const s=fs.statSync(path.join(f.root,n));assert.equal(s.mode&0o777,0o400);assert.equal(s.nlink,1);}assert.equal(f.archive.snapshot().counts.terminal,1);assert.equal(f.archive.snapshot().failed,false);assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));
});
test('native or runtime probes cannot forge terminal lane or prevent later valid terminal record',t=>{
 const f=archiveFixture(t);for(const v of [terminal('native','custody-current','inspect_not_fresh'),terminal('runtime','runtime-current','runtime_actor_not_current'),{...terminal('client','attach','denied'),privateText:'FORBIDDEN'}])assert.throws(()=>f.archive.diagnostic(v));assert.equal(f.archive.snapshot().terminalFailed,false);f.archive.diagnostic(terminal('composition','native-observe','adapter_timedOut'));assert.equal(f.archive.snapshot().counts.terminal,1);assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));
});
test('terminal exclusive-leaf conflict preserves historical bytes and does not poison probe or mandatory evidence',t=>{
 const f=archiveFixture(t),file=path.join(f.root,'ct-terminal-01.json');fs.writeFileSync(file,'HISTORICAL',{flag:'wx',mode:0o400});assert.throws(()=>f.archive.diagnostic(terminal('client','attach','denied')));assert.equal(fs.readFileSync(file,'utf8'),'HISTORICAL');assert.equal(f.archive.snapshot().terminalFailed,true);assert.equal(f.archive.snapshot().failed,false);assert.doesNotThrow(()=>f.archive.diagnostic(event('native','custody-current','inspect_not_fresh')));assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));
});
test('partial terminal write uncertainty is preserved without poisoning original mandatory evidence',t=>{
 const f=archiveFixture(t,{writeSync(...args){if(fs.readlinkSync('/proc/self/fd/'+args[0]).endsWith('/ct-terminal-01.json')){fs.writeSync(args[0],args[1],args[2],1);throw Error('Synthetic optional write failure');}return fs.writeSync(...args);}});assert.throws(()=>f.archive.diagnostic(terminal('client','attach','denied')));const file=path.join(f.root,'ct-terminal-01.json'),before=fs.readFileSync(file);assert.equal(before.length,1);assert.equal(f.archive.snapshot().terminalFailed,true);assert.equal(f.archive.snapshot().failed,false);assert.throws(()=>f.archive.diagnostic(terminal('lifecycle','stop','cancelled')));assert.deepEqual(fs.readFileSync(file),before);assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));
});
test('original index lifecycle stop callback records terminal first reason before abort-driven client cancellation',async t=>{
 const f=archiveFixture(t),raw=fs.readFileSync(new URL('../../../apps/server/src/index.ts',import.meta.url),'utf8'),line=raw.split('\n').find(x=>x.includes('onStopCause:(reason:string)=>'));assert(line);const expression=line.slice(line.indexOf('(reason:string)=>'),line.lastIndexOf(','));const onStopCause=compileFunction('return ('+stripTypeScriptTypes(expression,{mode:'strip'})+');',[]).call({dedicatedCtDiagnostic:f.archive.diagnostic});
 f.archive.diagnostic(event('native','custody-current','inspect_not_fresh'));const life=createSelectedCtJobLifecycle({maximumGameplayMs:80000,operationLimits:{owner_prepare:30000,native_prepare:30000,native_start:30000,model:3000,controller:500,settle:5000},cleanupTimeoutMs:10000},{isCurrent:()=>true,canExecute:()=>false,isQuiescent:()=>true,onStop:async()=>true,onStopCause});life.signal.addEventListener('abort',()=>f.archive.diagnostic(terminal('client','cancellation','cancelled')));await life.stop('operation_failed');assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'ct-terminal-01.json'))),terminal('lifecycle','stop','operation_failed'));assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'ct-diagnostic-01.json'))),event('native','custody-current','inspect_not_fresh'));
});

test('native open first-stage witness survives later lifecycle failure in bounded first lane',t=>{
 const f=archiveFixture(t),first={...event('native','native-open','open_failed'),nativeOpenWitness:{stage:'create',exceptionClass:'Error',exitCode:125}};
 const ref=f.archive.diagnostic(first);assert.deepEqual(f.archive.diagnostic(event('lifecycle','stop','operation_failed')),ref);
 const raw=fs.readFileSync(path.join(f.root,'ct-diagnostic-01.json'));assert(raw.length<=1024);assert.deepEqual(JSON.parse(raw),first);assert.equal(f.archive.snapshot().failed,false);
});
test('native open archive witness rejects open private values, invalid codes and wrong contexts',t=>{
 const base={...event('native','native-open','open_failed'),nativeOpenWitness:{stage:'listen',exceptionClass:'Error',errno:'EADDRINUSE'}};
 for(const v of [
  {...base,nativeOpenWitness:{...base.nativeOpenWitness,message:'PRIVATE'}},
  {...base,nativeOpenWitness:{stage:'PRIVATE',exceptionClass:'Error'}},
  {...base,nativeOpenWitness:{stage:'create',exceptionClass:'PRIVATE'}},
  {...base,nativeOpenWitness:{stage:'create',exceptionClass:'Error',errno:'PRIVATE'}},
  {...base,nativeOpenWitness:{stage:'create',exceptionClass:'Error',exitCode:256}},
  {...base,nativeOpenWitness:{stage:'create',exceptionClass:'Error',exitCode:-1}},
  {...base,nativeOpenWitness:{stage:'create',exceptionClass:'Error',exitCode:1.5}},
  {...base,nativeOpenWitness:{stage:'create',exceptionClass:'Error',exitCode:1,errno:'EIO'}},
  {...base,schemaVersion:'ct-runtime-terminal-cause/1'},
  {...base,phase:'custody-current'},
  {...base,get privateBody(){assert.fail('Getter invoked');}}
 ]){const f=archiveFixture(t);assert.throws(()=>f.archive.diagnostic(v));assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));}
 const f=archiveFixture(t);assert.doesNotThrow(()=>f.archive.diagnostic(base));
});

test('native open stderr classification is a closed enum only',t=>{
 for(const stderrClass of ['cached_boot_id_mismatch','unclassified','empty']){
  const f=archiveFixture(t),v={...event('native','native-open','open_failed'),nativeOpenWitness:{stage:'create',exceptionClass:'Error',exitCode:125,stderrClass}};
  assert.doesNotThrow(()=>f.archive.diagnostic(v));assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'ct-diagnostic-01.json'))),v);
 }
 for(const extra of [{stderrClass:'PRIVATE'},{stderr:'PRIVATE'},{stderrClass:'empty',stderr:'PRIVATE'}]){
  const f=archiveFixture(t);assert.throws(()=>f.archive.diagnostic({...event('native','native-open','open_failed'),nativeOpenWitness:{stage:'create',exceptionClass:'Error',...extra}}));
 }
});

test('classified asynchronous inspection first cause is retained before later readback and cleanup failures',t=>{
 const f=archiveFixture(t),original=Object.assign(new TypeError('PRIVATE process/nonce/command'),{code:'EIO'}),nativeOpenWitness=createNativeOwnerFailureWitness('inspect-poll','inspection_rejected',original);
 const first={...event('native','native-open','open_failed'),nativeOpenWitness},receipt=f.archive.diagnostic(first);
 assert.deepEqual(f.archive.diagnostic({...event('native','native-open','open_failed'),nativeOpenWitness:createNativeOwnerFailureWitness('readback','owner_closed',Error('cleanup derivative'))}),receipt);
 f.archive.diagnostic(terminal('lifecycle','stop','operation_failed'));const raw=fs.readFileSync(path.join(f.root,'ct-diagnostic-01.json'));assert(raw.length<=1024);assert.deepEqual(JSON.parse(raw),first);assert.equal(raw.includes(Buffer.from('PRIVATE')),false);assert.equal(f.archive.snapshot().counts.diagnostic,1);assert.equal(f.archive.snapshot().counts.terminal,1);
});
test('archive closed owner stages/predicates exactly match trusted source helper enums',t=>{
 const raw=fs.readFileSync(new URL('../ct-evidence-archive.mjs',import.meta.url),'utf8');
 const members=name=>JSON.parse(raw.match(new RegExp('const '+name+'=new Set\\((\\[[^;]+\\])\\);'))[1].replaceAll("'",'"'));
 assert.deepEqual(members('nativeOwnerPredicates'),[...nativeOwnerFailurePredicates]);
 const accepted=members('nativeOpenStages');for(const stage of nativeOwnerFailureStages)assert(accepted.includes(stage));
 for(const [index,stage]of nativeOwnerFailureStages.entries()){const f=archiveFixture(t),nativeOpenWitness=createNativeOwnerFailureWitness(stage,stage==='readback'?'readback_current':nativeOwnerFailurePredicates[index],new Error('PRIVATE'));assert.doesNotThrow(()=>f.archive.diagnostic({...event('native','native-open','open_failed'),nativeOpenWitness}));}
});
test('unknown owner predicate/stage and arbitrary private nested fields are refused without invoking getters',t=>{
 for(const mutate of [v=>{v.predicate='PRIVATE';},v=>{v.stage='PRIVATE';},v=>{v.message='PRIVATE';},v=>{v.stack='PRIVATE';},v=>{v.stderr='PRIVATE';},v=>{v.invocationNonce='PRIVATE';},v=>{Object.defineProperty(v,'predicate',{enumerable:true,get(){assert.fail('Getter was invoked');}});}]){
  const f=archiveFixture(t),w={stage:'readback',predicate:'readback_deadline',exceptionClass:'Error'};mutate(w);assert.throws(()=>f.archive.diagnostic({...event('native','native-open','open_failed'),nativeOpenWitness:w}));assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));assert.equal(f.archive.snapshot().failed,false);
 }
});

test('original transport disconnect codes survive first-cause archive but private or misplaced codes refuse',t=>{
 for(const transportCode of nativeOwnerTransportCodes){const f=archiveFixture(t),w=createNativeOwnerFailureWitness('transport-disconnect','transport_closed',undefined,transportCode),value={...event('native','native-open','open_failed'),nativeOpenWitness:w};f.archive.diagnostic(value);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'ct-diagnostic-01.json'))),value);}
 for(const w of [{stage:'transport-disconnect',predicate:'transport_closed',exceptionClass:'Other',transportCode:'PRIVATE'},{stage:'readback',predicate:'readback_current',exceptionClass:'Error',transportCode:'closed'},{stage:'transport-disconnect',predicate:'inspection_rejected',exceptionClass:'Other',transportCode:'disconnected'}]){const f=archiveFixture(t);assert.throws(()=>f.archive.diagnostic({...event('native','native-open','open_failed'),nativeOpenWitness:w}));}
});

function archivedVisionFrame(t){
 const f=archiveFixture(t,{inspectGamePng}),chunk=(name,data)=>{const h=Buffer.alloc(8),tail=Buffer.alloc(4);h.writeUInt32BE(data.length);h.write(name,4);tail.writeUInt32BE(crc32(Buffer.concat([h.subarray(4),data])));return Buffer.concat([h,data,tail]);},header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;
 const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,1,2,3]))),chunk('IEND',Buffer.alloc(0))]),observationId=randomUUID(),screenshotSha256=createHash('sha256').update(bytes).digest('hex'),now=new Date().toISOString();
 f.archive.observation({schemaVersion:'ct-actual-game-image/1',scopeDigest:'a'.repeat(64),observationId,observationRevision:1,frameNumber:1,capturedAt:now,receivedAt:now,previousActionId:null,screenshot:{screenshotId:randomUUID(),sha256:screenshotSha256,byteLength:bytes.length,width:1,height:1,mediaType:'image/png'},interpretation:{matchedReviewedScene:false,pixelFacts:'AUTOMATIC: native PNG bytes, dimensions, digest, frame and observation identities',sceneSemantics:'No reviewed scene semantics asserted',annotationOrigin:'UNSPECIFIED',qualificationRef:null,fields:[]},controllerAuthority:false},bytes);
 return {...f,observationId,screenshotSha256};
}
test('vision refusal witness joins archived actual image and wins before downstream generic campaign failure',t=>{
 const f=archivedVisionFrame(t),value={...event('game-vision','interpretation','interpretation_refused'),visionWitness:{kind:'provider',reason:'response_finish',observationId:f.observationId,screenshotSha256:f.screenshotSha256,finishReason:'length',httpStatus:200,inputTokens:321,outputTokens:192,requestSha256:'b'.repeat(64),responseSha256:'c'.repeat(64)}};
 const receipt=f.archive.diagnostic(value);assert.deepEqual(f.archive.diagnostic(event('composition','select-planning','campaign_interpretation_unavailable')),receipt);
 const bytes=fs.readFileSync(path.join(f.root,'ct-diagnostic-01.json'));assert(bytes.length<=1024);assert.deepEqual(JSON.parse(bytes),value);assert.equal(f.archive.snapshot().counts.vision,0,'refused metadata is not an accepted vision receipt');assert.equal(f.archive.snapshot().failed,false);
});
test('vision diagnostic rejects unbound images, malformed metadata and private fields without poisoning mandatory evidence',t=>{
 for(const patch of [{observationId:randomUUID()},{screenshotSha256:'b'.repeat(64)},{outputTokens:1000000001},{outputTokens:1.5},{finishReason:'PRIVATE'.repeat(200)},{responseSha256:'invalid'},{body:'PRIVATE'}]){
  const f=archivedVisionFrame(t),visionWitness={kind:'provider',reason:'response_finish',observationId:f.observationId,screenshotSha256:f.screenshotSha256,...patch};
  assert.throws(()=>f.archive.diagnostic({...event('game-vision','interpretation','interpretation_refused'),visionWitness}));assert.equal(f.archive.snapshot().failed,false);assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));
 }
 const f=archivedVisionFrame(t),visionWitness={kind:'interpreter',reason:'frame_read',observationId:f.observationId,screenshotSha256:f.screenshotSha256};assert.doesNotThrow(()=>f.archive.diagnostic({...event('game-vision','interpretation','interpretation_refused'),visionWitness}));
});
