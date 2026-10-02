import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import {gameCampaignFixture} from '../../../packages/runtime/test/fixtures/game-campaign.ts';
import {createGameObservationReader,type GameFrameDecoder} from '../src/runtime/game-frame-interpretation.ts';
import type {GameHostJoin} from '../src/runtime/game-host-port.ts';
import type * as G from '@lifestream/contracts/game-activity';
function png(){const chunk=(type:string,data:Buffer)=>{const head=Buffer.alloc(8),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);head.write(type,4);tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4),data])));return Buffer.concat([head,data,tail]);},header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0]))),chunk('IEND',Buffer.alloc(0))]);}
function fixture(){
 const f=gameCampaignFixture(),observation=structuredClone(f.input.observation),bytes=png();let owned:Buffer|undefined,observes=0,reads=0,decodes=0,current=true;
 const shot=observation.screenshots[0]!;shot.sha256=createHash('sha256').update(bytes).digest('hex');shot.byteLength=bytes.length;shot.width=1;shot.height=1;
 const decoded=()=>({facts:[{factId:randomUUID(),description:'Fixture red pixel; no actual CT interpretation.',epistemicKind:'visibleFeature' as const,sourceScreenshotIds:[shot.screenshotId],extractionKind:'visibleUiExtractor' as const,extractorRef:'fixture:pixels-only',uncertainty:'Single scripted pixel only.',limitations:['No game scene or hidden state.'],sourceKind:'playerVisibleGameObservation' as const,untrusted:true as const}],visibleState:[{fieldId:'fixture:pixel',value:'red',visibility:'visibleNow' as const,firstObservedRef:observation.observationId,lastObservedRef:observation.observationId,timelineId:observation.scope.timelineId,observedAt:observation.receivedAt,freshUntil:shot.expiresAt,decoderRevision:'1.0.0',manifestDigest:'a'.repeat(64),limitations:['Scripted pixels-only decoder.']}]});
 const decoder:GameFrameDecoder={purpose:'simulatedGame/gameFramebuffer',configurationRef:'fixture:pixels-only',decoderRevision:'1.0.0',manifestDigest:'a'.repeat(64),allowedVisibleFieldIds:['fixture:pixel'],capability:{kind:'nativeVisibleUi'},current:()=>current,decode:async input=>{decodes++;assert.equal(input.purpose,'simulatedGame/gameFramebuffer');assert.deepEqual(input.bytes,bytes);return decoded();}};
 const options={decoder:decoder as GameFrameDecoder|undefined,sourceCurrent:()=>current,pinsDigestFor:()=>observation.pinsDigest,readFrame:async()=>{reads++;owned=Buffer.from(bytes);return owned;},maximumDurationMs:100,maximumBytes:1024,maximumLongEdge:256,maximumObservationAgeMs:10000};
 const join={scope:observation.scope,runtime:{isCurrent:()=>current},adapter:{observe:async(request:G.GameObserveRequest)=>{observes++;return {schemaVersion:'1.0.0',operation:request.operation,requestId:request.requestId,correlationId:request.correlationId,providerRef:'fixture:native',completedAt:new Date().toISOString(),outcome:{status:'succeeded',payload:{observation:structuredClone(observation),reconciledAction:null},error:null}};}}} as unknown as GameHostJoin;
 return {options,decoder,join,observation,shot,decoded,bytes,owned:()=>owned,counts:()=>({observes,reads,decodes}),withdraw:()=>{current=false;}};
}
test('purpose-bound reader invokes the authenticated observe port, validates PNG and returns only untrusted pinned visible provenance',async()=>{
 const f=fixture(),read=createGameObservationReader(f.options),result=await read(f.join,new AbortController().signal);assert.ok(result);assert.equal(result.untrusted,true);assert.equal(result.facts[0]!.sourceScreenshotIds[0],f.shot.screenshotId);assert.equal(result.visibleState[0]!.manifestDigest,f.decoder.manifestDigest);assert.equal(result.providerConfigurationRef,f.decoder.configurationRef);assert.deepEqual(f.counts(),{observes:1,reads:1,decodes:1});assert.ok(f.owned()!.every(byte=>byte===0));
});
test('missing decoder and text-only vision capability refuse before any native observation or frame read',async()=>{
 for(const mode of ['missing','textOnly','noLoadedProjector','unknownKind','nonBooleanVision']){const f=fixture();if(mode==='missing')f.options.decoder=undefined;else f.decoder.capability={kind:mode==='unknownKind'?'unqualified':'gameVision',vision:mode==='nonBooleanVision'?'yes':mode==='textOnly'?false:true,loadedProjectorSha256:mode==='noLoadedProjector'?'':'a'.repeat(64)} as unknown as GameFrameDecoder['capability'];assert.equal(await createGameObservationReader(f.options)(f.join,new AbortController().signal),null);assert.deepEqual(f.counts(),{observes:0,reads:0,decodes:0});}
});
test('corrupt content, foreign observation scope and stale frame cannot reach the decoder',async()=>{
 for(const mode of ['digest','foreign','stale']){const f=fixture();if(mode==='digest')f.shot.sha256='b'.repeat(64);if(mode==='foreign')f.observation.scope={...f.observation.scope,runId:randomUUID()};if(mode==='stale')f.shot.expiresAt=new Date(0).toISOString();assert.equal(await createGameObservationReader(f.options)(f.join,new AbortController().signal),null);assert.equal(f.counts().decodes,0);assert.ok(!f.owned()||f.owned()!.every(byte=>byte===0));}
});
test('decoder outputs cannot invent screenshot provenance, manifest fields or timeline attribution',async()=>{
 for(const mode of ['screenshot','field','timeline']){const f=fixture();f.decoder.decode=async()=>{const result=f.decoded();if(mode==='screenshot')result.facts[0]!.sourceScreenshotIds=[randomUUID()];if(mode==='field')result.visibleState[0]!.fieldId='unreviewed:hidden-state';if(mode==='timeline')result.visibleState[0]!.timelineId=randomUUID();return result;};assert.equal(await createGameObservationReader(f.options)(f.join,new AbortController().signal),null);assert.ok(f.owned()!.every(byte=>byte===0));}
});
test('withdrawn source and decoder callback replacement discard interpretation and zero frame bytes',async()=>{
 const f=fixture();f.decoder.decode=async()=>{f.withdraw();return f.decoded();};assert.equal(await createGameObservationReader(f.options)(f.join,new AbortController().signal),null);assert.ok(f.owned()!.every(byte=>byte===0));
 const other=fixture(),read=createGameObservationReader(other.options);other.decoder.decode=async()=>other.decoded();assert.equal(await read(other.join,new AbortController().signal),null);assert.equal(other.counts().observes,0);
});
test('finite interpretation deadline also zeros owned frame bytes that arrive after cancellation',async()=>{
 const f=fixture();f.options.maximumDurationMs=10;let late:Buffer|undefined;f.options.readFrame=async()=>{await new Promise(resolve=>setTimeout(resolve,30));late=Buffer.from(f.bytes);return late;};assert.equal(await createGameObservationReader(f.options)(f.join,new AbortController().signal),null);await new Promise(resolve=>setTimeout(resolve,40));assert.ok(late);assert.ok(late.every(byte=>byte===0));
});
