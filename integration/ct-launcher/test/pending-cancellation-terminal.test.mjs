import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {compileFunction} from 'node:vm';
import {createSupervisedGameRuntime,captureSupervisedGameFailure} from '../../../scripts/supervised-game-runtime.mjs';
import {guardGameActivityAdapter,GameAdapterBoundaryError} from '../../../packages/providers-bizhawk/src/provider.ts';
import {GameHostError,GameHostPort} from '../../../apps/server/src/runtime/game-host-port.ts';
import {observe} from '../../../packages/providers-bizhawk/test/game-host-fixtures.ts';
function archiveFixture(t,overrides={}){
 const parent=fs.mkdtempSync(path.join(tmpdir(),'ct75-diagnostic-'));fs.chmodSync(parent,0o700);const root=path.join(parent,'ct-owner-job-'+randomUUID());fs.mkdirSync(root,{mode:0o700});
 const original=fs.readFileSync(new URL('../ct-evidence-archive.mjs',import.meta.url),'utf8');assert.equal(original.split("const ROOT_PARENT='/srv/lifestream/workspace/runtime-state';").length,2);
 const body=original.replace(/^import .*;$/mg,'').replace('export function createDedicatedCtEvidenceArchive','function createDedicatedCtEvidenceArchive').replace("const ROOT_PARENT='/srv/lifestream/workspace/runtime-state';",'const ROOT_PARENT='+JSON.stringify(parent)+';');
 const args={...fs,...path,createHash,types,inspectGamePng:()=>{throw Error('No PNG permitted in this diagnostic fixture');},...overrides};
 const make=compileFunction(body+'\nreturn createDedicatedCtEvidenceArchive;',Object.keys(args))(...Object.values(args)),archive=make(root);t.after(()=>{archive.close();fs.rmSync(parent,{recursive:true,force:true});});return {archive,root,parent};
}
const ordinaryAction=()=>({schemaVersion:'ct-accepted-native-action/1',scopeDigest:'a'.repeat(64),requestId:randomUUID(),actionId:randomUUID(),proposalId:randomUUID(),admissionId:randomUUID(),inputDigest:'b'.repeat(64),planningObservationId:randomUUID(),dispatchObservationId:randomUUID(),buttons:[],durationFrames:1,resultStatus:'rejected',disposition:'failed',beforeFrame:null,afterFrame:null,framesApplied:null,buttonsNeutralized:true,startedAt:null,completedAt:null,resultingObservationIds:[],evidenceMeaning:'AUTOMATIC: original native action result accepted by existing evidence owner; compare proposalId to actual validated model decision and actionId to resulting PNG observation',controllerAuthority:false});

async function originalWrappedHostFailure(){const r=observe();r.deadlineAt=new Date(Date.now()+3000).toISOString();const rejected=async()=>{throw new GameHostError(409,'game_host_conflict','host_invoke_current_native_source');};const adapter=guardGameActivityAdapter({observe:rejected,applyController:rejected,controlSave:rejected,releaseControls:rejected},{providerRef:'synthetic',maxDurationMs:3000,sourceAvailable:()=>true});try{await adapter.observe(r,{signal:new AbortController().signal,isCurrent:()=>true});assert.fail('Original host failure required');}catch(error){return error;}}
function supervise(error,onFailure){let current=true,closed=0,shutdown=0;const runtime={isCurrent:()=>current,controllerCurrent:()=>current,preparePlanning:()=>assert.fail('No planning'),runPlanning:()=>assert.fail('No model'),publishEpisode:()=>assert.fail('No memory'),close:()=>{closed++;current=false;}};const native=Object.fromEntries(['resolveAttachment','bindingCurrent','controllerCurrent','sourceCurrent','sourceAvailable','acceptObservation','acceptAction','reconcileEffect','admitRelease','usageFor'].map(k=>[k,()=>true]));native.shutdownExactOldLease=async()=>{shutdown++;return true;};const campaign=Object.fromEntries(['planningCurrent','terminalRef','publishDecision','prepareController','controllerCurrent','recordSettledStep'].map(k=>[k,()=>assert.fail('No gameplay selection')]));campaign.selectPlanning=async()=>{throw error;};const owner=createSupervisedGameRuntime({native,campaign,createRepository:()=>({}),resolveApproval:()=>null,maximumSteps:1,maximumRunMs:80000,maximumCommandMs:3000,onFailure});owner.gameHost.createRepository({});owner.gameHost.onAttached({scope:observe().scope,runtime,runController:()=>assert.fail('No controller')});return {owner,closed:()=>closed,shutdown:()=>shutdown};}

