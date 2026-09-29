import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {crc32} from 'node:zlib';
import {VisualAdmission, VisualAdmissionError, type CaptureAuthority} from '../src/perception/admission.ts';
import {fixtureVisualProvider} from '../src/perception/fixture.ts';
import {VisualObservationStore} from '../src/perception/observation.ts';
import type {VisualFrame, VisualPerceptionProvider, VisualPerceptionRequest, VisualPerceptionResult, VisualScope} from '../src/perception/port.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+5gz/qwAAAABJRU5ErkJggg==', 'base64');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const scope = (sessionId = 'session-a'): VisualScope => ({assistantId:'assistant',principalId:'owner',relationshipId:null,environmentId:'local',conversationId:'conversation',sessionId,endpointId:'endpoint',sessionRevision:1,audienceRevision:1,scopeGeneration:1,sourceBindingRef:'camera:neutral-fixture',captureConfigurationRevision:1});
const authority: CaptureAuthority = {sourceConnected:true,devicePermission:true,hostCaptureLease:true,interpretationAllowed:true,remoteEgressAllowed:false,foregroundVisible:true};
const provider = fixtureVisualProvider(request => ({requestId:request.requestId,status:'complete',observations:[{observationId:'observation',frameIds:[request.frames[0]!.frameId],appearance:'A neutral square is visible.',inference:null,confidence:null,limitations:['fixture description, not image interpretation']}],reason:null}));

function harness(visualProvider: VisualPerceptionProvider | null = provider, currentScope: (value: VisualScope) => boolean = () => true, bounds = {}) {
  let mono = 10_000, serial = 0;
  const visual = new VisualAdmission({...(visualProvider ? {provider:visualProvider} : {}),bounds,monotonicMs:()=>mono,utcMs:()=>Date.parse('2026-09-29T12:00:00Z')+mono,newId:()=>`id-${++serial}`,currentScope});
  const advance = (ms: number) => { mono += ms; };
  const begin = (target = scope()) => {
    const negotiated = visual.negotiate(target,['1.0.0'],true);
    assert.equal(negotiated.selectedVersion,'1.0.0');
    advance(20);
    const state = visual.enable(target,{expectedRevision:visual.cameraState(target.sessionId).revision,challengeId:negotiated.challenge!.id,endpointClockId:'endpoint-clock',endpointReceivedMonotonicMs:5_000},authority);
    return {target,leaseId:state.leaseId!,mappingId:state.clockMappingId!};
  };
  const frame = (mappingId: string, sequence: number, capturedMonotonicMs = 5_010, bytes: Uint8Array = png): VisualFrame => ({frameId:`frame-${sequence}`,sequence,capturedMonotonicMs,clockMappingId:mappingId,mediaType:'image/png',sha256:digest(bytes),bytes});
  return {visual,advance,begin,frame};
}

test('explicit camera lease does not infer sight from hardware, provider presence, or a prior session', () => {
  const h = harness(null), target = scope();
  assert.equal(h.visual.cameraState(target.sessionId).captureActive,false);
  const noVersion = h.visual.negotiate(target,['2.0.0'],true);
  assert.equal(noVersion.selectedVersion,null);
  assert.equal(noVersion.challenge,null);
  const negotiated = h.visual.negotiate(target,['1.0.0'],true);
  assert.equal(negotiated.configured,false);
  assert.equal(negotiated.providerConnected,false);
  assert.equal(negotiated.selectedVersion,null);
  assert.equal(negotiated.challenge,null);
  h.advance(20);
  assert.throws(() => h.visual.enable(target,{expectedRevision:0,challengeId:'absent',endpointClockId:'clock',endpointReceivedMonotonicMs:5_000},{...authority,devicePermission:false}), (error: unknown) => error instanceof VisualAdmissionError && error.reason === 'permission_denied');
  assert.throws(() => h.visual.enable(target,{expectedRevision:0,challengeId:'absent',endpointClockId:'clock',endpointReceivedMonotonicMs:5_000},authority),(error: unknown)=>error instanceof VisualAdmissionError&&error.reason==='unconfigured');
  assert.equal(h.visual.cameraState(target.sessionId).captureActive,false);
  assert.equal(h.visual.cameraState('new-session').captureActive,false);
  const active = harness();
  const enabledScope = active.begin();
  const enabled = active.visual.cameraState(enabledScope.target.sessionId);
  assert.equal(enabled.captureActive,true);
  assert.equal(enabled.activeForSession,false);
  assert.equal(enabled.reason,'frame_stale');
  assert.equal(active.visual.stop(target.sessionId,'old-lease',target.principalId).captureActive,true);
  assert.equal(active.visual.stop(target.sessionId,enabled.leaseId!,target.principalId).captureActive,false);
  assert.equal(active.visual.stop(target.sessionId,enabled.leaseId!,target.principalId).captureActive,false);
});

