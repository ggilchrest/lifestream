// Actual frame-review owner and composition with synthetic pixels and a held
// adapter response. No native process, authenticated session or model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import {runInNewContext} from 'node:vm';
import {createReviewedLiveFrame,observeUntilFrameReviewed} from '../../../packages/providers-bizhawk/src/reviewed-live-frame.ts';
import {runGameObservationCommand} from '../src/runtime/game-observation-deadline.ts';
import {captureGameSanityTiming} from '../../../packages/providers-bizhawk/src/game-sanity-timing.ts';
import {gameCampaignFixture} from '../../../packages/runtime/test/fixtures/game-campaign.ts';

const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function png(pixel){
 const chunk=(name,data)=>{const value=Buffer.alloc(data.length+12);value.writeUInt32BE(data.length);value.write(name,4);data.copy(value,8);value.writeUInt32BE(crc32(value.subarray(4,data.length+8)),data.length+8);return value;};
 const header=Buffer.alloc(13);header.writeUInt32BE(2);header.writeUInt32BE(2,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,pixel,20,30,40,50,60,0,70,80,90,100,110,120]))),chunk('IEND',Buffer.alloc(0))]);
}
function fixture(t,{changeAfterApproval=false}={}){
 t.mock.timers.enable({apis:['setTimeout']});
 const directory=mkdtempSync(join(tmpdir(),'ct-frame-review-transition-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const scope=gameCampaignFixture().input.expectedScope,pins='a'.repeat(64),abort=new AbortController();
 let source,owner,latest,calls=0,release;
 const held=new Promise(resolve=>{release=resolve;});
 const sample=bytes=>{
  const now=Date.now(),capturedAt=new Date(now).toISOString();
  const screenshot={screenshotId:randomUUID(),mediaRef:'fixture:owned',sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,mediaType:'image/png',width:2,height:2,capturedAt,frameNumber:5,expiresAt:new Date(now+180000).toISOString()};
  const observation={schemaVersion:'1.0.0',recordType:'gameObservation',scope,observationId:randomUUID(),revision:1,pinsDigest:pins,frameNumber:5,capturedAt,receivedAt:capturedAt,interpretedAt:null,providerConfigurationRef:null,screenshots:[screenshot],facts:[],visibleState:[],previousActionId:null,untrusted:true};
  observation.visibleState=owner.decoder.decode({scope,observation,bytes,now});
  latest={observation,screenshot,bytes};return observation;
 };
 const raw=readFileSync(new URL('../src/runtime/ubuntu-game-composition.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export function createUbuntuGameComposition','function createUbuntuGameComposition');
 const factory=runInNewContext(raw+'\ncreateUbuntuGameComposition;',{randomUUID,runGameObservationCommand,captureGameSanityTiming,observeUntilFrameReviewed,createReviewedLiveFrame:options=>(owner=createReviewedLiveFrame(options)),gameInferenceSelectionDigest:()=> 'TEST-selected',supervisedGameProviderAvailable:()=>true,createGameCampaignOwner:options=>{source=options.source;return {campaign:{},createRepository(){}};},createUbuntuGameHostJoin:()=>({serverOptions:{},clientSnapshot:()=>({started:true})}),Date,Promise});
 const configuration={sessionProfile:'qualification',inferenceMode:'supervisedForeground',inferenceSelection:()=>({TEST:true}),attach:{scope,pinsDigest:pins},nativeInstallation:{frameManifestFile:join(directory,'frame.json'),frameManifest:{revision:'1.0.0',cues:[]}},nativeLaunch:{},campaign:{bounds:{maxActionFrames:12},policy:{revision:1},journal:{retentionPolicyRef:'TEST'}},maximumRunMs:90000,maximumCommandMs:100000};
 const composition=factory(configuration,{session:{current:()=>true,resolveApproval:()=>({sharedInference:true,approvedUntil:new Date(Date.now()+180000).toISOString()})},authority:{},nativeFactory:()=>({evidence:{frameForReview:()=>({...latest,bytes:Buffer.from(latest.bytes)})},close:async()=>{}})});
 const pending=source.observe({adapter:{observe:async()=>{calls++;const observation=sample(png(changeAfterApproval&&calls>=3?11:10));if(calls===2)await held;return {outcome:{payload:{observation}}};}}},abort.signal);
 return {composition,pending,owner,abort,release,calls:()=>calls};
}
test('an approved image clears waiting immediately and its in-flight stale observation cannot request another review',async t=>{
 const f=fixture(t);await flush();assert.equal(f.composition.snapshot().frameQualification,'waitingForHuman');
 t.mock.timers.tick(1000);await flush();assert.equal(f.calls(),2);
 const review=f.composition.reviewFrame();
 assert.throws(()=>f.composition.approveFrame({requestId:review.requestId,confirmationDigest:review.confirmationDigest,ordinaryGameplay:true,noProtectedMenus:false}));
 assert.equal(f.owner.approvalRevision(),0);assert.equal(f.composition.snapshot().frameQualification,'waitingForHuman');
 const approval={requestId:review.requestId,confirmationDigest:review.confirmationDigest,ordinaryGameplay:true,noProtectedMenus:true};
 f.composition.approveFrame(approval);
 assert.equal(f.owner.approvalRevision(),1);assert.equal(f.composition.snapshot().frameQualification,'qualified');
 assert.throws(()=>f.composition.approveFrame(approval));assert.equal(f.owner.approvalRevision(),1);
 f.release();const observation=await f.pending;
 assert.equal(f.calls(),3);assert.equal(f.owner.current(observation),true);assert.equal(f.composition.snapshot().frameQualification,'qualified');
});
test('a new unrecognized image after approval still requires its own actual review',async t=>{
 const f=fixture(t,{changeAfterApproval:true});await flush();t.mock.timers.tick(1000);await flush();
 const review=f.composition.reviewFrame();f.composition.approveFrame({requestId:review.requestId,confirmationDigest:review.confirmationDigest,ordinaryGameplay:true,noProtectedMenus:true});
 f.release();await flush();assert.equal(f.calls(),3);assert.equal(f.composition.snapshot().frameQualification,'waitingForHuman');assert.equal(f.owner.approvalRevision(),1);
 f.abort.abort();assert.equal(await f.pending,null);
});
