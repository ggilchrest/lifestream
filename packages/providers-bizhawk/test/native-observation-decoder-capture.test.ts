import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID,createHmac} from 'node:crypto';
import {createServer,connect} from 'node:net';
import {once} from 'node:events';
import {listenForNativeBizHawk} from '../src/native-host.ts';
import {GameControlFrameDecoder,encodeGameControlFrame} from '../src/transport.ts';
import {scriptedGameBounds} from '../../runtime/test/fixtures/game-policy.ts';
import {crc32,deflateSync} from 'node:zlib';
import {NativeGameEvidence} from '../src/native-evidence.ts';
import {GameFrameCustody} from '../src/frame-custody.ts';
import {createReviewedLiveFrame,observeUntilFrameReviewed} from '../src/reviewed-live-frame.ts';
import {LiveFrameDecoder} from '../src/live-frame-decoder.ts';
import {observe,observed} from './game-host-fixtures.ts';

const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
function png(){
 const chunk=(name:string,data:Buffer)=>{const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(name,4);data.copy(out,8);out.writeUInt32BE(crc32(out.subarray(4,data.length+8)),data.length+8);return out;};
 const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,100,20,30]))),chunk('IEND',Buffer.alloc(0))]);
}
function fixture(t:any,{staticDecoder=false}={}){
 const directory=mkdtempSync(join(tmpdir(),'native-decoder-capture-')),frames=join(directory,'frames');mkdirSync(frames);
 let wall=Date.now(),current=true;t.mock.method(Date,'now',()=>wall);
 const source=join(directory,'source');writeFileSync(source,'synthetic pinned native source');
 const request=observe(),scope=request.scope,bytes=png(),file=join(directory,'review.json');
 const owner=createReviewedLiveFrame({file,scope,pinsDigest:request.payload.expectedPinsDigest,initialManifest:{revision:'1.0.0',cues:[]},maximumRetentionMs:10000,expiresAt:()=>wall+10000});
 const custody=new GameFrameCustody(frames,{maxBytes:1024,maxQueueBytes:10000,maxLongEdge:256,maxFrames:32,maxTtlMs:10000,current:()=>current});
 const evidence=new NativeGameEvidence({directory,scope,pinsDigest:request.payload.expectedPinsDigest,providerRef:'synthetic-bridge',romSha1:'b'.repeat(40),sourceFiles:[{path:source,sha256:sha(Buffer.from('synthetic pinned native source'))}],custody,decoder:staticDecoder?new LiveFrameDecoder({revision:'1.0.0',cues:[]}):owner.decoder as any,sessionDurationMs:30000,isCurrent:()=>current});
 evidence.bindOwnedProcess({pid:123,exitCode:null,signalCode:null} as any);
 let sequence=0;
 const sample=({requestMs=10000,shotMs=10000,ingest=true}={})=>{
  const r={...request,requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:new Date(wall+requestMs).toISOString()},result=observed(r),observation=result.outcome.payload!.observation,shot=observation.screenshots[0]!,id=randomUUID();
  Object.assign(shot,{screenshotId:id,mediaRef:id,sha256:sha(bytes),byteLength:bytes.length,width:1,height:1,capturedAt:new Date(wall).toISOString(),expiresAt:new Date(wall+shotMs).toISOString()});observation.capturedAt=shot.capturedAt;observation.receivedAt=shot.capturedAt;
  writeFileSync(join(frames,id+'.png'),bytes);if(ingest)assert.equal(custody.ingest(observation),true);
  writeFileSync(evidence.evidenceFile,JSON.stringify({schemaVersion:'1.0.0',recordType:'nativeGameEvidence',scope,pinsDigest:observation.pinsDigest,providerRef:'synthetic-bridge',romSha1:'b'.repeat(40),version:'2.11.1',system:'SNES',sequence:++sequence,frameNumber:observation.frameNumber,monotonicMs:sequence,checkedAt:new Date(wall).toISOString(),buttonsAvailable:true,buttons:Object.fromEntries(['Up','Down','Left','Right','A','B','X','Y','L','R','Start','Select'].map(k=>[k,false])),event:'observation',lastObservation:result}));
  result.completedAt=new Date(wall).toISOString();
  return {request:r,result,observation,frame:{observation,screenshot:shot,bytes}};
 };
 const enrich=(s:ReturnType<typeof sample>)=>{
  // The fallback lets the regression demonstrate the actual pre-fix mismatch.
  const decoder=(evidence as any).captureObservationDecoder?.(s.request,s.observation)??{configurationRef:'live-frame:'+owner.decoder.manifestDigest,decode:({request,observation,bytes}:any)=>owner.decoder.decode({scope:request.scope,observation,bytes,now:wall})};
  return {...s.observation,visibleState:decoder.decode({request:s.request,observation:s.observation,bytes}),interpretedAt:new Date(wall).toISOString(),providerConfigurationRef:decoder.configurationRef};
 };
 const approve=(s:ReturnType<typeof sample>)=>{const review=owner.review(s.frame);return owner.approve({requestId:review.requestId,confirmationDigest:review.confirmationDigest,ordinaryGameplay:true,noProtectedMenus:true},s.frame);};
 t.after(()=>{custody.dispose();rmSync(directory,{recursive:true,force:true});});
 return {owner,evidence,custody,sample,enrich,approve,file,source,advance:(ms:number)=>{wall+=ms;},revoke:()=>{current=false;}};
}
test('approval during authentic observation validation keeps one decoder snapshot then reobserves under the approved revision',async t=>{
 const f=fixture(t);let calls=0,old:any;
 const result=await observeUntilFrameReviewed({signal:new AbortController().signal,current:()=>true,maximumRunMs:1000,frameOwner:f.owner,onWaiting:()=>{},observe:async()=>{
  const sample=f.sample(),value=f.enrich(sample);calls++;
  if(calls===1){old=value;f.approve(sample);assert.equal(f.owner.current(value),false);}
  assert.equal(f.evidence.acceptObservation(sample.request,value),true,'the real native evidence must re-decode with the captured manifest');
  assert.equal(f.evidence.acceptObservation(structuredClone(sample.request),structuredClone(value)),true,'the outer host guard independently validates the same bound result');
  return value;
 }});
 assert.equal(calls,2);assert.equal(f.owner.current(result),true);assert.notEqual(old.providerConfigurationRef,result.providerConfigurationRef);
});
test('captured decoder does not accept changed request, raw identity, fields, or attribution',t=>{
 const f=fixture(t),s=f.sample(),value=f.enrich(s);
 assert.equal(f.evidence.acceptObservation(s.request,value),true);
 for(const changed of [{...value,observationId:randomUUID()},{...value,previousActionId:randomUUID()},{...value,visibleState:[]},{...value,providerConfigurationRef:'live-frame:'+'f'.repeat(64)}])assert.equal(f.evidence.acceptObservation(s.request,changed),false);
 assert.equal(f.evidence.acceptObservation({...s.request,cancellationId:randomUUID()},value),false);
 assert.throws(()=> (f.evidence as any).captureObservationDecoder(s.request,s.observation),'a second capture cannot replace the original binding');
});
test('captured interpretation never preserves source authority, screenshot life, or request life',t=>{
 for(const mutation of ['current','source','screenshot','request'] as const){
  const f=fixture(t),s=f.sample({requestMs:mutation==='request'?100:10000}),value=f.enrich(s);
  if(mutation==='current')f.revoke();else if(mutation==='source')writeFileSync(f.source,'changed source');else f.advance(mutation==='screenshot'?10000:100);
  if(mutation==='request')assert.ok(f.custody.read(s.observation.screenshots[0]!.mediaRef,s.request.scope).bytes.length>0,'request expires while original screenshot custody remains current');
  assert.equal(f.evidence.acceptObservation(s.request,value),false,mutation);
 }
});
test('approved snapshot cannot keep approval current after manifest removal or expiry',t=>{
 const f=fixture(t),s=f.sample();f.approve(s);const value=f.enrich(s);assert.equal(f.owner.current(value),true);
 unlinkSync(f.file);assert.equal(f.owner.current(value),false);assert.equal(f.evidence.acceptObservation(s.request,value),true,'in-flight source validation alone supplies no review or action permission');
 f.advance(10000);assert.equal(f.owner.current(value),false);assert.equal(f.evidence.acceptObservation(s.request,value),false);
});
test('dynamic evidence refuses observation without its explicit capture',t=>{
 const f=fixture(t),s=f.sample(),value={...s.observation,visibleState:f.owner.decoder.decode({scope:s.request.scope,observation:s.observation,bytes:s.frame.bytes,now:Date.now()}),interpretedAt:new Date(Date.now()).toISOString(),providerConfigurationRef:'live-frame:'+f.owner.decoder.manifestDigest};
 assert.equal(f.evidence.acceptObservation(s.request,value),false);
});

