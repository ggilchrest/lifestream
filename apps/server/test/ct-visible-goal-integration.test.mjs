// Pinned public configuration only. No private state, authentication or runtime.
import test from 'node:test';import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
const mode=process.env.CT_BINDING_ENTRY??'source';if(!['source','compiled'].includes(mode))throw Error('Closed test entry required');
const prefix=mode==='compiled'?'../dist':'../src',ext=mode==='compiled'?'js':'ts';
const {captureCanonicalCtOptions}=await import(`${prefix}/runtime/canonical-ct-configuration.${ext}`);
const {supervisedSessionBounds,applySupervisedGameSanityTiming,finiteSupervisedGameConfiguration}=await import(`${prefix}/runtime/supervised-game-session.${ext}`);
function fixture(){
 const profileId=randomUUID(),template=Object.fromEntries(['principalId','assistantId','relationshipId','environmentId'].map(k=>[k,randomUUID()]));
 const value={attach:{},campaign:{bounds:{...supervisedSessionBounds}},inferenceMode:'supervisedForeground',inferenceQualificationFile:'/TEST-never-read',initialDialogue:'TEST reviewed dialogue',maximumCommandMs:3000,maximumContextBytes:65536,maximumObservationAgeMs:10000,maximumPlanningSteps:8,maximumRunMs:90000,metadataRetentionMs:60000,nativeInstallation:{kind:'c72-container'},nativeLaunch:{host:'127.0.0.1'},nativePreparation:{},planningBounds:{deadlineMs:3000,maximumInputTokens:8192,maximumOutputTokens:1024},profile:{profileId,revision:1},sessionProfile:'supervised8',startLimits:{},template};
 const capture=()=>{const bytes=Buffer.from(JSON.stringify(value));return captureCanonicalCtOptions(bytes,{...template,profileId,profileRevision:1,configurationSha256:createHash('sha256').update(bytes).digest('hex')});};
 return {value,capture};
}
test('canonical original dialogue and explicit closed-dialogue movement configs preserve exact supervised envelope',()=>{
 for(const movement of [false,true]){const f=fixture();if(movement){f.value.goalMode='movementOnly';f.value.initialDialogue='';}
  const {ubuntuGame}=f.capture();assert.deepEqual(ubuntuGame,f.value);assert.ok(Object.isFrozen(ubuntuGame));assert.equal(ubuntuGame.maximumRunMs,90000);assert.equal(ubuntuGame.campaign.bounds.actionBudget,8);assert.equal(ubuntuGame.campaign.bounds.modelCallBudget,8);
 }
});
test('canonical capture rejects ambiguous goal selection and wire-like widening',()=>{
 for(const change of [v=>{v.initialDialogue='';},v=>{v.goalMode='movementOnly';},v=>{v.goalMode='invented';},v=>{v.allowSnesStart=true;},v=>{v.goalMode='movementOnly';v.initialDialogue='';v.campaign.bounds.actionBudget=9;},v=>{v.goalMode='movementOnly';v.initialDialogue='';v.maximumRunMs=90001;}]){
  const f=fixture();change(f.value);assert.throws(f.capture,/Pinned canonical CT configuration unavailable/);
 }
});
test('general image observation has no expected dialogue or scene answers and retains the finite budget',()=>{
 const f=fixture();f.value.goalMode='observedGameplay';f.value.initialDialogue='';f.value.gameFrameVision={qualificationFile:'/TEST-never-read'};
 const {ubuntuGame}=f.capture();assert.equal(ubuntuGame.campaign.bounds.modelCallBudget,8);assert.equal(ubuntuGame.initialDialogue,'');
 for(const change of [v=>{v.initialDialogue='TEST supplied answer';},v=>{v.reviewedSceneProfile={};},v=>{delete v.gameFrameVision;}]){const negative=fixture();Object.assign(negative.value,{goalMode:'observedGameplay',initialDialogue:'',gameFrameVision:{qualificationFile:'/TEST-never-read'}});assert.doesNotThrow(negative.capture);change(negative.value);assert.throws(negative.capture,/Pinned canonical CT configuration unavailable/);}
});
test('legacy timer encodings normalize to coherent sanity bounds without changing effect or resource limits',()=>{
 const f=fixture(),original=structuredClone(f.value);assert.equal(finiteSupervisedGameConfiguration(f.value),true);
 const active=applySupervisedGameSanityTiming(f.value);assert.deepEqual(f.value,original);
 assert.equal(active.maximumCommandMs,15000);assert.equal(active.maximumObservationAgeMs,180000);assert.equal(active.planningBounds.deadlineMs,60000);
 assert.equal(active.campaign.bounds.decisionDeadlineMs,60000);assert.equal(active.campaign.bounds.maxPlanningAgeMs,180000);
 const {decisionDeadlineMs,maxPlanningAgeMs,...effects}=active.campaign.bounds;
 const {decisionDeadlineMs:oldDecision,maxPlanningAgeMs:oldAge,...previousEffects}=original.campaign.bounds;
 assert.deepEqual(effects,previousEffects);assert.equal(active.maximumRunMs,90000);assert.equal(active.campaign.bounds.modelCallBudget,8);assert.equal(active.campaign.bounds.maxActionWallMs,500);
 assert.equal(finiteSupervisedGameConfiguration(active),true);
 for(const mutate of [v=>{v.maximumRunMs=90001;},v=>{v.campaign.bounds.actionBudget=9;},v=>{v.campaign.bounds.maxActionWallMs=501;},v=>{v.sanityTiming={planningTimeoutMs:0};}]){const invalid=structuredClone(active);mutate(invalid);assert.equal(finiteSupervisedGameConfiguration(invalid),false);}
});
