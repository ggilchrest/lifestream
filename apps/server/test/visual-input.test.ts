import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {VisualAdmissionError} from '@lifestream/runtime/perception/admission';
import {fixtureVisualProvider} from '@lifestream/runtime/perception/fixture';
import {VisualInputHost} from '../src/runtime/visual-input.ts';

const actor = {principalId:'owner',sessionId:'session-a',assistantId:'assistant-a'};
const authority = {sourceConnected:true,devicePermission:true,hostCaptureLease:true,interpretationAllowed:true,remoteEgressAllowed:false,foregroundVisible:true};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X8ANywAAAABJRU5ErkJggg==','base64');

test('host without a selected visual provider reports unavailable and never enables capture', () => {
  const visual=new VisualInputHost({
    scopeFor:request=>({...request,relationshipId:null,environmentId:'test',conversationId:'conversation',endpointId:'endpoint',sessionRevision:1,audienceRevision:1,scopeGeneration:1}),
    sourceFor:()=>({bindingRef:'host-owned-camera',connected:true,configurationRevision:1}),
    captureAuthority:()=>authority
  });
  const capabilities=visual.capabilities(actor,['1.0.0']);
  assert.equal(capabilities.available,false);
  assert.equal(capabilities.reason,'unconfigured');
  assert.equal(capabilities.negotiation?.selectedVersion,null);
  assert.equal(capabilities.negotiation?.challenge,null);
  assert.equal(capabilities.camera.captureActive,false);
  assert.throws(()=>visual.camera(actor,{action:'enable',expectedRevision:0,idempotencyKey:'attempt',challengeId:'absent',endpointClockId:'clock',endpointReceivedMonotonicMs:0}),
    (error:unknown)=>error instanceof VisualAdmissionError&&error.reason==='unconfigured');
  assert.equal(visual.state(actor).captureActive,false);
});

test('host rederives source and scope, fences changed session, and admits exact binary parts', async () => {
  let mono=10_000, generation=1, connected=true, serial=0, invocations=0;
  const releases: string[]=[];
  const visual=new VisualInputHost({
    provider:fixtureVisualProvider(request=>{invocations++;return {requestId:request.requestId,status:'complete',observations:[{observationId:'fixture',frameIds:[request.frames[0]!.frameId],appearance:'A neutral pixel.',inference:null,confidence:null,limitations:['scripted fixture']}],reason:null};}),
    scopeFor:request=>request.principalId==='owner'&&request.assistantId==='assistant-a'?{...request,relationshipId:null,environmentId:'test',conversationId:'conversation',endpointId:'endpoint',sessionRevision:1,audienceRevision:generation,scopeGeneration:1}:null,
    sourceFor:()=>connected?{bindingRef:'host-owned-camera',connected:true,configurationRevision:2}:null,
    captureAuthority:()=>authority,
    releaseCapture:(_actor,_scope,_lease,reason)=>releases.push(reason),
    monotonicMs:()=>mono,utcMs:()=>Date.parse('2026-09-29T12:00:00Z')+mono,newId:()=>`id-${++serial}`
  });
  const negotiation=visual.capabilities(actor,['1.0.0']);
  assert.equal(negotiation.available,true);
  assert.equal(negotiation.camera.captureActive,false);
  mono+=20;
  const enable={action:'enable' as const,expectedRevision:0,idempotencyKey:'first',challengeId:negotiation.negotiation!.challenge!.id,endpointClockId:'clock',endpointReceivedMonotonicMs:5_000};
  const started=visual.camera(actor,enable);
  assert.equal(started.captureActive,true);
  assert.deepEqual(visual.camera(actor,enable),started,'duplicate command is idempotent');
  assert.throws(()=>visual.camera(actor,{...enable,expectedRevision:1}),(error:unknown)=>error instanceof VisualAdmissionError&&error.reason==='stale_revision');
  mono+=20;
  const meta={leaseId:started.leaseId!,endpointClockId:'clock',correlationId:'correlation',frames:[{frameId:'frame-a',sequence:0,capturedMonotonicMs:5_010,clockMappingId:started.clockMappingId!,mediaType:'image/png' as const,sha256:createHash('sha256').update(png).digest('hex')}]};
  await assert.rejects(()=>visual.batch(actor,meta,new Map([['extra',png]])),(error:unknown)=>error instanceof VisualAdmissionError&&error.reason==='frame_invalid');
  const receipt=await visual.batch(actor,meta,new Map([['frame-a',png]]));
  assert.equal(receipt.result.status,'complete');
  assert.equal(invocations,1);
  assert.equal(visual.state(actor).activeForSession,true);
  generation++;
  assert.equal(visual.state(actor).captureActive,false,'audience revision invalidates captured scope');
  assert.deepEqual(releases,['invalidated']);
  connected=false;
  assert.equal(visual.capabilities(actor,['1.0.0']).available,false);
  const stopped=visual.camera(actor,{action:'stop',expectedRevision:0,idempotencyKey:'stop',leaseId:started.leaseId!});
  assert.equal(stopped.captureActive,false,'current owner can stop despite the changed audience/source');
  assert.equal(visual.camera(actor,enable).captureActive,false,'replayed enable cannot report a retired lease as active');
  assert.deepEqual(releases,['invalidated'],'late stop does not release a successor');
});
