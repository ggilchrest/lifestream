// Synthetic PNG/owned-frame joins only. No native child, provider or private DB.
import test from 'node:test';import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';import {crc32,deflateSync} from 'node:zlib';
import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';
import {runGameObservationCommand} from '../src/runtime/game-observation-deadline.ts';
import {captureGameSanityTiming} from '../../../packages/providers-bizhawk/src/game-sanity-timing.ts';
import {gameCampaignFixture} from '../../../packages/runtime/test/fixtures/game-campaign.ts';
import {observeUntilFrameReviewed} from '@lifestream/providers-bizhawk/reviewed-live-frame';
const mode=process.env.CT_BINDING_ENTRY??'source';if(!['source','compiled'].includes(mode))throw Error('Closed test entry');
const prefix=mode==='compiled'?'../dist':'../src',ext=mode==='compiled'?'js':'ts';
const {captureCtObservationEvidence}=await import(`${prefix}/runtime/ct-observation-evidence.${ext}`);
function fixture(){
 const chunk=(name,body)=>{const b=Buffer.alloc(body.length+12);b.writeUInt32BE(body.length);b.write(name,4);body.copy(b,8);b.writeUInt32BE(crc32(b.subarray(4,body.length+8)),body.length+8);return b;};
 const header=Buffer.alloc(13);header.writeUInt32BE(2);header.writeUInt32BE(2,4);header[8]=8;header[9]=2;
 const bytes=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(14))),chunk('IEND',Buffer.alloc(0))]);
 const o=gameCampaignFixture().input.observation;o.scope.contextBinding.ownerPermissionRef='SECRET-owner-permission';
 Object.assign(o.screenshots[0],{width:2,height:2,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 return {scope:o.scope,o,frame:{observation:structuredClone(o),screenshot:structuredClone(o.screenshots[0]),bytes}};
}
test('actual PNG metadata omits private scope and never labels an unknown scene as matched',()=>{
 const f=fixture(),e=captureCtObservationEvidence(f.scope,f.o,f.frame,'TEST-human-reference-only');
 assert.equal(e.screenshot.sha256,f.o.screenshots[0].sha256);assert.equal(e.interpretation.matchedReviewedScene,false);
 assert.match(e.interpretation.pixelFacts,/AUTOMATIC/);assert.match(e.interpretation.sceneSemantics,/UNSPECIFIED/);assert.doesNotMatch(e.interpretation.sceneSemantics,/HUMAN/);
 assert.equal(JSON.stringify(e).includes('SECRET-owner-permission'),false);assert.equal(e.controllerAuthority,false);
});
test('mismatched native readback, PNG, scope, dimensions and expired image are refused',()=>{
 for(const change of [f=>f.frame.observation.frameNumber++,f=>{f.frame.bytes[40]^=1;},f=>{f.frame.observation.scope.timelineId=randomUUID();},f=>{f.o.screenshots[0].width=3;f.frame.screenshot.width=3;},f=>{f.o.screenshots[0].expiresAt=new Date(0).toISOString();f.frame.screenshot.expiresAt=f.o.screenshots[0].expiresAt;}]){
  const f=fixture();change(f);assert.throws(()=>captureCtObservationEvidence(f.scope,f.o,f.frame,null));
 }
});
test('actual composition archives an unknown resulting PNG before reviewed-frame rejection and buffer cleanup',async()=>{
 const f=fixture();let source,record,archived;
 const raw=readFileSync(new URL('../src/runtime/ubuntu-game-composition.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export function createUbuntuGameComposition','function createUbuntuGameComposition');
 const factory=runInNewContext(raw+'\ncreateUbuntuGameComposition;',{randomUUID,runGameObservationCommand,captureGameSanityTiming,captureCtObservationEvidence,observeUntilFrameReviewed,createReviewedLiveFrame:()=>({current:o=>!o,stopOnUnknown:true}),gameInferenceSelectionDigest:()=> 'TEST-selected',supervisedGameProviderAvailable:()=>true,createGameCampaignOwner:o=>{source=o.source;return {campaign:{},createRepository(){}};},createUbuntuGameHostJoin:()=>({serverOptions:{}}),Date,Promise});
 const configuration={sessionProfile:'qualification',inferenceMode:'supervisedForeground',inferenceSelection:()=>({TEST:true}),attach:{scope:f.scope,pinsDigest:'a'.repeat(64)},nativeInstallation:{frameManifestFile:'/TEST-never-read'},nativeLaunch:{},campaign:{bounds:{maxActionFrames:12},policy:{revision:1},journal:{retentionPolicyRef:'TEST'}},maximumRunMs:1000,maximumCommandMs:500,onObservation:(value,bytes)=>{record=value;archived=Buffer.from(bytes);}};
 factory(configuration,{session:{current:()=>true,resolveApproval:()=>({sharedInference:true})},authority:{},nativeFactory:()=>({evidence:{frameForReview:()=>f.frame},close:async()=>{}})});
 const observation=await source.observe({adapter:{observe:async()=>({outcome:{payload:{observation:f.o}}})}},new AbortController().signal);
 assert.equal(observation,null);assert.equal(record.observationId,f.o.observationId);assert.equal(record.interpretation.matchedReviewedScene,false);
 assert.equal(createHash('sha256').update(archived).digest('hex'),f.o.screenshots[0].sha256);assert.equal(f.frame.bytes.every(b=>b===0),true);
});
