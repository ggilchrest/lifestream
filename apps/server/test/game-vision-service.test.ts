import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,renameSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {crc32,deflateSync} from 'node:zlib';
import {prepareGameVisionRuntime} from '../src/runtime/game-vision-runtime.ts';
import {createGameObservationInterpreter} from '../src/runtime/game-frame-interpretation.ts';
import {gameCampaignFixture} from '../../../packages/runtime/test/fixtures/game-campaign.ts';
import {prepareGameVisionService,type GameVisionServiceOptions,type GameVisionFilePin} from '../src/runtime/game-vision-service.ts';

const pin = (path: string): GameVisionFilePin => {const data = readFileSync(path);return {path,sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length};};
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'game-vision-service-'));
  const projector = join(directory,'projector.gguf'), drop = join(directory,'service.conf');
  writeFileSync(projector,'FIXTURE_PROJECTOR_NOT_A_MODEL');writeFileSync(drop,'ExecStart=fixture-node-no-model-call');
  const model = join(directory,'fixture-model.gguf');
  const child = spawn(process.execPath, ['-e','setInterval(()=>{},1000)','--','--model',model,'--mmproj',projector,'--host','127.0.0.1','--port','8181','--parallel','1','--ctx-size','8192'], {stdio:'ignore'});
  await once(child,'spawn');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}rmSync(directory,{recursive:true,force:true});});
  const stat = readFileSync(`/proc/${child.pid}/stat`,'utf8'), startTicks = stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/u)[19]!;
  const argv = readFileSync(`/proc/${child.pid}/cmdline`,'utf8').split('\0').filter(Boolean);
  const activation = join(directory,'activation.json'), qualification = join(directory,'qualification.json');
  writeFileSync(activation,JSON.stringify({status:'SERVICE_HEALTHY_PROJECTOR_CONFIGURED_IMAGE_QUALIFICATION_PENDING',backend:{pid:child.pid,startTicks,argv},projector:pin(projector),dropin:pin(drop)}));
  writeFileSync(qualification,JSON.stringify({status:'QUALIFIED_LIMITED_RETAINED_IMAGE_GROUNDING_OCR_AND_CALLER_CANCELLATION_WITH_SERVER_DRAIN_LIMITATION',reservationWindow:{servicePID:child.pid,startTicks,serviceStillExact:true,closed:true},latencyQualification:{passedBoundMs:5000}}));
  let current = true;
  const options: GameVisionServiceOptions = {endpoint:'http://127.0.0.1:8181',model,modelRevision:'fixture-revision',descriptor:{process:{pid:child.pid!,startTicks},projector:pin(projector),serviceDrop:pin(drop),activationReceipt:pin(activation),qualificationReceipt:pin(qualification)},selectionCurrent:()=>current,idleTimeoutMs:60,pollIntervalMs:2};
  return {options,projector,drop,activation,qualification,directory,withdraw:()=>{current=false;}};
}

test('exact process argv/artifact/positive receipt qualification exposes only pinned capability', async t=>{
  const f=await fixture(t);let calls=0;
  t.mock.method(globalThis,'fetch',async(url:unknown,init:RequestInit)=>{calls++;assert.equal(url,'http://127.0.0.1:8181/slots');assert.equal(init.method,'GET');assert.equal(init.body,undefined);return Response.json([{is_processing:false,prompt:'PRIVATE_SLOT_BODY_NOT_RETAINED'}]);});
  const service=await prepareGameVisionService(f.options);
  assert.equal(service.available(),true);assert.deepEqual(service.capability(),{vision:true,model:f.options.model,modelRevision:'fixture-revision',loadedProjectorSha256:f.options.descriptor.projector.sha256});
  assert.equal(calls,1);assert.equal(await service.runWhenIdle(async()=>42,new AbortController().signal),42);assert.equal(calls,3);
  f.withdraw();assert.equal(service.available(),false);assert.equal(service.capability(),null);
});

test('mismatched process, selected model, drop, projector and positive qualification refuse before any work',async t=>{
  const f=await fixture(t);t.mock.method(globalThis,'fetch',async()=>Response.json([{is_processing:false}]));
  await assert.rejects(prepareGameVisionService({...f.options,model:'different-model'}));
  await assert.rejects(prepareGameVisionService({...f.options,descriptor:{...f.options.descriptor,process:{...f.options.descriptor.process,startTicks:'1'}}}));
  await assert.rejects(prepareGameVisionService({...f.options,descriptor:{...f.options.descriptor,projector:{...f.options.descriptor.projector,sha256:'b'.repeat(64)}}}));
  const bad=JSON.parse(readFileSync(f.qualification,'utf8'));bad.status='VISION_ASSUMED_FROM_MODEL_NAME';writeFileSync(f.qualification,JSON.stringify(bad));
  await assert.rejects(prepareGameVisionService({...f.options,descriptor:{...f.options.descriptor,qualificationReceipt:pin(f.qualification)}}));
});