test('clock challenge is one use, maps full round trip, expires, and rejects uncertainty', () => {
  const h = harness(), first = h.begin();
  assert.equal(h.visual.cameraState(first.target.sessionId).captureActive,true);
  h.visual.stop(first.target.sessionId,first.leaseId,first.target.principalId);
  assert.throws(() => h.visual.enable(first.target,{expectedRevision:h.visual.cameraState(first.target.sessionId).revision,challengeId:'replayed',endpointClockId:'endpoint-clock',endpointReceivedMonotonicMs:5_000},authority),(error: unknown)=>error instanceof VisualAdmissionError&&error.reason==='clock_challenge_invalid');
  const second = h.visual.negotiate(first.target,['1.0.0'],true);
  h.advance(251);
  assert.throws(() => h.visual.enable(first.target,{expectedRevision:h.visual.cameraState(first.target.sessionId).revision,challengeId:second.challenge!.id,endpointClockId:'endpoint-clock',endpointReceivedMonotonicMs:5_000},authority),(error: unknown)=>error instanceof VisualAdmissionError&&error.reason==='clock_uncertain');
  const third = h.visual.negotiate(first.target,['1.0.0'],true);
  h.advance(5_001);
  assert.throws(() => h.visual.enable(first.target,{expectedRevision:h.visual.cameraState(first.target.sessionId).revision,challengeId:third.challenge!.id,endpointClockId:'endpoint-clock',endpointReceivedMonotonicMs:5_000},authority),(error: unknown)=>error instanceof VisualAdmissionError&&error.reason==='clock_challenge_invalid');
});

test('renewal clears prior sight and cancels old running and pending clock epochs', async () => {
  let calls=0, finish!:()=>void, aborted=false;
  const slow:VisualPerceptionProvider={...provider,interpret:async(request,signal)=>{
    calls++;
    if(calls===2){
      signal.addEventListener('abort',()=>{aborted=true;},{once:true});
      await new Promise<void>(resolve=>{finish=resolve;});
    }
    return provider.interpret(request,signal);
  }};
  const h=harness(slow), active=h.begin(); h.advance(20);
  const original=h.visual.submit(active.target,active.leaseId,'endpoint-clock',[h.frame(active.mappingId,0)],'original');
  assert.equal((await original.completion).status,'complete');
  assert.equal(h.visual.cameraState(active.target.sessionId).currentObservationUsable,true);
  h.advance(1_000);
  const running=h.visual.submit(active.target,active.leaseId,'endpoint-clock',[h.frame(active.mappingId,1,6_010)],'running');
  await Promise.resolve(); h.advance(1_000);
  const pending=h.visual.submit(active.target,active.leaseId,'endpoint-clock',[h.frame(active.mappingId,2,7_010)],'pending');
  const negotiated=h.visual.negotiate(active.target,['1.0.0'],true); h.advance(20);
  const renewed=h.visual.renew(active.target,active.leaseId,{expectedRevision:h.visual.cameraState(active.target.sessionId).revision,challengeId:negotiated.challenge!.id,endpointClockId:'endpoint-clock',endpointReceivedMonotonicMs:7_060},authority);
  assert.equal(renewed.captureActive,true);
  assert.equal(renewed.currentObservationUsable,false);
  assert.notEqual(renewed.clockMappingId,active.mappingId);
  assert.equal(renewed.leaseId,active.leaseId);
  assert.equal(h.visual.provenanceCurrent(original.provenance),false);
  assert.equal(h.visual.provenanceCurrent(running.provenance),false);
  assert.equal((await pending.completion).reason,'cancelled');
  assert.equal((await running.completion).reason,'cancelled');
  assert.equal(aborted,true);
  finish(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,2,'renewal cannot dispatch the old pending epoch');
  assert.equal(h.visual.cameraState(active.target.sessionId).currentObservationUsable,false,'late old provider success cannot restore sight');
  assert.equal(h.visual.resourceUsage().rawBytes,0);
  assert.throws(()=>h.visual.submit(active.target,active.leaseId,'endpoint-clock',[h.frame(renewed.clockMappingId!,3,7_060)],'too-fast'),(error:unknown)=>error instanceof VisualAdmissionError&&error.reason==='rate_limited');
  h.advance(1_000);
  assert.throws(()=>h.visual.submit(active.target,active.leaseId,'endpoint-clock',[h.frame(active.mappingId,3,8_010)],'old-mapping'),(error:unknown)=>error instanceof VisualAdmissionError&&error.reason==='frame_invalid');
  assert.throws(()=>h.visual.submit(active.target,active.leaseId,'endpoint-clock',[h.frame(renewed.clockMappingId!,0,8_010)],'old-sequence'),(error:unknown)=>error instanceof VisualAdmissionError&&error.reason==='frame_invalid');
  const current=h.visual.submit(active.target,active.leaseId,'endpoint-clock',[h.frame(renewed.clockMappingId!,3,8_010)],'new-epoch');
  assert.equal((await current.completion).status,'complete');
  assert.equal(current.provenance.leaseRevision,renewed.revision);
  assert.equal(h.visual.provenanceCurrent(current.provenance),true);
  assert.equal(h.visual.cameraState(active.target.sessionId).currentObservationUsable,true);
  h.visual.close();
});

