import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {compileFunction} from 'node:vm';
import {createSupervisedGameRuntime,captureSupervisedGameFailure} from '../../../scripts/supervised-game-runtime.mjs';
import {guardGameActivityAdapter} from '../../../packages/providers-bizhawk/src/provider.ts';
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
test('actual supervisor terminal lane preserves closed raw host cause separately from recoverable native probe',async t=>{const f=archiveFixture(t);f.archive.diagnostic(probe);const error=await originalWrappedHostFailure(),owner=supervise(error,v=>f.archive.diagnostic(v));await owner.owner.completion();assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'ct-diagnostic-01.json'))),probe);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'ct-terminal-01.json'))),{schemaVersion:'ct-runtime-terminal-cause/1',source:'composition',phase:'select-planning',reason:'adapter_invalidResponse_host_invoke_current_native_source'});assert.equal(owner.closed(),1);assert.equal(owner.shutdown(),1);assert.equal(f.archive.snapshot().counts.terminal,1);assert.equal(f.archive.snapshot().failed,false);assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));});
test('optional terminal conflict or throwing reporter cannot poison mandatory evidence or change original cleanup',async t=>{for(const kind of ['conflict','reporter']){const f=archiveFixture(t);f.archive.diagnostic(probe);const target=path.join(f.root,'ct-terminal-01.json');if(kind==='conflict')fs.writeFileSync(target,'HISTORICAL',{flag:'wx',mode:0o400});const error=await originalWrappedHostFailure(),owner=supervise(error,v=>{if(kind==='reporter')throw Error('Optional reporter');f.archive.diagnostic(v);});await owner.owner.completion();assert.equal(owner.closed(),1);assert.equal(owner.shutdown(),1);assert.equal(f.archive.snapshot().failed,false);assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));if(kind==='conflict'){assert.equal(fs.readFileSync(target,'utf8'),'HISTORICAL');assert.equal(f.archive.snapshot().terminalFailed,true);}else assert.equal(fs.existsSync(target),false);}});
test('unknown terminal cause is rejected without blocking a later valid terminal or mandatory evidence',async t=>{const f=archiveFixture(t);assert.throws(()=>f.archive.diagnostic({schemaVersion:'ct-runtime-terminal-cause/1',source:'composition',phase:'select-planning',reason:'adapter_invalidResponse_PRIVATE'}));assert.equal(f.archive.snapshot().failed,false);assert.equal(f.archive.snapshot().terminalFailed,false);const error=await originalWrappedHostFailure(),dto={...captureSupervisedGameFailure(error,'select-planning'),schemaVersion:'ct-runtime-terminal-cause/1'};assert.doesNotThrow(()=>f.archive.diagnostic(dto));assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));});
test('pure HostPort current probe produces no terminal and remains a boolean-only refusal',async t=>{const f=archiveFixture(t);f.archive.diagnostic(probe);const r=observe();let nativeCurrent=true,join;const actor={principalId:r.scope.principalId,sessionId:r.scope.contextBinding.sessionId,isCurrent:()=>true};const p=new GameHostPort({}, {maxAttachments:1,maxDurationMs:3000,createRepository:()=>({}),resolveAttachment:(_a,m)=>{const {protocol,...b}=m;return b;},bindingCurrent:()=>true,controllerCurrent:()=>false,boundary:{sourceAvailable:()=>nativeCurrent},onAttached:j=>join=j});t.after(()=>p.close());const a=p.attach(actor,{protocol:'lifestream.game-host.v1',hostId:randomUUID(),scope:r.scope,pinsDigest:'a'.repeat(64),providerRef:'synthetic',sourceRevision:'b'.repeat(64)});nativeCurrent=false;assert.equal(p.current(p.attachments.get(a.attachmentId)),false);assert.equal(p.attachments.get(a.attachmentId).closed,false);assert.equal(f.archive.snapshot().counts.terminal,0);assert.equal(fs.existsSync(path.join(f.root,'ct-terminal-01.json')),false);});