const probe={schemaVersion:'ct-runtime-first-cause/1',source:'native',phase:'custody-current',reason:'inspect_not_fresh'};
async function detailedCancellation(){const request=observe();request.deadlineAt=new Date(Date.now()+3000).toISOString();const raw=async()=>{throw new GameHostError(410,'game_host_expired','host_pending_cancel_scopeChanged','preparation_gate_attachment','current_native_source');};const adapter=guardGameActivityAdapter({observe:raw,applyController:raw,controlSave:raw,releaseControls:raw},{providerRef:'synthetic',maxDurationMs:3000,sourceAvailable:()=>true});try{await adapter.observe(request,{signal:new AbortController().signal,isCurrent:()=>true});assert.fail();}catch(error){return error;}}
test('original supervisor and actual archive preserve finite cancellation detail separately from recovered probe',async t=>{
 const f=archiveFixture(t);f.archive.diagnostic(probe);const error=await detailedCancellation();assert.equal(error.cancellationSite,'preparation_gate_attachment');const owner=supervise(error,value=>f.archive.diagnostic(value));await owner.owner.completion();
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'ct-diagnostic-01.json'))),probe);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'ct-terminal-01.json'))),{schemaVersion:'ct-runtime-terminal-cause/1',source:'composition',phase:'select-planning',reason:'adapter_invalidResponse_host_pending_cancel_scopeChanged',cancellationSite:'preparation_gate_attachment',cancellationPredicate:'current_native_source'});
 assert.equal(owner.closed(),1);assert.equal(owner.shutdown(),1);assert.equal(f.archive.snapshot().counts.terminal,1);assert.equal(f.archive.snapshot().failed,false);assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));
});
test('new optional detail validation refuses incomplete unknown and getters while preserving mandatory archive',async t=>{
 const f=archiveFixture(t),dto={...captureSupervisedGameFailure(await detailedCancellation(),'select-planning'),schemaVersion:'ct-runtime-terminal-cause/1'};let getters=0;
 for(const change of [{cancellationSite:'PRIVATE'},{cancellationPredicate:'PRIVATE'},{reason:'adapter_invalidResponse'},{source:'native'}]){assert.throws(()=>f.archive.diagnostic({...dto,...change}));assert.equal(f.archive.snapshot().failed,false);}
 const missing={...dto};delete missing.cancellationPredicate;assert.throws(()=>f.archive.diagnostic(missing));const getter={...dto};Object.defineProperty(getter,'cancellationSite',{get(){getters++;throw Error('PRIVATE');},enumerable:true});assert.throws(()=>f.archive.diagnostic(getter));assert.equal(getters,0);assert.doesNotThrow(()=>f.archive.diagnostic(dto));assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));
});
test('optional detailed terminal conflict/reporter error preserves original close and mandatory evidence',async t=>{
 for(const conflict of [false,true]){const f=archiveFixture(t);if(conflict)fs.writeFileSync(path.join(f.root,'ct-terminal-01.json'),'preserved',{flag:'wx',mode:0o400});const owner=supervise(await detailedCancellation(),value=>{if(!conflict)throw Error('Optional');return f.archive.diagnostic(value);});await owner.owner.completion();assert.equal(owner.closed(),1);assert.equal(owner.shutdown(),1);assert.equal(f.archive.snapshot().failed,false);assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));}
});

test('same-call native witness survives original provider supervisor and fixed terminal archive separately from prior probe',async t=>{
 const f=archiveFixture(t),witness={stage:'custody-post',predicate:'inspect_not_fresh',ageMs:2001};f.archive.diagnostic(probe);
 const request=observe();request.deadlineAt=new Date(Date.now()+3000).toISOString();const raw=async()=>{throw new GameHostError(410,'game_host_expired','host_pending_cancel_scopeChanged','sweep_current','current_native_source',witness);};
 const adapter=guardGameActivityAdapter({observe:raw,applyController:raw,controlSave:raw,releaseControls:raw},{providerRef:'synthetic',maxDurationMs:3000,sourceAvailable:()=>true});let error;try{await adapter.observe(request,{signal:new AbortController().signal,isCurrent:()=>true});assert.fail();}catch(e){error=e;}
 assert.deepEqual(error.nativeSourceWitness,witness);const owner=supervise(error,v=>f.archive.diagnostic(v));await owner.owner.completion();
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'ct-diagnostic-01.json'))),probe);const terminal=JSON.parse(fs.readFileSync(path.join(f.root,'ct-terminal-01.json')));assert.deepEqual(terminal.nativeSourceWitness,witness);assert.equal(terminal.cancellationPredicate,'current_native_source');assert(fs.statSync(path.join(f.root,'ct-terminal-01.json')).size<=1024);assert.equal(owner.closed(),1);assert.equal(owner.shutdown(),1);assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));
});
test('malformed optional witness cannot poison mandatory evidence or the next valid terminal',async t=>{
 const f=archiveFixture(t),dto={...captureSupervisedGameFailure(await detailedCancellation(),'select-planning'),schemaVersion:'ct-runtime-terminal-cause/1'},w={stage:'custody-pre',predicate:'inspect_not_fresh',ageMs:2001};let traps=0;
 const getter={...w};Object.defineProperty(getter,'ageMs',{enumerable:true,get(){traps++;throw Error('PRIVATE');}});
 for(const nativeSourceWitness of [{...w,stage:'snapshot'},{...w,ageMs:true},{...w,extra:'PRIVATE'},getter,new Proxy(w,{ownKeys(){traps++;throw Error('PRIVATE');}})]){assert.throws(()=>f.archive.diagnostic({...dto,nativeSourceWitness}));assert.equal(f.archive.snapshot().failed,false);}
 assert.equal(traps,0);assert.doesNotThrow(()=>f.archive.diagnostic({...dto,nativeSourceWitness:w}));assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));
});