test('admission provenance is authentic immutable metadata without bytes or provider object aliases', async () => {
  let request:VisualPerceptionRequest|undefined;
  const configured:VisualPerceptionProvider={...provider,id:'configured-visual',version:'one',interpret:value=>{request=value;return provider.interpret(value,new AbortController().signal);}};
  const h=harness(configured), active=h.begin(); h.advance(20);
  Reflect.set(configured,'id','provider-mutated-id'); Reflect.set(configured,'version','provider-mutated-version');
  const frame=h.frame(active.mappingId,0);
  const first=h.visual.submit(active.target,active.leaseId,'endpoint-clock',[frame],'first-correlation');
  Reflect.set(frame,'frameId','caller-mutated-frame');
  assert.equal((await first.completion).status,'complete');
  const p=first.provenance;
  assert.equal(p.requestId,first.requestId); assert.equal(p.correlationId,'first-correlation');
  assert.equal(p.leaseId,active.leaseId); assert.equal(p.clockMappingId,active.mappingId);
  assert.deepEqual(p.provider,{id:'configured-visual',version:'one'});
  assert.deepEqual(p.frameIds,['frame-0']);
  assert.equal(p.hostSequence,1);
  assert.notEqual(p.scope,active.target); assert.notEqual(p.scope,request!.scope);
  assert.equal(p.capturedAtEarliestMs,request!.capturedAtEarliestMs);
  assert.equal(p.capturedAtLatestMs,request!.capturedAtLatestMs);
  assert.ok(p.capturedAtEarliestMs<=p.capturedAtLatestMs&&p.capturedAtLatestMs<=p.receivedAtMs);
  assert.equal(p.deadlineAtMs-p.receivedAtMs,h.visual.bounds.deadlineMs);
  assert.ok(Object.isFrozen(p)&&Object.isFrozen(p.scope)&&Object.isFrozen(p.frameIds)&&Object.isFrozen(p.provider));
  assert.doesNotMatch(JSON.stringify(p),/"bytes"|"frames"/);
  assert.equal(h.visual.provenanceCurrent(p),true);
  assert.equal(h.visual.provenanceCurrent(structuredClone(p)),false,'copied or fabricated metadata has no host authority');
  assert.equal(h.visual.provenanceCurrent(new Proxy(p,{})),false,'a provider proxy cannot manufacture provenance identity');
  h.advance(1_000);
  const second=h.visual.submit(active.target,active.leaseId,'endpoint-clock',[h.frame(active.mappingId,1,6_010)],'second-correlation');
  assert.equal(second.provenance.hostSequence,2); await second.completion;
  h.visual.stop(active.target.sessionId,active.leaseId,active.target.principalId);
  assert.equal(h.visual.provenanceCurrent(p),false);
  assert.equal(h.visual.provenanceCurrent(second.provenance),false);
  h.visual.close();
});

test('fractional monotonic capture uses a conservative UTC lower bound compatible with integer receipts', async () => {
  const base=1_760_000_000_000,target=scope();let mono=10_000.1;
  const utc=()=>base+Math.floor(mono),visual=new VisualAdmission({provider,monotonicMs:()=>mono,utcMs:utc,bounds:{freshnessMs:250}});
  const store=new VisualObservationStore({now:utc,freshnessMs:250,current:()=>true});
  try{
    const offer=visual.negotiate(target,['1.0.0'],true);mono=10_000.2;
    const lease=visual.enable(target,{expectedRevision:0,challengeId:offer.challenge!.id,endpointClockId:'fractional-clock',endpointReceivedMonotonicMs:5_000.2},authority);
    mono=10_000.7;
    const frame:VisualFrame={frameId:'fractional-frame',sequence:0,capturedMonotonicMs:5_000.6,clockMappingId:lease.clockMappingId!,mediaType:'image/png',sha256:digest(png),bytes:png};
    const admitted=visual.submit(target,lease.leaseId!,'fractional-clock',[frame],'fractional-time'),result=await admitted.completion,p=admitted.provenance;
    const fractionalLower=base+10_000+(5_000.6-5_000.2)*(1-0.0001);
    assert.equal(result.status,'complete');assert.ok(fractionalLower>p.receivedAtMs,'the unrounded projection would be rejected as newer than its integer receipt');
    assert.equal(p.capturedAtEarliestMs,Math.floor(fractionalLower));
    assert.ok(p.capturedAtEarliestMs<=p.receivedAtMs&&p.receivedAtMs<=utc());
    assert.equal(store.publish({scope:p.scope,leaseId:p.leaseId,sequence:p.hostSequence,requestId:p.requestId,provider:p.provider,capturedAtEarliestMs:p.capturedAtEarliestMs,capturedAtLatestMs:p.capturedAtLatestMs,receivedAtMs:p.receivedAtMs,interpretedAtMs:utc(),observations:result.observations}),true);
    const view=store.prepare({scope:p.scope,leaseId:p.leaseId,viewId:'fractional-view',revision:1,invalidationKey:'fractional-epoch',conversation:'[]',explicitQuestion:true,allowAside:false});
    assert.ok(view);assert.ok(view.expiresAtMs<=fractionalLower+250,'rounding never extends current-context freshness');
    mono=10_250;assert.equal(store.isCurrent(view),false);
  }finally{visual.close();store.clear();}
});

