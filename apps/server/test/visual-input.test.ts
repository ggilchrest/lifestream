import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {VisualAdmissionError} from '@lifestream/runtime/perception/admission';
import {fixtureVisualProvider} from '@lifestream/runtime/perception/fixture';
import {VisualInputHost} from '../src/runtime/visual-input.ts';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {readSessionEndpoint} from '../src/runtime/session-context.ts';

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

function multipart(metadata:unknown,frameId:string,bytes:Uint8Array,mediaType='image/png') {
  const boundary='synthetic-visual-boundary';
  const body=Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${frameId}"\r\nContent-Type: ${mediaType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  return {body,contentType:`multipart/form-data; boundary=${boundary}`};
}

async function httpFixture(t:import('node:test').TestContext,configured:boolean) {
  const root=await mkdtemp(join(tmpdir(),'ls-visual-http-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const config=loadProfile('test');
  config.storage={databasePath:join(root,'state.sqlite'),artifactDirectory:join(root,'artifacts')};
  config.authority.authentication='local-password';
  const password=randomBytes(24).toString('hex'),installerToken=randomBytes(32).toString('hex');
  let app:ReturnType<typeof createLifestreamServer>;
  let mono=5_000,connected=true,invocations=0,releases=0;
  const visualInput=configured?{
    provider:fixtureVisualProvider(request=>{invocations++;return {requestId:request.requestId,status:'empty' as const,observations:[],reason:null};}),
    scopeFor:(visualActor:{principalId:string;sessionId:string;assistantId:string})=>{
      const database=(app as any).database;
      const session=readSessionEndpoint(database,visualActor.sessionId);
      const row=database.connection.prepare("SELECT conversation_id AS conversationId FROM sessions WHERE id=? AND status='active'").get(visualActor.sessionId) as {conversationId:string}|undefined;
      if(!session.endpoint||!row)return null;
      return {...visualActor,relationshipId:null,environmentId:'synthetic-test-environment',conversationId:row.conversationId,endpointId:session.endpoint.endpointId,sessionRevision:session.revision,audienceRevision:1,scopeGeneration:1};
    },
    sourceFor:()=>connected?{bindingRef:'synthetic-host-source',connected:true,configurationRevision:1}:null,
    captureAuthority:()=>authority,
    releaseCapture:()=>{releases++;},
    monotonicMs:()=>mono,
    utcMs:()=>Date.parse('2026-09-29T12:00:00Z')+mono
  }:undefined;
  app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'auth'),installerToken},audiencePrivacy:{sourceIds:[]},...(visualInput?{visualInput}:{})});
  await app.start();
  t.after(()=>app.shutdown());
  const base=`http://127.0.0.1:${app.address().port}`;
  const basic={origin:base,'content-type':'application/json'};
  const setup=await fetch(base+'/api/auth/v1/setup',{method:'POST',headers:basic,body:JSON.stringify({username:'owner',password,installerToken})});
  assert.equal(setup.status,201);
  const session=(await setup.json()).session as {sessionId:string;principalId:string;csrfToken:string};
  const headers={...basic,cookie:setup.headers.get('set-cookie')!.split(';')[0]!,'x-lifestream-csrf':session.csrfToken};
  const request=(path:string,body:unknown,method='POST',extra:Record<string,string>={})=>fetch(base+path,{method,headers:{...headers,...extra},body:JSON.stringify(body)});
  const created=await(await request('/api/admin/v1/assistants',{displayName:'Synthetic visual Assistant'})).json();
  const assistantId=created.assistantId as string;
  assert.equal((await request(`/api/admin/v1/assistants/${assistantId}/activate`,{profileId:created.profile.profileId,expectedActiveRevision:null})).status,200);
  assert.equal((await request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',bindingKey:randomUUID()})).status,200);
  assert.equal((await request('/api/runtime/v1/audience',{mode:'solo',seconds:300})).status,200);
  const route=(op:'capabilities'|'camera'|'batches',id=session.sessionId)=>`/api/runtime/vision/v1/sessions/${id}/${op}`;
  return {app,base,headers,session,assistantId,request,route,advance:(ms:number)=>{mono+=ms;},disconnect:()=>{connected=false;},invocations:()=>invocations,releases:()=>releases};
}

test('authenticated visual HTTP route admits only a bounded synthetic provider/source and retires on audience change',{timeout:15_000},async t=>{
  const f=await httpFixture(t,true),base={schemaVersion:'1.0.0',assistantId:f.assistantId};
  assert.equal((await fetch(f.base+f.route('capabilities'),{method:'POST',headers:{origin:f.base,'content-type':'application/json'},body:JSON.stringify({...base,supportedVersions:['1.0.0']})})).status,401);
  assert.equal((await f.request(f.route('capabilities'),{...base,supportedVersions:['1.0.0']},'POST',{'x-lifestream-csrf':'wrong'})).status,403);
  assert.equal((await f.request(f.route('capabilities',randomUUID()),{...base,supportedVersions:['1.0.0']})).status,403);
  const offered=await f.request(f.route('capabilities'),{...base,supportedVersions:['1.0.0']});
  assert.equal(offered.status,200,await offered.clone().text());
  const capability=await offered.json();
  assert.equal(capability.available,true);
  assert.equal(capability.camera.captureActive,false);
  f.advance(20);
  const camera={...base,action:'enable',expectedRevision:0,idempotencyKey:randomUUID(),challengeId:capability.negotiation.challenge.id,endpointClockId:'synthetic-clock',endpointReceivedMonotonicMs:4_000};
  const enabled=await f.request(f.route('camera'),camera,'PUT');
  assert.equal(enabled.status,200,await enabled.clone().text());
  const state=(await enabled.json()).camera;
  assert.equal(state.captureActive,true);
  assert.equal((await(await f.request(f.route('camera'),camera,'PUT')).json()).camera.leaseId,state.leaseId);
  f.advance(20);
  const frameId=randomUUID(),metadata={...base,leaseId:state.leaseId,endpointClockId:'synthetic-clock',correlationId:randomUUID(),frames:[{frameId,sequence:0,capturedMonotonicMs:4_010,clockMappingId:state.clockMappingId,mediaType:'image/png',sha256:createHash('sha256').update(png).digest('hex')}]};
  const sendBatch=(value:unknown,bytes=png,extra:Record<string,string>={})=>{const part=multipart(value,frameId,bytes);return fetch(f.base+f.route('batches'),{method:'POST',headers:{...f.headers,'content-type':part.contentType,...extra},body:part.body});};
  let entered:()=>void=()=>{},completed:(status:number)=>void=()=>{};
  const started=new Promise<void>(resolve=>{entered=resolve;}),heldResult=new Promise<number>(resolve=>{completed=resolve;});
  (f.app as any).server.once('request',entered);
  const held=httpRequest(f.base+f.route('batches'),{method:'POST',headers:{...f.headers,'content-type':'multipart/form-data; boundary=synthetic-visual-boundary','transfer-encoding':'chunked'}},response=>{response.resume();response.on('end',()=>completed(response.statusCode!));});
  held.on('error',()=>completed(0));
  t.after(()=>held.destroy());
  held.flushHeaders();
  await started;
  assert.equal((await sendBatch(metadata)).status,429,'one upload per session is admitted at a time');
  held.end('incomplete');
  assert.equal(await heldResult,400);
  assert.equal((await sendBatch(metadata,png,{'x-lifestream-csrf':'wrong'})).status,403);
  assert.equal((await sendBatch({...metadata,frames:[{...metadata.frames[0],sha256:'0'.repeat(64)}]})).status,422);
  const admitted=await sendBatch(metadata);
  assert.equal(admitted.status,200,await admitted.clone().text());
  assert.equal((await admitted.json()).result.status,'empty');
  assert.equal(f.invocations(),1);
  assert.equal((await fetch(f.base+'/health')).status,200);
  (f.app as any).invalidateRuntimeInputs();
  const stillActive=await f.request(f.route('capabilities'),{...base,supportedVersions:['1.0.0']});
  assert.equal((await stillActive.json()).camera.captureActive,true,'readiness and unrelated runtime updates retain a valid lease');
  assert.equal((await f.request('/api/runtime/v1/audience',{mode:'shared'})).status,200);
  assert.equal(f.releases(),1);
  assert.equal((await sendBatch(metadata)).status,403);
  const stop=await f.request(f.route('camera'),{...base,action:'stop',expectedRevision:1,idempotencyKey:randomUUID(),leaseId:state.leaseId},'PUT');
  assert.equal(stop.status,200);
  assert.equal((await stop.json()).camera.captureActive,false);
  assert.equal(f.invocations(),1);
  assert.equal((await f.request('/api/runtime/v1/audience',{mode:'solo',seconds:300})).status,200);
  const renewedOffer=await(await f.request(f.route('capabilities'),{...base,supportedVersions:['1.0.0']})).json();
  f.advance(20);
  const next=await f.request(f.route('camera'),{...base,action:'enable',expectedRevision:0,idempotencyKey:randomUUID(),challengeId:renewedOffer.negotiation.challenge.id,endpointClockId:'synthetic-clock',endpointReceivedMonotonicMs:4_100},'PUT');
  assert.equal(next.status,200,await next.clone().text());
  assert.equal((await next.json()).camera.captureActive,true);
  assert.equal((await f.request('/api/auth/v1/permissions',{principalId:f.session.principalId,assistantId:f.assistantId,administer:false})).status,200);
  assert.equal(f.releases(),2,'revocation releases the newly enabled synthetic capture');
  assert.equal((await f.request(f.route('capabilities'),{...base,supportedVersions:['1.0.0']})).status,403);
});

test('visual HTTP route remains unavailable without a trusted source and selected provider',{timeout:15_000},async t=>{
  const f=await httpFixture(t,false),base={schemaVersion:'1.0.0',assistantId:f.assistantId};
  const offered=await f.request(f.route('capabilities'),{...base,supportedVersions:['1.0.0']});
  assert.equal(offered.status,200);
  const capability=await offered.json();
  assert.equal(capability.available,false);
  assert.equal(capability.reason,'source_unavailable');
  assert.equal(capability.negotiation,null);
  const enabled=await f.request(f.route('camera'),{...base,action:'enable',expectedRevision:0,idempotencyKey:randomUUID(),challengeId:randomUUID(),endpointClockId:'clock',endpointReceivedMonotonicMs:1},'PUT');
  assert.equal(enabled.status,503);
  assert.equal((await enabled.json()).code,'source_unavailable');
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
  const otherAssistant={...actor,assistantId:'assistant-b'};
  assert.equal(visual.state(otherAssistant).leaseId,null,'another Assistant in the session cannot inspect the lease');
  visual.camera(otherAssistant,{action:'stop',expectedRevision:started.revision,idempotencyKey:'foreign-stop',leaseId:started.leaseId!});
  assert.equal(visual.state(actor).captureActive,true,'another Assistant cannot stop the current lease');
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
