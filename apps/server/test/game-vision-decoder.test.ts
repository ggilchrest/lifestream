import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import {UnderstandingWorkCoordinator} from '@lifestream/runtime/understanding/coordinator';
import {gameCampaignFixture} from '../../../packages/runtime/test/fixtures/game-campaign.ts';
import {createGameVisionDecoder,parseGameVisionOutput,type GameVisionDecoderOptions} from '../src/runtime/game-vision-decoder.ts';
import type {OwnedGameVisionRequest} from '@lifestream/providers-sglang';
import type {ProviderCallContext,InferenceChunk} from '@lifestream/runtime/inference';

const output=JSON.stringify({kind:'map',scene:'A coast and small buildings.',text:[{candidate:'1000 G.D.',uncertainty:'Small pixels; letters may be wrong.'}],uncertainty:'One sample; model confidence is uncalibrated.'});
function png(){const chunk=(type:string,data:Buffer)=>{const head=Buffer.alloc(8),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);head.write(type,4);tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4),data])));return Buffer.concat([head,data,tail]);},header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0]))),chunk('IEND',Buffer.alloc(0))]);}
function fixture(){
 const f=gameCampaignFixture(),observation=structuredClone(f.input.observation),bytes=png(),shot=observation.screenshots[0]!;
 shot.sha256=createHash('sha256').update(bytes).digest('hex');shot.byteLength=bytes.length;shot.width=1;shot.height=1;
 let calls=0,current=true,admissions=0;const captured:Buffer[]=[];
 const coordinator=new UnderstandingWorkCoordinator({pressureAllowsWork:()=>true});
 const provider={async *generateGameFrame(request:OwnedGameVisionRequest,_context:ProviderCallContext):AsyncIterable<InferenceChunk>{calls++;captured.push(request.png as Buffer);yield {kind:'text',text:output};yield {kind:'done'};}};
 const options:GameVisionDecoderOptions={scope:observation.scope,pinsDigest:observation.pinsDigest,configurationRef:'fixture:game-vision',decoderRevision:'1.0.0',manifestDigest:'a'.repeat(64),loadedProjectorSha256:'b'.repeat(64),provider,runBackground:work=>coordinator.run(work),sourceCurrent:()=>current,runtimeCurrent:()=>current,admitOnce:()=>{admissions++;return true;},qualification:{preemptionBoundMs:10,slotReleaseBoundMs:250,reference:'fixture:vision-qualification',current:()=>current},maximumDurationMs:100,maximumObservationAgeMs:10000,maximumBytes:1024,maximumLongEdge:256,maximumOutputTokens:128};
 const input={purpose:'simulatedGame/gameFramebuffer' as const,observation,screenshot:shot,bytes};
 return {options,input,provider,coordinator,calls:()=>calls,admissions:()=>admissions,captured,withdraw:()=>{current=false;}};
}
test('closed output parser requires explicit uncertainty and rejects fences, extra keys, duplicate keys and trailing data',()=>{
 assert.ok(parseGameVisionOutput(output));
 for(const raw of ['```json\n'+output+'\n```',output+' trailing',output.replace('"kind":"map"','"kind":"map","kind":"menu"'),output.replace('"candidate":"1000 G.D."','"candidate":"1000 G.D.","candidate":"1000 A.D."'),output.replace('"kind":"map"','"kind":"map","visibleState":[]'),output.replace('One sample; model confidence is uncalibrated.','')])assert.equal(parseGameVisionOutput(raw),null);
});
test('owned game pixels use the existing coordinator and remain tentative source-bound inference with no visible fields',async()=>{
 const f=fixture(),decoder=createGameVisionDecoder(f.options),result=await decoder.decode(f.input,new AbortController().signal);
 assert.ok(result);assert.equal(f.calls(),1);assert.equal(f.admissions(),1);assert.deepEqual(result.visibleState,[]);assert.deepEqual(decoder.allowedVisibleFieldIds,[]);
 assert.ok(result.facts.every(fact=>fact.epistemicKind==='inference'&&fact.untrusted&&fact.sourceScreenshotIds[0]===f.input.screenshot.screenshotId));
 assert.ok(result.facts.some(fact=>fact.description.includes('1000 G.D.')&&fact.uncertainty.includes('wrong')));
 assert.ok(f.captured.every(bytes=>bytes.every(byte=>byte===0)));assert.ok(f.input.bytes.some(byte=>byte!==0));
});
test('missing, stale, foreign, mismatched and corrupt frames are rejected before admission or inference',async()=>{
 for(const mode of ['missing','stale','future','foreign','pins','shot','digest','dimensions','crc','purpose']){
  const f=fixture(),decoder=createGameVisionDecoder(f.options);
  if(mode==='missing')f.input.bytes=Buffer.alloc(0);if(mode==='stale')f.input.screenshot.expiresAt=new Date(0).toISOString();if(mode==='future')f.input.observation.capturedAt=f.input.screenshot.capturedAt=new Date(Date.now()+10000).toISOString();if(mode==='foreign')f.input.observation.scope={...f.input.observation.scope,runId:randomUUID()};if(mode==='pins')f.input.observation.pinsDigest='c'.repeat(64);if(mode==='shot')f.input.screenshot={...f.input.screenshot,screenshotId:randomUUID()};if(mode==='digest')f.input.screenshot.sha256='c'.repeat(64);if(mode==='dimensions')f.input.screenshot.width=2;if(mode==='crc'){f.input.bytes[50]^=1;f.input.screenshot.sha256=createHash('sha256').update(f.input.bytes).digest('hex');}if(mode==='purpose')(f.input as {purpose:string}).purpose='camera';
  assert.equal(await decoder.decode(f.input,new AbortController().signal),null,mode);assert.equal(f.calls(),0,mode);assert.equal(f.admissions(),0,mode);
 }
});
test('runtime/source withdrawal and changed provider/configuration discard output',async()=>{
 const f=fixture();f.provider.generateGameFrame=async function*(){f.withdraw();yield {kind:'text',text:output};yield {kind:'done'};};assert.equal(await createGameVisionDecoder(f.options).decode(f.input,new AbortController().signal),null);
 const other=fixture(),decoder=createGameVisionDecoder(other.options);other.options.loadedProjectorSha256='d'.repeat(64);assert.equal(await decoder.decode(other.input,new AbortController().signal),null);assert.equal(other.calls(),0);
});
test('foreground preemption cancels the vision path through the same coordinator and publishes nothing',async()=>{
 const f=fixture();let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 f.provider.generateGameFrame=async function*(_request,context){entered();await new Promise<void>(resolve=>{if(context.signal.aborted)resolve();else context.signal.addEventListener('abort',()=>resolve(),{once:true});});yield {kind:'text',text:output};yield {kind:'done'};};
 const pending=createGameVisionDecoder(f.options).decode(f.input,new AbortController().signal);await started;
 const release=f.coordinator.foregroundStarted();assert.equal(await pending,null);assert.equal(f.coordinator.isIdle(),false);release();assert.equal(f.coordinator.isIdle(),true);
});
test('uncooperative provider keeps the existing coordinator busy until it actually settles',async()=>{
 const f=fixture();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 f.provider.generateGameFrame=async function*(){entered();await held;yield {kind:'text',text:output};yield {kind:'done'};};
 const controller=new AbortController(),pending=createGameVisionDecoder(f.options).decode(f.input,controller.signal);await started;controller.abort();assert.equal(f.coordinator.isIdle(),false);release();assert.equal(await pending,null);assert.equal(f.coordinator.isIdle(),true);
});
test('duplicate or unavailable admission cannot invoke the provider, and native release limits cannot be relaxed',async()=>{
 const f=fixture();f.options.admitOnce=()=>false;assert.equal(await createGameVisionDecoder(f.options).decode(f.input,new AbortController().signal),null);assert.equal(f.calls(),0);
 const other=fixture();other.options.qualification.slotReleaseBoundMs=251;assert.throws(()=>createGameVisionDecoder(other.options));
});
