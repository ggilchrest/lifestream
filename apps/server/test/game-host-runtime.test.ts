// Synthetic proof/consent data only. No runtime/native qualification is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {captureGameRuntimeOptions,qualifiedGameInferenceBounds,gameInferenceSelectionDigest,approvedGameRuntimeRun,productionGameMemory} from '../src/runtime/game-host-runtime.ts';
import type {GameRuntimeOptions,GameInferenceQualification} from '../src/runtime/game-host-runtime.ts';
import {fixtureEpisode} from '../../../packages/runtime/test/fixtures/game-memory.ts';
const selection={configurationDigest:'a'.repeat(64),providerRef:'synthetic:llama',providerRevision:'synthetic:reviewed',model:'synthetic:model',modelArtifactDigest:'b'.repeat(64),healthy:true,fixture:false};
function proof():GameInferenceQualification{return {selectionDigest:gameInferenceSelectionDigest(selection),qualificationRef:'synthetic:independent-runtime-envelope',preemptionBoundMs:10,slotReleaseBoundMs:250,current:()=>true};}
function options(p:GameInferenceQualification|null=null):GameRuntimeOptions{return {resolveApproval:()=>null,sourceCurrent:()=>false,inferenceQualificationFor:()=>p};}
test('missing/mismatched/noncurrent inference qualification never supplies P2 bounds',()=>{
 assert.equal(qualifiedGameInferenceBounds(options(),selection),null);
 for(const change of [{selectionDigest:'c'.repeat(64)},{preemptionBoundMs:10.01},{slotReleaseBoundMs:250.01},{qualificationRef:''},{current:()=>false}])assert.equal(qualifiedGameInferenceBounds(options({...proof(),...change}),selection),null);
 assert.equal(qualifiedGameInferenceBounds(options(proof()),{...selection,healthy:false}),null);
 assert.equal(qualifiedGameInferenceBounds(options(proof()),{...selection,fixture:true}),null);
});
test('qualified exact-selection proof is fenced by evidence/function/threshold mutation',()=>{
 for(const field of ['current','selectionDigest','slotReleaseBoundMs']as const){const p=proof(),bound=qualifiedGameInferenceBounds(options(p),selection)!;assert.ok(bound.current());
  if(field==='current')p.current=()=>true;if(field==='selectionDigest')p.selectionDigest='d'.repeat(64);if(field==='slotReleaseBoundMs')p.slotReleaseBoundMs=251;assert.equal(bound.current(),false);
 }
});
test('production approval requires an exact finite logical scope and closed consent shape',()=>{
 const e=fixtureEpisode(),scope=e.scope,approved={scope,approvedUntil:new Date(Date.now()+30000).toISOString(),maximumRunMs:1000,maximumPlanningSteps:2,observations:true as const,campaignJournal:true as const,controllerInput:false,memoryEpisodes:true};
 const o={...options(),resolveApproval:()=>approved};assert.ok(approvedGameRuntimeRun(o,scope));
 assert.equal(approvedGameRuntimeRun({...o,resolveApproval:()=>({...approved,scope:{...scope,principalId:randomUUID()}})},scope),null);
 assert.equal(approvedGameRuntimeRun({...o,resolveApproval:()=>({...approved,approvedUntil:new Date(Date.now()-1).toISOString()})},scope),null);
 assert.equal(approvedGameRuntimeRun({...o,resolveApproval:()=>({...approved,maximumRunMs:120001})},scope),null);
 assert.equal(approvedGameRuntimeRun({...o,resolveApproval:()=>({...approved,credential:'synthetic-forbidden-field'})},scope),null);
});
test('separate production retention consent must match the independently configured policy',()=>{
 const e=fixtureEpisode();const original={source:{maximumFences:4,scopeCurrent:()=>true,quarantined:()=>false,retentionFor:()=>({retentionMs:1000,retentionPolicyRef:'synthetic:policy',maximumEpisodes:1,maximumBytes:8192}),sourceRecordsFor:()=>null,meaningfulGroundingCurrent:()=>false,publicationCurrent:()=>true,retainedSourceCurrent:()=>true},maximumCandidates:1,estimate:()=>null};
 const o=captureGameRuntimeOptions({...options(),memory:{options:original,retentionConsentRefFor:()=>null}}),memory=productionGameMemory(o)!;
 assert.equal(memory.source.retentionFor({principalId:e.scope.principalId,assistantId:e.scope.assistantId,relationshipId:e.scope.relationshipId},e.scope.activityId),null);assert.equal(memory.source.publicationCurrent(e),false);
 assert.throws(()=>captureGameRuntimeOptions({...options(),memory:{options:{...original,maximumCandidates:5},retentionConsentRefFor:()=>null}}),/unavailable/);
});