test('bounded media admission uses bytes, digest, dimensions, sequence, and conservative capture time', async () => {
  const h = harness(), {target,leaseId,mappingId} = h.begin();
  h.advance(20);
  const candidate = h.frame(mappingId,0);
  assert.throws(() => h.visual.submit(target,leaseId,'endpoint-clock',[{...candidate,sha256:'bad'}],'correlation'),(error: unknown)=>error instanceof VisualAdmissionError&&error.reason==='frame_invalid');
  assert.throws(() => h.visual.submit(target,leaseId,'endpoint-clock',[{...candidate,bytes:new Uint8Array(20)}],'correlation'),(error: unknown)=>error instanceof VisualAdmissionError&&error.reason==='frame_invalid');
  const admitted = h.visual.submit(target,leaseId,'endpoint-clock',[candidate],'correlation');
  const result = await admitted.completion;
  assert.equal(result.status,'complete');
  assert.equal(h.visual.cameraState(target.sessionId).activeForSession,true);
  assert.equal(candidate.bytes[0],137,'caller-owned bytes are not disposed');
  assert.throws(() => h.visual.submit(target,leaseId,'endpoint-clock',[candidate],'correlation'),(error: unknown)=>error instanceof VisualAdmissionError&&error.reason==='rate_limited');
  h.advance(1_000);
  assert.throws(() => h.visual.submit(target,leaseId,'endpoint-clock',[candidate],'correlation'),(error: unknown)=>error instanceof VisualAdmissionError&&error.reason==='frame_invalid');
  const next = h.frame(mappingId,1,6_010);
  assert.equal((await h.visual.submit(target,leaseId,'endpoint-clock',[next],'correlation').completion).status,'complete');
  h.advance(7_001);
  assert.equal(h.visual.cameraState(target.sessionId).activeForSession,false);
  assert.throws(() => h.visual.submit(target,leaseId,'endpoint-clock',[h.frame(mappingId,2,7_010)],'correlation'),(error: unknown)=>error instanceof VisualAdmissionError&&error.reason==='frame_stale');
});

test('latest pending input replaces obsolete work, stop cancels the original lease and clears buffers', async () => {
  const pending: Array<(result: VisualPerceptionResult)=>void> = [];
  const held: Uint8Array[] = [];
  const slow: VisualPerceptionProvider = {...provider,interpret:request=>new Promise(resolve=>{held.push(request.frames[0]!.bytes);pending.push(resolve);})};
  const h = harness(slow), {target,leaseId,mappingId} = h.begin();
  h.advance(20);
  const first = h.visual.submit(target,leaseId,'endpoint-clock',[h.frame(mappingId,0)],'one');
  await Promise.resolve();
  h.advance(1_000);
  const second = h.visual.submit(target,leaseId,'endpoint-clock',[h.frame(mappingId,1,6_010)],'two');
  assert.equal(second.queued,true);
  h.advance(1_000);
  const third = h.visual.submit(target,leaseId,'endpoint-clock',[h.frame(mappingId,2,7_010)],'three');
  assert.equal((await second.completion).reason,'replaced');
  pending[0]!({requestId:first.requestId,status:'empty',observations:[],reason:null});
  assert.equal((await first.completion).status,'empty');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(held[0]![0],0,'finished media buffer was disposed');
  h.visual.stop(target.sessionId,leaseId,target.principalId);
  assert.equal((await third.completion).reason,'cancelled');
  assert.equal(held[1]?.[0] ?? 0,0,'pending media buffer was disposed');
});

test('deadline and invalid provider output cannot become current observations', async () => {
  const never: VisualPerceptionProvider = {...provider,interpret:()=>new Promise(()=>{})};
  const h = harness(never,()=>true,{deadlineMs:20}), {target,leaseId,mappingId} = h.begin();
  h.advance(20);
  const result = await h.visual.submit(target,leaseId,'endpoint-clock',[h.frame(mappingId,0)],'timeout').completion;
  assert.equal(result.status,'timedOut');
  assert.equal(h.visual.cameraState(target.sessionId).activeForSession,false);
  h.advance(1_000);
  const later=h.visual.submit(target,leaseId,'endpoint-clock',[h.frame(mappingId,1,6_010)],'later');
  assert.equal(later.queued,true,'the timed-out provider still owns the model slot while retiring');
  assert.equal((await later.completion).reason,'provider_unavailable');
  const invalid = fixtureVisualProvider(request=>({requestId:request.requestId,status:'complete',observations:[{observationId:'bad',frameIds:['unknown-frame'],appearance:'fabricated',inference:null,confidence:null,limitations:[]}],reason:null}));
  const next = harness(invalid), enabled=next.begin(); next.advance(20);
  const rejected = await next.visual.submit(enabled.target,enabled.leaseId,'endpoint-clock',[next.frame(enabled.mappingId,0)],'bad').completion;
  assert.equal(rejected.reason,'provider_invalid');
  assert.equal(next.visual.cameraState(enabled.target.sessionId).activeForSession,false);
});

