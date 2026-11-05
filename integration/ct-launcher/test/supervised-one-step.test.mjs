// Pure actual validators and original supervisor with inert ports only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {captureCanonicalCtOptions} from '../../../apps/server/src/runtime/canonical-ct-configuration.ts';
import {finiteSupervisedGameConfiguration,supervisedSessionBounds} from '../../../apps/server/src/runtime/supervised-game-session.ts';
import {validateDedicatedCtSelection} from '../dedicated-ct-job.mjs';
import {createSupervisedGameRuntime} from '../../../scripts/supervised-game-runtime.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
function configuration(steps=1){
 return {attach:{},campaign:{bounds:{...supervisedSessionBounds}},inferenceMode:'supervisedForeground',inferenceQualificationFile:'/TEST-never-read/inference.json',initialDialogue:'',goalMode:'movementOnly',maximumCommandMs:3000,maximumContextBytes:65536,maximumObservationAgeMs:10000,maximumPlanningSteps:steps,maximumRunMs:90000,metadataRetentionMs:60000,nativeInstallation:{kind:'c72-container',configurationFile:'/TEST-never-read/facts.json'},nativeLaunch:{host:'127.0.0.1'},nativePreparation:{},planningBounds:{deadlineMs:3000,maximumInputTokens:8192,maximumOutputTokens:1024},profile:{profileId:randomUUID(),revision:1},sessionProfile:'supervised8',startLimits:{},template:Object.fromEntries(['principalId','assistantId','relationshipId','environmentId'].map(k=>[k,randomUUID()]))};
}
function inputs(value){
 const bytes=Buffer.from(JSON.stringify(value)),jobId=randomUUID();
 const selection={schemaVersion:'canonical-dedicated-ct-job/4',enabled:true,jobId,nonce:'a'.repeat(32),ownerBinding:'originalBrowserRequest',jobRoot:'/srv/lifestream/workspace/runtime-state/ct-owner-job-'+jobId,metadataDirectory:'/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-'+jobId,configurationSha256:hash(bytes),preparation:{mode:'untilCancelled'},execution:{maximumGameplayMs:80000,operationLimits:{owner_prepare:30000,native_prepare:30000,native_start:30000,model:3000,controller:500,settle:5000},cleanupTimeoutMs:10000}};
 return {bytes,selection,pin:{configurationSha256:hash(bytes),...value.template,profileId:value.profile.profileId,profileRevision:value.profile.revision}};
}
function canonical(value){const {bytes,pin}=inputs(value);return captureCanonicalCtOptions(bytes,pin);}
function acceptedChain(value){
 assert.equal(finiteSupervisedGameConfiguration(value),true);const {bytes,pin,selection}=inputs(value);
 const captured=captureCanonicalCtOptions(bytes,pin);assert.deepEqual(JSON.parse(JSON.stringify(captured.ubuntuGame)),value);
 assert.deepEqual(validateDedicatedCtSelection(selection,value,bytes),selection);assert(Object.isFrozen(captured.ubuntuGame));
}
test('actual canonical capture and unchanged dedicated selection accept exactly 1 or 8 supervised planning steps',()=>{for(const steps of [1,8])acceptedChain(configuration(steps));});
test('finite and canonical gates reject other, fractional, nonfinite and coercible planning counts',()=>{
 for(const steps of [undefined,null,0,2,7,9,-1,1.5,'1','8',true,NaN,Infinity]){const value=configuration(steps);if(steps===undefined)delete value.maximumPlanningSteps;assert.equal(finiteSupervisedGameConfiguration(value),false);assert.throws(()=>canonical(value));}
});
test('native supervised8 bounds stay exact: no 1/1 envelope, clock, runtime or planning-budget relaxation',()=>{
 for(const [key,changed] of Object.entries(supervisedSessionBounds)){const value=configuration();value.campaign.bounds[key]=typeof changed==='number'?changed+1:typeof changed==='boolean'?!changed:'continuesNormally';assert.equal(finiteSupervisedGameConfiguration(value),false,key);assert.throws(()=>canonical(value));}
 for(const steps of [1,8]){
  for(const change of [v=>{v.maximumRunMs=90001;},v=>{v.maximumRunMs=89999;},v=>{v.inferenceMode='backgroundP2';},v=>{v.planningBounds.deadlineMs=3001;},v=>{v.planningBounds.maximumInputTokens=8193;},v=>{v.planningBounds.maximumOutputTokens=1025;},v=>{v.campaign.bounds.actionBudget=1;v.campaign.bounds.modelCallBudget=1;}]){const value=configuration(steps);change(value);assert.equal(finiteSupervisedGameConfiguration(value),false);assert.throws(()=>canonical(value));}
 }
});
test('canonical and dedicated existing identity/native/owner/pin guards stay in force',()=>{
 const value=configuration(),{bytes,pin,selection}=inputs(value);
 for(const changed of [{...pin,configurationSha256:'f'.repeat(64)},{...pin,principalId:randomUUID()},{...pin,profileRevision:2}])assert.throws(()=>captureCanonicalCtOptions(bytes,changed));
 for(const change of [v=>{v.nativeInstallation.kind='foreign';},v=>{v.nativeLaunch.host='192.0.2.1';},v=>{v.unreviewed=true;},v=>{delete v.sessionProfile;}]){const next=configuration();change(next);assert.throws(()=>canonical(next));}
 for(const changed of [{...selection,ownerBinding:'foreign'},{...selection,configurationSha256:'f'.repeat(64)},{...selection,jobRoot:'/TEST-foreign'}])assert.throws(()=>validateDedicatedCtSelection(changed,value,bytes));
});