test('per-use metadata fences in-place mutation, replacement and symlink without trusting old hash',async t=>{
  for(const target of ['projector','drop','activation'] as const){
    const f=await fixture(t);t.mock.method(globalThis,'fetch',async()=>Response.json([{is_processing:false}]));const service=await prepareGameVisionService(f.options);
    writeFileSync(f[target],'DIFFERENT_BYTES');assert.equal(service.capability(),null);assert.equal(await service.probeIdle(),false);
  }
  const f=await fixture(t);t.mock.method(globalThis,'fetch',async()=>Response.json([{is_processing:false}]));const service=await prepareGameVisionService(f.options);
  renameSync(f.projector,f.projector+'.old');symlinkSync(f.projector+'.old',f.projector);assert.equal(service.available(),false);
});

test('cancelled caller retains serial foreground step through independent server drain',async t=>{
  const f=await fixture(t);let busy=false,workExited=false,release=false;
  t.mock.method(globalThis,'fetch',async()=>Response.json([{is_processing:busy}]));
  const service=await prepareGameVisionService(f.options),abort=new AbortController();
  const pending=service.runWhenIdle(async signal=>{assert.equal(service.available(),true);assert.ok(service.capability());busy=true;signal.addEventListener('abort',()=>{workExited=true;},{once:true});abort.abort();return 7;},abort.signal).then(result=>{release=true;return result;});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(workExited,true);assert.equal(release,false);
  assert.equal(service.available(),true,'an owned drain must not falsely withdraw a healthy native source');
  assert.equal(await service.runWhenIdle(async()=>99,new AbortController().signal),null);
  busy=false;assert.equal(await pending,null);assert.equal(release,true);assert.equal(service.available(),true);
});

test('bounded drain failure latches unavailable until a fresh explicit idle probe; no late publish',async t=>{
  const f=await fixture(t);let busy=false;
  t.mock.method(globalThis,'fetch',async()=>Response.json([{is_processing:busy}]));
  const service=await prepareGameVisionService(f.options);const started=performance.now();
  assert.equal(await service.runWhenIdle(async()=>{busy=true;return 'must-not-publish';},new AbortController().signal),null);
  assert.ok(performance.now()-started>=50);assert.equal(service.available(),false);
  busy=false;assert.equal(await service.probeIdle(),true);assert.equal(service.available(),true);
});

test('invalid or oversized slot data and abort-ignoring fetch are finite and never treated as idle',async t=>{
  const f=await fixture(t);let mode='invalid';
  t.mock.method(globalThis,'fetch',async()=>{if(mode==='hang')return await new Promise<Response>(()=>{});return mode==='large'?new Response('x'.repeat(65537)):Response.json([{is_processing:'false'}]);});
  const service=await prepareGameVisionService(f.options);assert.equal(service.available(),false);
  mode='large';assert.equal(await service.probeIdle(),false);
  mode='hang';const start=performance.now();assert.equal(await service.probeIdle(),false);assert.ok(performance.now()-start<500);
});

test('long cold server drain retains the reservation through46s on a fake monotonic clock',async t=>{
 const f=await fixture(t),base=performance.now();let elapsed=0,busy=false,drainReads=0;
 t.mock.method(performance,'now',()=>base+elapsed);
 t.mock.method(globalThis,'fetch',async()=>{if(busy){drainReads++;elapsed=Math.min(46000,elapsed+20000);}return Response.json([{is_processing:busy&&elapsed<46000}]);});
 const {idleTimeoutMs,...withDefaultDrain}=f.options;const service=await prepareGameVisionService(withDefaultDrain),cancel=new AbortController();
 const result=await service.runWhenIdle(async()=>{busy=true;cancel.abort();return 'discarded caller result';},cancel.signal);
 assert.equal(result,null);assert.equal(elapsed,46000);assert.ok(drainReads>=4);assert.equal(service.available(),true);
 await assert.rejects(prepareGameVisionService({...f.options,idleTimeoutMs:120001}));
});