test('provider cannot replace admitted request and frame identities with invented evidence', async () => {
  for(const attackFrame of [false,true]){
    const corrupt:VisualPerceptionProvider={...provider,interpret:async request=>{
      if(attackFrame) Reflect.set(request.frames[0]!,'frameId','invented-frame');
      else Reflect.set(request,'requestId','invented-request');
      return {requestId:attackFrame?request.requestId:'invented-request',status:'complete',observations:[{observationId:'invented',frameIds:[attackFrame?'invented-frame':request.frames[0]!.frameId],appearance:'Invented evidence.',inference:null,confidence:null,limitations:[]}],reason:null};
    }};
    const h=harness(corrupt), active=h.begin(); h.advance(20);
    const admitted=h.visual.submit(active.target,active.leaseId,'endpoint-clock',[h.frame(active.mappingId,0)],'identity');
    const result=await admitted.completion;
    assert.equal(result.requestId,admitted.requestId);
    assert.equal(result.reason,'provider_invalid');
    assert.equal(h.visual.cameraState(active.target.sessionId).currentObservationUsable,false);
    assert.equal(h.visual.resourceUsage().rawBytes,0);
    h.visual.close();
  }
});

test('provider metadata is frozen independently from caller scope and disposable frame bytes', async () => {
  const attempts:boolean[]=[];
  let held:Uint8Array|undefined;
  const guarded:VisualPerceptionProvider={...provider,interpret:async request=>{
    held=request.frames[0]!.bytes;
    attempts.push(Reflect.set(request,'leaseId','another-lease'),Reflect.set(request.scope,'audienceRevision',2),Reflect.set(request.scope,'assistantId','another-assistant'),Reflect.set(request.frames[0]!,'clockMappingId','another-clock'),Reflect.set(request.frames,0,{...request.frames[0],frameId:'invented-frame'}));
    assert.ok(Object.isFrozen(request)&&Object.isFrozen(request.scope)&&Object.isFrozen(request.frames)&&Object.isFrozen(request.frames[0]));
    return provider.interpret(request,new AbortController().signal);
  }};
  const h=harness(guarded,value=>value.audienceRevision===1), active=h.begin(); h.advance(20);
  const input=h.frame(active.mappingId,0);
  const admitted=h.visual.submit(active.target,active.leaseId,'endpoint-clock',[input],'scope');
  Reflect.set(active.target,'audienceRevision',9);
  const result=await admitted.completion;
  assert.equal(result.status,'complete');
  assert.deepEqual(attempts,[false,false,false,false,false]);
  assert.equal(held?.[0],0,'the original owned bytes are still wiped after use');
  assert.equal(input.bytes[0],137,'there is no additional provider byte copy to escape disposal');
  assert.equal(h.visual.resourceUsage().rawBytes,0);
  h.visual.close();
});

test('accepted provider evidence is a frozen snapshot unaffected by later provider mutation', async () => {
  const mutable={requestId:'',status:'complete' as const,observations:[{observationId:'observation',frameIds:['frame-0'],appearance:'Original evidence.',inference:null,confidence:null,limitations:['original limit']}],reason:null};
  const h=harness({...provider,interpret:async request=>{mutable.requestId=request.requestId;return mutable;}}), active=h.begin(); h.advance(20);
  const result=await h.visual.submit(active.target,active.leaseId,'endpoint-clock',[h.frame(active.mappingId,0)],'snapshot').completion;
  mutable.requestId='changed'; mutable.observations[0]!.appearance='Changed after acceptance.';
  mutable.observations[0]!.frameIds.push('invented-frame'); mutable.observations[0]!.limitations[0]='changed limit'; mutable.observations.push({...mutable.observations[0]!});
  assert.notEqual(result.requestId,'changed');
  assert.equal(result.observations.length,1);
  assert.equal(result.observations[0]?.appearance,'Original evidence.');
  assert.deepEqual(result.observations[0]?.frameIds,['frame-0']);
  assert.deepEqual(result.observations[0]?.limitations,['original limit']);
  assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.observations)&&Object.isFrozen(result.observations[0])&&Object.isFrozen(result.observations[0]?.frameIds)&&Object.isFrozen(result.observations[0]?.limitations));
  h.visual.close();
});