async function runSupervisor(maximumSteps,mode='action'){
 const counts={selected:0,prepared:0,model:0,controllerPrepared:0,controller:0,settled:0,shutdown:0,closed:0};let current=true;
 const scope={TEST:'synthetic'},repository={TEST:'inert'},step={TEST:'step'},selection={TEST:'selection'},controller={TEST:'controller'};
 const native=Object.fromEntries(['resolveAttachment','bindingCurrent','controllerCurrent','sourceCurrent','sourceAvailable','acceptObservation','acceptAction','reconcileEffect','admitRelease','usageFor'].map(k=>[k,()=>true]));
 native.shutdownExactOldLease=async()=>{counts.shutdown++;return true;};
 const campaign={selectPlanning:async()=>{counts.selected++;return {selection,bounds:{TEST:'bounds'}};},planningCurrent:()=>true,terminalRef:()=>null,publishDecision:()=>true,prepareController:async()=>{counts.controllerPrepared++;return mode==='noAction'?null:controller;},controllerCurrent:()=>true,recordSettledStep:async()=>{counts.settled++;return {journalCommitted:true,goalReached:false};}};
 const original=createSupervisedGameRuntime({native,campaign,createRepository:()=>repository,resolveApproval:()=>null,maximumSteps,maximumRunMs:90000,maximumCommandMs:3000});
 original.gameHost.createRepository({TEST:'inert'});
 const runtime={isCurrent:()=>current,preparePlanning:()=>{counts.prepared++;return step;},runPlanning:async()=>{counts.model++;if(mode==='modelFailure')return {state:'suppressed'};return {state:'published'};},publishEpisode:()=>({state:'unavailable'}),controllerCurrent:()=>true,close:()=>{counts.closed++;current=false;}};
 original.gameHost.onAttached({runtime,runController:async()=>{counts.controller++;return {state:'settled'};}});
 await original.completion();return counts;
}
test('actual supervisor executes at most one model and selected controller operation then original cleanup for maximumSteps1',async()=>{
 const counts=await runSupervisor(1);assert.deepEqual(counts,{selected:1,prepared:1,model:1,controllerPrepared:1,controller:1,settled:1,shutdown:1,closed:1});
});
test('actual supervisor retains eight-step behavior and does not manufacture an action from no-action or model refusal',async()=>{
 const eight=await runSupervisor(8);assert.equal(eight.model,8);assert.equal(eight.controller,8);assert.equal(eight.shutdown,1);
 const noAction=await runSupervisor(1,'noAction');assert.equal(noAction.model,1);assert.equal(noAction.controller,0);assert.equal(noAction.shutdown,1);
 const failure=await runSupervisor(1,'modelFailure');assert.equal(failure.model,1);assert.equal(failure.controller,0);assert.equal(failure.shutdown,1);
});