function runtimeFrame(){
 const observation=structuredClone(gameCampaignFixture().input.observation),shot=observation.screenshots[0]!;
 const chunk=(name:string,data:Buffer)=>{const h=Buffer.alloc(8),tail=Buffer.alloc(4);h.writeUInt32BE(data.length);h.write(name,4);tail.writeUInt32BE(crc32(Buffer.concat([h.subarray(4),data])));return Buffer.concat([h,data,tail]);},header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;
 const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,1,2,3]))),chunk('IEND',Buffer.alloc(0))]);
 Object.assign(shot,{sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,width:1,height:1});return {observation,shot,bytes};
}
const fixtureForeground=async(work:any)=>{if(!work.current()||!work.admitOnce())return {state:'cancelled'};try{let value;for(const step of work.steps)value=await step(new AbortController().signal);return {state:work.publish(value)?'published':'cancelled'};}catch{return {state:'failed'};}};
test('actual runtime decoder and interpreter report first provider refusal before generic scheduler refusal without accepted usage',async t=>{
 const f=await fixture(t),frame=runtimeFrame(),failures:any[]=[],accepted:any[]=[];let modelCalls=0,settled=0;
 t.mock.method(globalThis,'fetch',async(url:unknown,init:RequestInit)=>{
  if(String(url).endsWith('/slots'))return Response.json([{is_processing:false}]);
  modelCalls++;const request=JSON.parse(String(init.body));assert.equal(request.max_tokens,192);
  return Response.json({model:f.options.model,choices:[{finish_reason:'length',message:{role:'assistant',content:'PRIVATE REFUSED BODY'}}],usage:{prompt_tokens:321,completion_tokens:192}});
 });
 const runtime=await prepareGameVisionRuntime({...f.options,discovery:{runSupervisedForeground:fixtureForeground as any},onFailure:value=>{failures.push(value);throw Error('PRIVATE SINK');},onInterpretedObservation:value=>accepted.push(value)});
 const session={preparationCurrent:()=>true,current:()=>true,resolveApproval:()=>({sharedInference:true}),executionConsent:()=>null},ports=runtime.forSession(frame.observation.scope,session);
 const interpreter=createGameObservationInterpreter({...ports,sourceCurrent:()=>true,pinsDigestFor:()=>frame.observation.pinsDigest,readFrame:async()=>Buffer.from(frame.bytes),maximumBytes:1024,maximumLongEdge:256,maximumObservationAgeMs:10000});
 const result=await interpreter({scope:frame.observation.scope,runtime:{isCurrent:()=>true}} as any,frame.observation,new AbortController().signal,{admitOnce:()=>true,settleUsage:()=>{settled++;return true;}});
 assert.equal(result,null);assert.equal(modelCalls,1);assert.equal(failures.length,1);assert.deepEqual(Object.keys(failures[0]).sort(),['phase','reason','schemaVersion','source','visionWitness']);
 assert.equal(failures[0].visionWitness.reason,'response_finish');assert.equal(failures[0].visionWitness.finishReason,'length');assert.equal(failures[0].visionWitness.observationId,frame.observation.observationId);assert.equal(failures[0].visionWitness.screenshotSha256,frame.shot.sha256);
 assert.equal(accepted.length,0);assert.equal(settled,0);assert.doesNotMatch(JSON.stringify(failures),/PRIVATE/);
});
test('runtime diagnostic binding rejects foreign scope before latch and records currentness refusal without another current probe',async t=>{
 const f=await fixture(t),frame=runtimeFrame(),failures:any[]=[];let checks=0;
 t.mock.method(globalThis,'fetch',async()=>Response.json([{is_processing:false}]));
 const runtime=await prepareGameVisionRuntime({...f.options,discovery:{runSupervisedForeground:fixtureForeground as any},onFailure:value=>failures.push(value)});
 const ports=runtime.forSession(frame.observation.scope,{preparationCurrent:()=>{checks++;return true;},current:()=>{checks++;return true;},resolveApproval:()=>null,executionConsent:()=>null}),foreign=structuredClone(frame.observation);
 foreign.scope={...foreign.scope,runId:'00000000-0000-0000-0000-000000000000'};
 ports.onRefusal!(foreign,{reason:'observation_validation'});assert.equal(failures.length,0);
 f.withdraw();const before=checks;ports.onRefusal!(frame.observation,{reason:'source_current'});assert.equal(checks,before);assert.equal(failures.length,1);assert.equal(failures[0].visionWitness.kind,'interpreter');assert.equal(failures[0].visionWitness.reason,'source_current');
 ports.onRefusal!(frame.observation,{reason:'exception'});assert.equal(failures.length,1);
});
test('valid stop with192 tokens and empty visual facts remains accepted with no diagnostic callback',async t=>{
 const f=await fixture(t),frame=runtimeFrame(),failures:any[]=[];
 t.mock.method(globalThis,'fetch',async(url:unknown)=>String(url).endsWith('/slots')?Response.json([{is_processing:false}]):Response.json({model:f.options.model,choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({observations:[]})}}],usage:{prompt_tokens:321,completion_tokens:192}}));
 const runtime=await prepareGameVisionRuntime({...f.options,discovery:{runSupervisedForeground:fixtureForeground as any},onFailure:value=>failures.push(value)});
 const ports=runtime.forSession(frame.observation.scope,{preparationCurrent:()=>true,current:()=>true,resolveApproval:()=>({sharedInference:true}),executionConsent:()=>null});
 const result=await ports.decoder.decode({purpose:'simulatedGame/gameFramebuffer',observation:frame.observation,screenshot:frame.shot,bytes:Buffer.from(frame.bytes)},new AbortController().signal);
 assert.deepEqual(result,{facts:[],visibleState:[]});assert.equal(failures.length,0);
});