test('detached provider buffers reject evidence, settle, release the slot and wipe other buffers', async () => {
  let calls=0, lengthGetterCalls=0, detached:Uint8Array|undefined, remaining:Uint8Array|undefined;
  const transfers:VisualPerceptionProvider={...provider,interpret:async request=>{
    calls++;
    if(calls===1){
      detached=request.frames[0]!.bytes;
      remaining=request.frames[1]!.bytes;
      const backing=detached.buffer as ArrayBuffer & {transfer?:()=>ArrayBuffer};
      // Modern ArrayBuffer.transfer and structured-clone transfer both detach
      // the host view; neither may strand result settlement or other cleanup.
      if(backing.transfer) backing.transfer();
      else structuredClone(backing,{transfer:[backing]});
      Object.defineProperty(detached,'byteLength',{get(){lengthGetterCalls++;return png.byteLength;}});
    }
    return provider.interpret(request,new AbortController().signal);
  }};
  const h=harness(transfers), active=h.begin(); h.advance(400);
  const first=h.visual.submit(active.target,active.leaseId,'endpoint-clock',[h.frame(active.mappingId,0),h.frame(active.mappingId,1,5_344)],'detached');
  const result=await first.completion;
  assert.equal(result.reason,'provider_invalid');
  assert.equal(detached?.buffer.byteLength,0);
  assert.equal(lengthGetterCalls,0,'provider accessors cannot conceal detached native storage');
  assert.equal(remaining?.[0],0,'one failed wipe cannot skip remaining owned buffers');
  assert.equal(h.visual.cameraState(active.target.sessionId).currentObservationUsable,false);
  assert.equal(h.visual.resourceUsage().rawBytes,0);
  h.advance(1_000);
  const successor=h.visual.submit(active.target,active.leaseId,'endpoint-clock',[h.frame(active.mappingId,2,6_344)],'successor');
  assert.equal(successor.queued,false,'a completed invalid provider result releases the slot');
  assert.equal((await successor.completion).status,'complete');
  assert.equal(calls,2);
  h.visual.close();
});

test('provider accessors, proxies, sparse arrays and oversized metadata fail closed without evaluating code', async () => {
  let evaluated=0;
  const variants:Array<(requestId:string)=>unknown>=[
    requestId=>({get requestId(){evaluated++;throw new Error('accessor must not execute');},status:'empty',observations:[],reason:requestId}),
    requestId=>new Proxy({requestId,status:'empty',observations:[],reason:null},{get(_target,key){if(key==='then')return undefined; evaluated++;throw new Error('proxy evidence must not execute');}}),
    requestId=>({requestId,status:'complete',observations:[{observationId:'observation',frameIds:['frame-0'],get appearance(){evaluated++;return 'getter';},inference:null,confidence:null,limitations:[]}],reason:null}),
    requestId=>({requestId,status:'complete',observations:new Array(1),reason:null}),
    requestId=>({requestId,status:'empty',observations:[],reason:'x'.repeat(8_193)}),
    requestId=>({requestId,status:'complete',observations:[{observationId:'observation',frameIds:['frame-0'],appearance:'plain',inference:null,confidence:null,limitations:new Proxy([],{get(){evaluated++;throw new Error('proxy must not execute');}})}],reason:null})
  ];
  for(const make of variants){
    const h=harness({...provider,interpret:async request=>make(request.requestId) as VisualPerceptionResult}), active=h.begin(); h.advance(20);
    const result=await h.visual.submit(active.target,active.leaseId,'endpoint-clock',[h.frame(active.mappingId,0)],'untrusted').completion;
    assert.equal(result.reason,'provider_invalid');
    assert.equal(h.visual.cameraState(active.target.sessionId).currentObservationUsable,false);
    assert.equal(h.visual.resourceUsage().rawBytes,0);
    h.visual.close();
  }
  assert.equal(evaluated,0);
});

test('provider reason matches the wire and browser 128-character limit before becoming usable', async () => {
  for(const length of [128,129,1024]){
    const h=harness({...provider,interpret:async(request,signal)=>({...await provider.interpret(request,signal),reason:'x'.repeat(length)})}), active=h.begin(); h.advance(20);
    const result=await h.visual.submit(active.target,active.leaseId,'endpoint-clock',[h.frame(active.mappingId,0)],'bounded-reason').completion;
    assert.equal(result.status,length===128?'complete':'rejected');
    assert.equal(result.reason,length===128?'x'.repeat(length):'provider_invalid');
    assert.equal(h.visual.cameraState(active.target.sessionId).currentObservationUsable,length===128);
    h.visual.close();
  }
});

test('old peer and scope invalidation leave the existing text/audio contract untouched', () => {
  const h = harness(provider,value=>value.audienceRevision === 1), original = h.begin();
  const changed = {...original.target,audienceRevision:2};
  assert.throws(()=>h.visual.submit(changed,original.leaseId,'endpoint-clock',[h.frame(original.mappingId,0)],'stale'),(error: unknown)=>error instanceof VisualAdmissionError&&error.reason==='scope_changed');
  assert.equal(h.visual.stop(original.target.sessionId,original.leaseId,original.target.principalId).captureActive,false);
  assert.equal(h.visual.negotiate(changed,['0.9.0'],true).profile,null);
});