test('client first and terminal denial preserve same-response closed witness through archive',t=>{
 const f=archiveFixture(t),base={source:'client',phase:'poll',reason:'denied',responseWitness:{route:'next',status:410,errorCode:'game_host_expired'}};
 for(const [schemaVersion,name] of [['ct-runtime-first-cause/1','ct-diagnostic-01.json'],['ct-runtime-terminal-cause/1','ct-terminal-01.json']]){const value={schemaVersion,...base};f.archive.diagnostic(value);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,name))),value);}
 assert.equal(f.archive.snapshot().failed,false);
});
for(const patch of [{status:200},{status:600},{status:410.5},{status:'410'},{errorCode:'PRIVATE'},{body:'PRIVATE'},{route:'PRIVATE'}])test('archive refuses invalid response witness '+JSON.stringify(patch),t=>{
 const f=archiveFixture(t);assert.throws(()=>f.archive.diagnostic({schemaVersion:'ct-runtime-first-cause/1',source:'client',phase:'poll',reason:'denied',responseWitness:{route:'next',status:410,...patch}}));assert.equal(f.archive.snapshot().failed,false);
});
test('archive refuses response metadata attached to another diagnostic meaning',t=>{
 const f=archiveFixture(t);assert.throws(()=>f.archive.diagnostic({schemaVersion:'ct-runtime-first-cause/1',source:'client',phase:'poll',reason:'transportLost',responseWitness:{route:'next',status:410}}));
});

const campaignReasons=['campaign_admission_unavailable','campaign_initial_observation_unavailable','campaign_start_selection_unavailable','campaign_start_claim_refused','campaign_checkpoint_unavailable','campaign_journal_unavailable','campaign_observation_unavailable','campaign_interpretation_unavailable','campaign_interpreted_observation_invalid','campaign_binding_unavailable','campaign_context_unavailable'];
test('exact campaign refusal survives both closed archive lanes and preserves first cause',t=>{
 for(const reason of campaignReasons){
  const f=archiveFixture(t),base={source:'composition',phase:'select-planning',reason};
  for(const [schemaVersion,name] of [['ct-runtime-first-cause/1','ct-diagnostic-01.json'],['ct-runtime-terminal-cause/1','ct-terminal-01.json']]){
   const value={schemaVersion,...base};f.archive.diagnostic(value);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,name))),value);
   f.archive.diagnostic({...value,reason:'campaign_context_unavailable'});assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,name))),value);
  }
  assert.equal(f.archive.snapshot().failed,false);assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));
 }
});
test('campaign refusal is restricted to exact four-key selection diagnostics without raw data',t=>{
 const value={schemaVersion:'ct-runtime-first-cause/1',source:'composition',phase:'select-planning',reason:'campaign_start_selection_unavailable'};
 for(const patch of [{source:'client'},{phase:'run-planning'},{reason:'campaign_PRIVATE'},{schemaVersion:'PRIVATE'},{message:'PRIVATE'},{responseWitness:{route:'next',status:403}},{cancellationSite:'sweep_current'}]){
  const f=archiveFixture(t);assert.throws(()=>f.archive.diagnostic({...value,...patch}));assert.equal(f.archive.snapshot().failed,false);assert.equal(fs.existsSync(path.join(f.root,'ct-diagnostic-01.json')),false);assert.doesNotThrow(()=>f.archive.action(ordinaryAction()));assert.doesNotThrow(()=>f.archive.diagnostic({...value,schemaVersion:'ct-runtime-terminal-cause/1'}));
 }
});