test('decoder bindings have a fixed32-entry cap and expired original requests release capacity',t=>{
 const f=fixture(t);
 for(let i=0;i<32;i++){const s=f.sample({requestMs:100,shotMs:100});f.enrich(s);}
 const overflow=f.sample({ingest:false});assert.throws(()=>f.evidence.captureObservationDecoder(overflow.request,overflow.observation));
 f.advance(100);const next=f.sample();assert.doesNotThrow(()=>f.evidence.captureObservationDecoder(next.request,next.observation));
});
test('unchanging static decoder retains legacy independent validation without capture',t=>{
 const f=fixture(t,{staticDecoder:true}),s=f.sample(),decoder=new LiveFrameDecoder({revision:'1.0.0',cues:[]});
 const value={...s.observation,visibleState:decoder.decode({scope:s.request.scope,observation:s.observation,bytes:s.frame.bytes,now:Date.now()}),interpretedAt:new Date(Date.now()).toISOString(),providerConfigurationRef:'live-frame:'+decoder.manifestDigest};
 assert.equal(f.evidence.acceptObservation(s.request,value),true);assert.equal(f.evidence.acceptObservation(s.request,{...value,visibleState:[]}),false);
});
test('captured decoder closure cannot be reused with changed source or after its original deadline',t=>{
 const f=fixture(t),s=f.sample({requestMs:100}),decoder=f.evidence.captureObservationDecoder(s.request,s.observation);
 assert.throws(()=>decoder.decode({request:s.request,observation:{...s.observation,revision:2},bytes:s.frame.bytes}));
 f.advance(100);assert.throws(()=>decoder.decode({request:s.request,observation:s.observation,bytes:s.frame.bytes}));
});