test('expired leases release capture and inactive negotiation state stays bounded', () => {
  let now=10_000, releases=0;
  const visual=new VisualAdmission({provider,monotonicMs:()=>now,utcMs:()=>Date.parse('2026-09-29T12:00:00Z')+now,onLeaseEnded:()=>{releases++;}});
  for(let index=0;index<100;index++) visual.negotiate(scope(`unused-${index}`),['1.0.0'],true);
  assert.ok((visual as unknown as {sessions:Map<string,unknown>}).sessions.size<=64);
  const target=scope('live');
  const negotiation=visual.negotiate(target,['1.0.0'],true);
  now+=20;
  assert.equal(visual.enable(target,{expectedRevision:0,challengeId:negotiation.challenge!.id,endpointClockId:'clock',endpointReceivedMonotonicMs:5_000},authority).captureActive,true);
  now+=60_001;
  assert.equal(visual.cameraState(target.sessionId).captureActive,false);
  assert.equal(releases,1);
  assert.equal(visual.cameraState(target.sessionId).revision,2);
  assert.equal(releases,1,'expiry release is idempotent');
});

test('pending work is disposed before a changed scope can invoke the provider', async () => {
  let audience=1, invocations=0;
  let finish!: (result: VisualPerceptionResult)=>void;
  const slow:VisualPerceptionProvider={...provider,interpret:request=>{invocations++;return new Promise(resolve=>{finish=resolve;});}};
  const h=harness(slow,value=>value.audienceRevision===audience), enabled=h.begin();
  h.advance(20);
  const first=h.visual.submit(enabled.target,enabled.leaseId,'endpoint-clock',[h.frame(enabled.mappingId,0)],'first');
  await Promise.resolve();
  h.advance(1_000);
  const second=h.visual.submit(enabled.target,enabled.leaseId,'endpoint-clock',[h.frame(enabled.mappingId,1,6_010)],'second');
  audience=2;
  finish({requestId:first.requestId,status:'empty',observations:[],reason:null});
  assert.equal((await first.completion).reason,'scope_changed');
  assert.equal((await second.completion).reason,'scope_changed');
  assert.equal(invocations,1);
  assert.equal(h.visual.cameraState(enabled.target.sessionId).captureActive,false);
});

test('stop and invalidation hold the single model slot until a non-settling provider is quarantined', async () => {
  for (const ending of ['stop','invalidate'] as const) {
    let invocations=0;
    const ignoresAbort:VisualPerceptionProvider={...provider,interpret:()=>{invocations++;return new Promise(()=>{});}};
    const h=harness(ignoresAbort,()=>true,{deadlineMs:100});
    const first=h.begin(scope(`first-${ending}`));
    h.advance(20);
    const running=h.visual.submit(first.target,first.leaseId,'endpoint-clock',[h.frame(first.mappingId,0)],'running');
    await Promise.resolve();
    assert.equal(invocations,1);
    if (ending==='stop') h.visual.stop(first.target.sessionId,first.leaseId,first.target.principalId);
    else h.visual.invalidate(first.target.sessionId);
    assert.equal((await running.completion).status,'cancelled');
    const successor=h.begin(scope(`successor-${ending}`));
    h.advance(20);
    const queued=h.visual.submit(successor.target,successor.leaseId,'endpoint-clock',[h.frame(successor.mappingId,0)],'successor');
    assert.equal(queued.queued,true,'the aborted provider still owns the one model slot');
    const another=h.begin(scope(`another-${ending}`));
    h.advance(20);
    const secondQueued=h.visual.submit(another.target,another.leaseId,'endpoint-clock',[h.frame(another.mappingId,0)],'another');
    assert.equal(secondQueued.queued,true);
    assert.equal(invocations,1,'a second visual model call cannot start behind an unsettled provider');
    assert.equal((await queued.completion).reason,'provider_unavailable');
    assert.equal((await secondQueued.completion).reason,'provider_unavailable','all sessions drain after provider quarantine');
    assert.equal(invocations,1,'the adapter is unavailable after the bounded retirement grace');
  }
});

test('effective resource limits tighten sampling and count ingress plus replacement copy peaks', async () => {
  assert.throws(()=>new VisualAdmission({bounds:{minAdmissionIntervalMs:999}}),/invalid visual bound/);
  assert.equal(new VisualAdmission({bounds:{minAdmissionIntervalMs:2_000}}).bounds.minAdmissionIntervalMs,2_000);
  assert.throws(()=>new VisualAdmission({bounds:{maxFrameBytes:2_097_152}}),/invalid visual bound/);
  let finish!:(result:VisualPerceptionResult)=>void;
  const slow:VisualPerceptionProvider={...provider,interpret:()=>new Promise(resolve=>{finish=resolve;})};
  const h=harness(slow), active=h.begin(), padding=Buffer.alloc(1_048_576-png.length);
  padding.writeUInt32BE(padding.length-12,0);padding.write('tEXt',4);padding.writeUInt32BE(crc32(padding.subarray(4,padding.length-4)),padding.length-4);
  const body=Buffer.concat([png.subarray(0,png.length-12),padding,png.subarray(png.length-12)]);
  const envelope=1_048_576+3*body.length+32_768;
  const submit=(batch:number)=>{
    h.advance(1_002);
    const release=h.visual.reserveIngress(active.target.sessionId,envelope);
    assert.throws(()=>h.visual.reserveIngress(active.target.sessionId,envelope),VisualAdmissionError);
    const result=h.visual.submit(active.target,active.leaseId,'endpoint-clock',Array.from({length:3},(_,index)=>h.frame(active.mappingId,batch*3+index,5_010+batch*1_002+index*334,body)),`batch-${batch}`);
    release(); release();
    return result;
  };
  assert.equal(h.visual.negotiate(active.target,['1.0.0'],true).bounds.maxFrameBytes,1_048_576);
  const first=submit(0);
  await Promise.resolve();
  const obsolete=submit(1), newest=submit(2);
  assert.equal((await obsolete.completion).reason,'replaced');
  assert.equal(h.visual.resourceUsage().rawBytes,6_291_456);
  assert.equal(h.visual.resourceUsage().peakRawBytesPerSession,10_518_528);
  assert.ok(h.visual.resourceUsage().peakRawBytesPerSession <= h.visual.bounds.maxRawBytesPerSession);
  h.visual.stop(active.target.sessionId,active.leaseId,active.target.principalId);
  finish({requestId:first.requestId,status:'empty',observations:[],reason:null});
  await Promise.all([first.completion,newest.completion]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.visual.resourceUsage().rawBytes,0);
  assert.equal(body[0],137,'only runtime-owned media is disposed');
  h.visual.close();
});