test('client next410 cancellation and closed native source witness survive both archive lanes',t=>{
 const f=archiveFixture(t),responseWitness={route:'next',status:410,errorCode:'game_host_expired',cancellationSite:'sweep_current',cancellationPredicate:'current_native_source',nativeSourceWitness:{stage:'custody-pre',predicate:'inspect_not_fresh',ageMs:30001}};
 for(const [schemaVersion,name] of [['ct-runtime-first-cause/1','ct-diagnostic-01.json'],['ct-runtime-terminal-cause/1','ct-terminal-01.json']]){const value={schemaVersion,source:'client',phase:'poll',reason:'denied',responseWitness};f.archive.diagnostic(value);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,name))),value);}
 assert.equal(f.archive.snapshot().failed,false);
});
for(const patch of [{status:403},{route:'attach'},{errorCode:'game_host_scope_denied'},{cancellationSite:'PRIVATE'},{cancellationPredicate:undefined},{nativeSourceWitness:{stage:'custody-pre',predicate:'inspect_not_fresh',ageMs:30001}},{nonce:'PRIVATE'}])test('archive refuses mismatched response cancellation '+JSON.stringify(patch),t=>{
 const f=archiveFixture(t),value={schemaVersion:'ct-runtime-terminal-cause/1',source:'client',phase:'poll',reason:'denied',responseWitness:{route:'next',status:410,errorCode:'game_host_expired',cancellationSite:'sweep_current',cancellationPredicate:'current_runtime',...patch}};
 assert.throws(()=>f.archive.diagnostic(value));assert.equal(f.archive.snapshot().failed,false);
});

test('explicit read deadline survives client and pending-adapter archive lanes',t=>{
 for(const source of ['client','composition']){
  const f=archiveFixture(t),detail={cancellationSite:'sweep_refresh_failed',cancellationPredicate:'read_refresh_deadline'},value={schemaVersion:'ct-runtime-terminal-cause/1',source,phase:source==='client'?'poll':'select-planning',reason:source==='client'?'denied':'adapter_invalidResponse_host_pending_cancel_scopeChanged',...(source==='client'?{responseWitness:{route:'next',status:410,errorCode:'game_host_expired',...detail}}:detail)};
  f.archive.diagnostic(value);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'ct-terminal-01.json'))),value);
 }
});

for(const nativeSourceWitness of [{stage:'client-current',predicate:'scope_equal'},{stage:'client-current',predicate:'scope_current'},{stage:'client-current',predicate:'installation_current',exceptionClass:'TypeError'},{stage:'client-current',predicate:'native_source_current'},{stage:'client-refresh',predicate:'read_refresh_deadline'},{stage:'client-refresh',predicate:'refresh_rejected',exceptionClass:'RangeError'},{stage:'custody-pre',predicate:'inspect_not_fresh',ageMs:30001}])test('archive preserves client local cause '+nativeSourceWitness.predicate+' in both lanes',t=>{
 const f=archiveFixture(t);
 for(const [schemaVersion,name] of [['ct-runtime-first-cause/1','ct-diagnostic-01.json'],['ct-runtime-terminal-cause/1','ct-terminal-01.json']]){
  const value={schemaVersion,source:'client',phase:'poll',reason:'scopeChanged',nativeSourceWitness};f.archive.diagnostic(value);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,name))),value);
 }
 assert.equal(f.archive.snapshot().failed,false);
});
for(const patch of [{reason:'denied'},{source:'composition'},{nativeSourceWitness:{stage:'client-refresh',predicate:'refresh_rejected'}},{nativeSourceWitness:{stage:'client-refresh',predicate:'PRIVATE'}},{nativeSourceWitness:{stage:'client-current',predicate:'scope_current',nonce:'PRIVATE'}},{responseWitness:{route:'next',status:410}}])test('archive refuses invalid client local cause '+JSON.stringify(patch),t=>{
 const f=archiveFixture(t);assert.throws(()=>f.archive.diagnostic({schemaVersion:'ct-runtime-first-cause/1',source:'client',phase:'poll',reason:'scopeChanged',nativeSourceWitness:{stage:'client-current',predicate:'scope_current'},...patch}));assert.equal(f.archive.snapshot().failed,false);
});