test('authenticated native host derives fields and attribution from one captured decoder across approval', {timeout:10000},async t=>{
 const f=fixture(t),s=f.sample({ingest:false}),secret=Buffer.alloc(32,23),temporary=createServer();temporary.listen(0,'127.0.0.1');await once(temporary,'listening');const port=(temporary.address() as any).port;await new Promise<void>(resolve=>temporary.close(()=>resolve()));
 let client:any,host:any;let captured=0;
 try{
  host=await listenForNativeBizHawk({port,connectionTimeoutMs:2000,pairingSecret:secret,scope:s.request.scope,pinsDigest:s.observation.pinsDigest,authenticationTimeoutMs:1000,sessionDurationMs:10000,boundary:{providerRef:'synthetic-bridge',maxDurationMs:10000,sourceAvailable:f.evidence.sourceAvailable,acceptObservation:f.evidence.acceptObservation},onDisconnect:()=>{},frameCustody:f.custody,bounds:scriptedGameBounds,romSha1:'b'.repeat(40),frameDecoder:{
   configurationRef:()=> 'live-frame:'+f.owner.decoder.manifestDigest,
   decode:()=>{throw Error('Captured path required');},
   capture:(request,observation)=>{captured++;const snapshot=f.evidence.captureObservationDecoder(request,observation);return {...snapshot,decode:input=>{const fields=snapshot.decode(input);f.approve(s);return fields;}};}
  }});
  client=connect(port,'127.0.0.1');client.on('error',()=>{});
  const wire=new GameControlFrameDecoder(text=>{const message=JSON.parse(text);if(message.type==='challenge')client.write(encodeGameControlFrame(JSON.stringify({type:'authenticate',proof:createHmac('sha256',secret).update(text).digest('hex')})));else if(message.operation==='GameActivityAdapter.observe')client.write(encodeGameControlFrame(JSON.stringify(s.result)));});client.on('data',(bytes:Buffer)=>wire.push(bytes));
  const transport=await host.connected;await transport.ready;
  const result=await transport.adapter.observe(s.request,{signal:new AbortController().signal,isCurrent:()=>true}),value=result.outcome.payload!.observation;
  assert.equal(captured,1);assert.equal(f.owner.current(value),false);assert.equal(value.providerConfigurationRef,'live-frame:'+value.visibleState[0]!.manifestDigest);
  assert.notEqual(value.providerConfigurationRef,'live-frame:'+f.owner.decoder.manifestDigest);
  assert.equal(f.evidence.acceptObservation(s.request,structuredClone(value)),true,'outer validation retains captured provenance after transport serialization');
 }finally{client?.destroy();await host?.close();}
});
