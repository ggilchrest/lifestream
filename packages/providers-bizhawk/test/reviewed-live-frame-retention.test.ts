import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import {createReviewedLiveFrame} from '../src/reviewed-live-frame.ts';
const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
function png(pixel=10){
 const chunk=(name:string,data:Buffer)=>{const value=Buffer.alloc(data.length+12);value.writeUInt32BE(data.length);value.write(name,4);data.copy(value,8);value.writeUInt32BE(crc32(value.subarray(4,data.length+8)),data.length+8);return value;};
 const header=Buffer.alloc(13);header.writeUInt32BE(2);header.writeUInt32BE(2,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,pixel,20,30,40,50,60,0,70,80,90,100,110,120]))),chunk('IEND',Buffer.alloc(0))]);
}
function fixture(t:any,options:{retention?:number;shotMs?:number;authorityMs?:number}={}){
 const directory=mkdtempSync(join(tmpdir(),'reviewed-frame-retention-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const initial=Date.parse('2026-10-20T20:00:00Z');let now=initial;t.mock.method(Date,'now',()=>now);
 const id=()=>randomUUID(),scope={assistantId:id(),principalId:id(),relationshipId:id(),environmentId:id(),activityId:id(),runId:id(),activityEpoch:1,timelineId:id(),timelineRevision:1,campaignId:id(),observationDomain:'simulatedGame',contextBinding:{conversationId:id(),sessionId:id(),endpointId:id(),participationKind:'logicalActivity',humanSpeakerRef:null,audioOwnerEndpointId:null,ownerPermissionRef:'synthetic-operator-fixture'}};
 const bytes=png(),shot={screenshotId:id(),mediaRef:'fixture:owned',sha256:sha(bytes),byteLength:bytes.length,mediaType:'image/png',width:2,height:2,capturedAt:new Date(initial).toISOString(),frameNumber:5,expiresAt:new Date(initial+(options.shotMs??180000)).toISOString()};
 const observation={schemaVersion:'1.0.0',recordType:'gameObservation',scope,observationId:id(),revision:1,pinsDigest:'a'.repeat(64),frameNumber:5,capturedAt:shot.capturedAt,receivedAt:shot.capturedAt,interpretedAt:null,providerConfigurationRef:null,screenshots:[shot],facts:[],visibleState:[],previousActionId:null,untrusted:true};
 const file=join(directory,'frame.json'),owner=createReviewedLiveFrame({file,scope,pinsDigest:observation.pinsDigest,initialManifest:{revision:'1.0.0',cues:[]},expiresAt:()=>initial+(options.authorityMs??300000),...(options.retention===undefined?{}:{maximumRetentionMs:options.retention})});
 const frame={observation,screenshot:shot,bytes},review=owner.review(frame),body={requestId:review.requestId,confirmationDigest:review.confirmationDigest,ordinaryGameplay:true,noProtectedMenus:true};
 const current=()=>{const visibleState=owner.decoder.decode({scope,observation,bytes,now});return owner.current({...observation,visibleState});};
 return {owner,frame,body,initial,file,advance:(ms:number)=>{now=initial+ms;},current};
}
test('genuine PNG safety review remains current after130s model tail under explicit180s original capture retention',t=>{
 const f=fixture(t,{retention:180000});f.advance(20000);const approval=f.owner.approve(f.body,f.frame);assert.equal(Date.parse(approval.expiresAt),f.initial+180000,'retention starts at original capture, not approval');
 f.advance(130000);assert.equal(f.current(),true);f.advance(180000);assert.equal(f.current(),false);
});
test('explicit retention clips to original screenshot and actual native/controller expiry without restamping',t=>{
 const f=fixture(t,{retention:300000,shotMs:180000,authorityMs:150000});f.advance(20000);assert.equal(Date.parse(f.owner.approve(f.body,f.frame).expiresAt),f.initial+150000);f.advance(150000);assert.equal(f.current(),false);
});
test('changed original PNG and changed held-frame scope cannot be approved',t=>{
 const f=fixture(t,{retention:180000});assert.throws(()=>f.owner.approve(f.body,{...f.frame,bytes:png(11)}));assert.throws(()=>f.owner.approve(f.body,{...f.frame,observation:{...f.frame.observation,scope:{...f.frame.observation.scope,runId:randomUUID()}}}));
});
test('changed persisted source scope and excessive persisted expiry refuse currentness',t=>{
 const f=fixture(t,{retention:180000});f.owner.approve(f.body,f.frame);const original=JSON.parse(readFileSync(f.file,'utf8'));
 writeFileSync(f.file,JSON.stringify({...original,scopeDigest:'b'.repeat(64)}),{mode:0o600});assert.equal(f.current(),false);
 writeFileSync(f.file,JSON.stringify({...original,expiresAt:new Date(f.initial+300000).toISOString()}),{mode:0o600});assert.equal(f.current(),false);
});
test('legacy default remains120s and configured invalid retention refuses at construction',t=>{
 const f=fixture(t);f.owner.approve(f.body,f.frame);f.advance(119999);assert.equal(f.current(),true);f.advance(120000);assert.equal(f.current(),false);
 for(const maximumRetentionMs of [0,300001,true,NaN])assert.throws(()=>createReviewedLiveFrame({maximumRetentionMs}));
});
test('explicit original shot already expired or retention consumed during review cannot be approved',t=>{
 for(const shotMs of [180000,300000]){const f=fixture(t,{retention:180000,shotMs});f.advance(180000);assert.throws(()=>f.owner.approve(f.body,f.frame));}
});