test('queued deadlines include waiting and dispose without waiting for an unresponsive model', async () => {
  let calls=0;
  const never:VisualPerceptionProvider={...provider,interpret:()=>{calls++;return new Promise(()=>{});}};
  const h=harness(never,()=>true,{deadlineMs:100}), first=h.begin(scope('first-deadline'));
  h.advance(20);
  const running=h.visual.submit(first.target,first.leaseId,'endpoint-clock',[h.frame(first.mappingId,0)],'first');
  await new Promise(resolve=>setTimeout(resolve,20));
  const next=h.begin(scope('queued-deadline'));
  h.advance(20);
  const started=performance.now();
  const queued=h.visual.submit(next.target,next.leaseId,'endpoint-clock',[h.frame(next.mappingId,0)],'queued');
  assert.equal((await queued.completion).reason,'deadline');
  assert.ok(performance.now()-started < 170,'queue wait cannot gain a second deadline budget');
  assert.equal(h.visual.resourceUsage().sessions.find(item=>item.sessionId===next.target.sessionId)?.rawBytes,0);
  assert.equal(calls,1);
  await running.completion;
  h.visual.close();
});

test('idle lease expiry releases capture without further polling and failed interpretation clears sight', async () => {
  let released=0;
  const visual=new VisualAdmission({provider,bounds:{leaseTtlMs:20},onLeaseEnded:()=>{released++;}}), target=scope('idle');
  const offer=visual.negotiate(target,['1.0.0'],true);
  visual.enable(target,{expectedRevision:0,challengeId:offer.challenge!.id,endpointClockId:'clock',endpointReceivedMonotonicMs:1},authority);
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(released,1);
  visual.close();
  let healthy=true;
  const sometimes:VisualPerceptionProvider={...provider,interpret:async request=>healthy?provider.interpret(request,new AbortController().signal):{requestId:request.requestId,status:'failed',observations:[],reason:'synthetic_failure'}};
  const h=harness(sometimes), active=h.begin();h.advance(20);
  await h.visual.submit(active.target,active.leaseId,'endpoint-clock',[h.frame(active.mappingId,0)],'good').completion;
  assert.equal(h.visual.cameraState(active.target.sessionId).activeForSession,true);
  healthy=false;h.advance(1_000);
  await h.visual.submit(active.target,active.leaseId,'endpoint-clock',[h.frame(active.mappingId,1,6_010)],'bad').completion;
  assert.equal(h.visual.cameraState(active.target.sessionId).activeForSession,false);
  h.visual.close();
});

test('structural media validation rejects truncated or corrupt image envelopes before provider entry', async () => {
  let calls=0;
  const inspected:VisualPerceptionProvider={...provider,interpret:async request=>{calls++;return provider.interpret(request,new AbortController().signal);}};
  const h=harness(inspected), active=h.begin();h.advance(20);
  const badCrc=Buffer.from(png);badCrc[54]^=1;
  const invalid=[png.subarray(0,24),png.subarray(0,png.length-12),badCrc,Buffer.concat([png,Buffer.from([0])])];
  for (const bytes of invalid) assert.throws(()=>h.visual.submit(active.target,active.leaseId,'endpoint-clock',[h.frame(active.mappingId,0,5_010,bytes)],'malformed'),(error:unknown)=>error instanceof VisualAdmissionError&&error.reason==='frame_invalid');
  const jpeg=Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0]);
  assert.throws(()=>h.visual.submit(active.target,active.leaseId,'endpoint-clock',[{...h.frame(active.mappingId,0,5_010,jpeg),mediaType:'image/jpeg'}],'incomplete-jpeg'),(error:unknown)=>error instanceof VisualAdmissionError&&error.reason==='frame_invalid');
  assert.equal(calls,0);
  assert.equal((await h.visual.submit(active.target,active.leaseId,'endpoint-clock',[h.frame(active.mappingId,0)],'valid-png').completion).status,'complete');
  assert.equal(calls,1);
  h.visual.close();
});
