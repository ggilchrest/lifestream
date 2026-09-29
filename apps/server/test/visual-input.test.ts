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
import {AudienceCoordinator,type AudienceIdentity,type CameraAudienceReason} from '../src/runtime/audience.ts';
import type {VisualHumanCount,VisualPerceptionRequest,VisualPerceptionResult} from '@lifestream/runtime/perception/port';

const actor = {principalId:'owner',sessionId:'session-a',assistantId:'assistant-a'};
const authority = {sourceConnected:true,devicePermission:true,hostCaptureLease:true,interpretationAllowed:true,remoteEgressAllowed:false,foregroundVisible:true};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+5gz/qwAAAABJRU5ErkJggg==','base64');

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

test('host bounds concurrent upload reservations and aborts them on invalidation or shutdown', () => {
  const host=new VisualInputHost({scopeFor:()=>null,sourceFor:()=>null,captureAuthority:()=>authority});
  const uploads=Array.from({length:4},(_,index)=>host.openUpload(`upload-${index}`));
  assert.throws(()=>host.openUpload('upload-0'),/visual_upload_busy/);
  assert.throws(()=>host.openUpload('upload-4'),/visual_upload_capacity/);
  assert.equal(host.resourceUsage().rawBytes,4*4_227_072);
  assert.ok(uploads.every(upload=>upload.limits.maxFrameBytes===1_048_576&&upload.limits.deadlineMs===5_000));
  host.invalidate('upload-0');
  assert.equal(uploads[0]!.signal.aborted,true);
  uploads[0]!.release();
  const replacement=host.openUpload('upload-4');
  host.close();
  assert.ok([...uploads,replacement].every(upload=>upload.signal.aborted));
  for (const upload of [...uploads,replacement]) upload.release();
  assert.equal(host.resourceUsage().rawBytes,0);
});

test('revoked interpretation cannot invoke provider and a denied stale actor cannot stop a successor', async () => {
  let mono=10_000, allowed=true, invocations=0, selected='assistant-a';
  const host=new VisualInputHost({provider:fixtureVisualProvider(request=>{invocations++;return {requestId:request.requestId,status:'empty',observations:[],reason:null};}),
    scopeFor:request=>request.assistantId===selected?{...request,relationshipId:null,environmentId:'test',conversationId:'conversation',endpointId:'endpoint',sessionRevision:1,audienceRevision:1,scopeGeneration:1}:null,
    sourceFor:()=>({bindingRef:'test-source',connected:true,configurationRevision:1}),captureAuthority:()=>({...authority,interpretationAllowed:allowed}),monotonicMs:()=>mono});
  const begin=(request=actor)=>{
    const offer=host.capabilities(request,['1.0.0']);mono+=20;
    return host.camera(request,{action:'enable',expectedRevision:offer.camera.revision,idempotencyKey:randomUUID(),challengeId:offer.negotiation!.challenge!.id,endpointClockId:'clock',endpointReceivedMonotonicMs:5_000});
  };
  const first=begin();mono+=20;
  const meta={leaseId:first.leaseId!,endpointClockId:'clock',correlationId:'test',frames:[{frameId:'frame',sequence:0,capturedMonotonicMs:5_010,clockMappingId:first.clockMappingId!,mediaType:'image/png' as const,sha256:createHash('sha256').update(png).digest('hex')}]};
  allowed=false;
  await assert.rejects(()=>host.batch(actor,meta,new Map([['frame',png]])),(error:unknown)=>error instanceof VisualAdmissionError&&error.reason==='permission_denied');
  assert.equal(invocations,0);assert.equal(host.state(actor).captureActive,false);
  allowed=true;selected='assistant-b';
  const successor={...actor,assistantId:selected}, current=begin(successor);
  await assert.rejects(()=>host.batch(actor,meta,new Map([['frame',png]])),(error:unknown)=>error instanceof VisualAdmissionError&&error.reason==='scope_changed');
  assert.equal(host.state(successor).leaseId,current.leaseId);
  assert.equal(host.state(successor).captureActive,true);
  host.close();
});

test('selected visual expiry notifies output fences without another camera request',{timeout:3000},async t=>{
  let expired!:()=>void;
  const expiry=new Promise<void>(resolve=>{expired=resolve;});
  let view:ReturnType<VisualInputHost['prepareContext']>=null;
  let observed:unknown;
  const visual=new VisualInputHost({
    provider:fixtureVisualProvider(request=>(observed={capturedAtEarliestMs:request.capturedAtEarliestMs,capturedAtLatestMs:request.capturedAtLatestMs,receivedAtMs:request.receivedAtMs}, {requestId:request.requestId,status:'complete',reason:null,observations:[{observationId:'generated-observation',frameIds:[request.frames[0]!.frameId],appearance:'A synthetic blue square.',inference:null,confidence:null,limitations:['Synthetic fixture.']}]})),
    scopeFor:request=>({...request,relationshipId:null,environmentId:'test',conversationId:'conversation',endpointId:'endpoint',sessionRevision:1,audienceRevision:1,scopeGeneration:1}),
    sourceFor:()=>({bindingRef:'synthetic-source',connected:true,configurationRevision:1}),
    captureAuthority:()=>authority,bounds:{freshnessMs:250}
  },()=>{if(view&&!visual.contextCurrent(view))expired();});
  t.after(()=>visual.close());
  const offer=visual.capabilities(actor,['1.0.0']);
  const lease=visual.camera(actor,{action:'enable',expectedRevision:offer.camera.revision,idempotencyKey:randomUUID(),challengeId:offer.negotiation!.challenge!.id,endpointClockId:'synthetic-clock',endpointReceivedMonotonicMs:performance.now()});
  const frameId=randomUUID();
  await visual.batch(actor,{leaseId:lease.leaseId!,endpointClockId:'synthetic-clock',correlationId:randomUUID(),frames:[{frameId,sequence:0,capturedMonotonicMs:performance.now(),clockMappingId:lease.clockMappingId!,mediaType:'image/png',sha256:createHash('sha256').update(png).digest('hex')}]},new Map([[frameId,png]]));
  const prepare={expectedConversationId:'conversation',expectedRelationshipId:null,viewId:randomUUID(),revision:1,invalidationKey:'expiry-test',conversation:'[]',explicitQuestion:true,allowAside:false};
  view=visual.prepareContext(actor,prepare);assert.ok(view,JSON.stringify({observed,now:Date.now(),state:visual.state(actor),store:(visual as any).observations.diagnostics()}));assert.equal(visual.contextCurrent(view),true);
  assert.ok(visual.prepareContext(actor,{...prepare,viewId:randomUUID()}));
  assert.equal((visual as any).viewExpiries.size,1,'same capture expiry shares one deadline across prepared requests');
  await expiry;
  assert.equal(visual.contextCurrent(view),false);
  assert.equal((visual as any).viewExpiries.size,0);
  assert.equal(visual.state(actor).captureActive,true,'observation expiry does not revoke the capture lease');
  visual.close();assert.equal((visual as any).viewExpiries.size,0);
});

function cameraAudienceFixture(t:import('node:test').TestContext,options:{countLimitation?:string;scene?:boolean}={}){
  const epoch=Date.parse('2026-09-29T12:00:00Z');let mono=5000.25,mappingMono=0,sequence=0,count:VisualHumanCount['classification']|undefined='one',delay=0,failed=false,connected=true,sourceId='camera-source',optionalReady=true,healthy=true;
  let hold:{wait:Promise<void>;entered:()=>void}|undefined;
  const identity:AudienceIdentity={principalId:actor.principalId,sessionId:actor.sessionId,endpointId:'endpoint'};
  const events:Array<{reason:CameraAudienceReason;captureActive:boolean;revision:number}>=[],releases:string[]=[];
  let host:VisualInputHost|undefined,last:VisualPerceptionRequest|undefined;
  const audience=new AudienceCoordinator({sourceIds:['independent-owner'],cameraSourceIds:['camera-source'],now:()=>epoch+mono,monotonicMs:()=>mono,onCameraChanged:(who,snapshot,reason)=>{
    host?.audienceChanged(who);
    // Mirrors the server's ordering: only now may output fences query capture.
    events.push({reason,captureActive:host?.state(actor).captureActive??false,revision:snapshot.revision});
  }});
  audience.declare(identity,'solo',900);
  const synthetic=fixtureVisualProvider(request=>{
      last=request;mono+=delay;
      if(failed)return {requestId:request.requestId,status:'failed',observations:[],reason:'provider_unavailable'};
      return {requestId:request.requestId,status:'complete',reason:null,
        observations:options.scene===false?[]:[{observationId:'synthetic-scene',frameIds:[request.frames[0]!.frameId],appearance:'A synthetic blue square.',inference:null,confidence:null,limitations:['Synthetic pixels; no real room.']}],
        ...(count?{humanCount:{frameIds:[request.frames[0]!.frameId],classification:count,confidence:null,fieldOfView:'Synthetic frame only.',coverage:'frameOnly' as const,limitations:[options.countLimitation??'No identity or room coverage evidence.']}}:{})};
    });
  host=new VisualInputHost({
    provider:{...synthetic,healthy:()=>healthy,interpret:async(request,signal)=>{const gate=hold;hold=undefined;if(gate){gate.entered();await gate.wait;}return synthetic.interpret(request,signal);}},optionalWorkReady:()=>optionalReady,
    scopeFor:request=>({...request,relationshipId:null,environmentId:'test',conversationId:'conversation',endpointId:'endpoint',sessionRevision:1,audienceRevision:audience.snapshot(identity).revision,scopeGeneration:1}),
    sourceFor:request=>connected?{bindingRef:'synthetic-camera-binding',connected:true,configurationRevision:1,...(request.sessionId===actor.sessionId?{audienceSourceId:sourceId}:{})}:null,
    captureAuthority:()=>authority,releaseCapture:(_actor,_scope,_lease,reason)=>releases.push(reason),monotonicMs:()=>mono,utcMs:()=>epoch+mono
  },()=>{},()=>audience);
  const visual=host;t.after(()=>{visual.close();audience.close();});
  const command=(action:'enable'|'renew',leaseId?:string)=>{
    const offer=visual.capabilities(actor,['1.0.0']);mono+=20;mappingMono=mono;
    return visual.camera(actor,{action,expectedRevision:offer.camera.revision,idempotencyKey:randomUUID(),...(leaseId?{leaseId}:{}),challengeId:offer.negotiation!.challenge!.id,endpointClockId:'camera-clock',endpointReceivedMonotonicMs:4000});
  };
  const initial=command('enable');
  const batch=async(classification:VisualHumanCount['classification']|undefined,advance=1000,providerDelay=0,failure=false,skipStateRead=false)=>{
    count=classification;delay=providerDelay;failed=failure;mono+=advance;
    const state=skipStateRead?initial:visual.state(actor),frameId=randomUUID();
    return visual.batch(actor,{leaseId:state.leaseId!,endpointClockId:'camera-clock',correlationId:randomUUID(),frames:[{frameId,sequence:sequence++,capturedMonotonicMs:4000+mono-mappingMono,clockMappingId:state.clockMappingId!,mediaType:'image/png',sha256:createHash('sha256').update(png).digest('hex')}]},new Map([[frameId,png]]));
  };
  const prepare=()=>visual.prepareContext(actor,{expectedConversationId:'conversation',expectedRelationshipId:null,viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),conversation:'[]',explicitQuestion:true,allowAside:false});
  const qualify=()=>{
    mono+=1;const state=visual.state(actor);
    return audience.requalifyCamera(identity,{binding:{sourceId:'camera-source',sourceBindingRef:'synthetic-camera-binding',configurationRevision:1,leaseId:state.leaseId!,captureEpoch:state.clockMappingId!},expectedAudienceRevision:audience.snapshot(identity).revision,
      ownerEvidence:{sourceId:'independent-owner',evidenceRef:randomUUID(),endpointId:'endpoint',principalId:actor.principalId,observedAt:new Date(epoch+mono).toISOString(),expiresAt:new Date(epoch+mono+4000).toISOString(),coverageKnown:true,ownerPresent:true,occupants:1}});
  };
  const holdNext=()=>{let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});hold={wait,entered:enter};return {entered,release};};
  const occupyOtherSession=async()=>{
    const other={...actor,sessionId:'synthetic-other-session'},gate=holdNext(),offer=visual.capabilities(other,['1.0.0']);mono+=20;
    const lease=visual.camera(other,{action:'enable',expectedRevision:offer.camera.revision,idempotencyKey:randomUUID(),challengeId:offer.negotiation!.challenge!.id,endpointClockId:'other-clock',endpointReceivedMonotonicMs:4000});mono+=20;
    const frameId=randomUUID(),pending=visual.batch(other,{leaseId:lease.leaseId!,endpointClockId:'other-clock',correlationId:randomUUID(),frames:[{frameId,sequence:0,capturedMonotonicMs:4010,clockMappingId:lease.clockMappingId!,mediaType:'image/png',sha256:createHash('sha256').update(png).digest('hex')}]},new Map([[frameId,png]]));
    await gate.entered;return {pending,release:gate.release};
  };
  return {visual,audience,identity,initial,events,releases,batch,prepare,qualify,command,holdNext,occupyOtherSession,last:()=>last!,at:(utc:number)=>{mono=utc-epoch;},disconnect:()=>{connected=false;},replaceSourceId:()=>{sourceId='unapproved-source';},optionalWork:(ready:boolean)=>{optionalReady=ready;},providerHealth:(ready:boolean)=>{healthy=ready;}};
}

test('camera count host keeps the authorized lease and rebases its accepted scene before synchronous fences',async t=>{
  const f=cameraAudienceFixture(t);
  assert.equal(f.initial.captureActive,true);assert.equal(f.audience.snapshot(f.identity).privateAllowed,false,'enable retires the prior manual-only clearance');
  assert.equal(f.events.at(-1)?.reason,'cameraStarted');assert.equal(f.events.at(-1)?.captureActive,true);
  const receipt=await f.batch('multiple',20);assert.equal(receipt.result.status,'complete');assert.equal(Object.hasOwn(receipt.result,'humanCount'),false,'closed HTTP receipt excludes internal count');
  const shared=f.audience.snapshot(f.identity),view=f.prepare();assert.equal(shared.classification,'shared');assert.ok(view);assert.equal(view.scope.audienceRevision,shared.revision);assert.equal(view.leaseId,f.initial.leaseId);assert.equal(f.events.at(-1)?.captureActive,true);
  await f.batch('one');assert.equal(f.audience.snapshot(f.identity).privateAllowed,false,'one visible person is not authenticated owner presence');
  const revision=f.audience.snapshot(f.identity).revision,events=f.events.length,firstOne=f.audience.cameraEvidence(f.identity)!;
  await f.batch('one');assert.equal(f.audience.snapshot(f.identity).revision,revision);assert.equal(f.events.length,events);assert.notEqual(f.audience.cameraEvidence(f.identity)?.evidenceRef,firstOne.evidenceRef);
  assert.equal(f.visual.state(actor).leaseId,f.initial.leaseId);assert.deepEqual(f.releases,[]);
});

test('count expiry at two seconds fences the old view while the same scene remains usable until its six-second deadline',async t=>{
  const f=cameraAudienceFixture(t);await f.batch('multiple',20);const before=f.prepare();assert.ok(before);
  const countExpiry=Date.parse(f.audience.cameraEvidence(f.identity)!.expiresAt);assert.equal(countExpiry,before.capturedAtEarliestMs+2000);
  f.at(countExpiry);f.audience.tick();
  assert.equal(f.audience.snapshot(f.identity).classification,'unknown');assert.equal(f.events.at(-1)?.reason,'countExpired');assert.equal(f.events.at(-1)?.captureActive,true,'capture was rebound before fences queried it');
  assert.equal(f.visual.contextCurrent(before),false);
  const after=f.prepare();assert.ok(after);assert.equal(after.capturedAtEarliestMs,before.capturedAtEarliestMs);assert.equal(after.expiresAtMs,before.expiresAtMs);assert.equal(after.expiresAtMs,before.capturedAtEarliestMs+6000);assert.ok(after.scope.audienceRevision>before.scope.audienceRevision);
  f.at(after.expiresAtMs);assert.equal(f.prepare(),null);assert.equal(f.visual.state(actor).captureActive,true);
});

test('missing and failed counts withdraw prior independent clearance without ending capture',async t=>{
  for(const failure of [false,true]){
    const f=cameraAudienceFixture(t);await f.batch('one',20);assert.equal(f.qualify().privateAllowed,true);
    const receipt=await f.batch(undefined,1000,0,failure);
    assert.equal(receipt.result.status,failure?'failed':'complete');assert.equal(f.audience.snapshot(f.identity).privateAllowed,false);assert.equal(f.audience.cameraEvidence(f.identity),null);assert.equal(f.visual.state(actor).captureActive,true);
    assert.equal(!!f.prepare(),!failure,'only a completed scene remains usable');
  }
});

test('too-old count cannot clear unknown; renewal replaces its epoch and source end cannot restore prior solo',async t=>{
  const f=cameraAudienceFixture(t);const result=await f.batch('one',20,2100);assert.equal(result.result.status,'complete');assert.equal(f.audience.cameraEvidence(f.identity),null);assert.equal(f.audience.snapshot(f.identity).privateAllowed,false);assert.ok(f.prepare(),'scene retains its separate six-second lifetime');
  const renewed=f.command('renew',f.initial.leaseId!);assert.equal(renewed.captureActive,true);assert.equal(renewed.leaseId,f.initial.leaseId);assert.notEqual(renewed.clockMappingId,f.initial.clockMappingId);assert.equal(f.prepare(),null,'renewal retires prior scene');
  await f.batch('one',1000);assert.equal(f.qualify().privateAllowed,true);
  f.disconnect();assert.equal(f.visual.state(actor).captureActive,false);assert.equal(f.audience.snapshot(f.identity).classification,'unknown');assert.equal(f.events.at(-1)?.reason,'cameraEnded');assert.equal(f.events.at(-1)?.captureActive,false);assert.deepEqual(f.releases,['invalidated']);
  assert.equal(f.audience.declare(f.identity,'solo').privateAllowed,false,'source loss cannot revive a manual-only clearance');
});

test('camera stop releases its broker lease even when an audience subscriber throws',async t=>{
  const f=cameraAudienceFixture(t);await f.batch('multiple',20);
  f.audience.subscribe(f.identity,snapshot=>{if(snapshot.classification==='unknown')throw Error('Synthetic failing subscriber');});
  const stopped=f.visual.camera(actor,{action:'stop',expectedRevision:f.visual.state(actor).revision,idempotencyKey:randomUUID(),leaseId:f.initial.leaseId!});
  assert.equal(stopped.captureActive,false);assert.deepEqual(f.releases,['stop']);assert.equal(f.audience.snapshot(f.identity).privateAllowed,false);
});

test('host camera audience preserves an admitted count limitation beyond 256 bytes',async t=>{
  const limitation='x'.repeat(257),f=cameraAudienceFixture(t,{countLimitation:limitation});
  const result=await f.batch('multiple',20);assert.equal(result.result.status,'complete');
  assert.equal(f.audience.snapshot(f.identity).classification,'shared');assert.deepEqual(f.audience.cameraEvidence(f.identity)?.limitations,[limitation]);assert.equal(f.visual.state(actor).captureActive,true);
});

test('a pending provider completion signals camera loss before any subsequent camera-state read',async t=>{
  for(const loss of ['disconnect','sourceId'] as const){
    const f=cameraAudienceFixture(t);await f.batch('one',20);assert.equal(f.qualify().privateAllowed,true);
    const gate=f.holdNext(),pending=f.batch('one',1000);await gate.entered;
    if(loss==='disconnect')f.disconnect();else f.replaceSourceId();gate.release();
    const result=await pending;assert.equal(result.result.reason,'scope_changed');
    assert.equal(f.audience.snapshot(f.identity).privateAllowed,false,loss+' must withdraw clearance without a visual.state read or count expiry');
    assert.equal(f.events.at(-1)?.reason,'cameraEnded');assert.deepEqual(f.releases,['invalidated']);
    assert.equal(f.visual.state(actor).captureActive,false);
  }
});

test('a genuine foreground deferral preserves current qualified count at its original expiry',async t=>{
  const f=cameraAudienceFixture(t);await f.batch('one',20);f.qualify();const before=f.audience.snapshot(f.identity),count=f.audience.cameraEvidence(f.identity)!;
  const occupied=await f.occupyOtherSession(),pending=f.batch('one',1000);f.optionalWork(false);occupied.release();await occupied.pending;
  const result=await pending;assert.equal(result.result.reason,'foreground_priority');assert.equal(f.audience.snapshot(f.identity).privateAllowed,true);assert.equal(f.audience.snapshot(f.identity).revision,before.revision);assert.equal(f.audience.cameraEvidence(f.identity)?.expiresAt,count.expiresAt);
  f.at(Date.parse(count.expiresAt));f.audience.tick();assert.equal(f.audience.snapshot(f.identity).privateAllowed,false,'deferral never extends the old count lifetime');
});

test('provider health loss withdraws scene and count-only clearance and recovery cannot revive either',async t=>{
  for(const scene of [true,false]){
    const f=cameraAudienceFixture(t,{scene});await f.batch('one',20);assert.equal(f.qualify().privateAllowed,true);const view=f.prepare();assert.equal(!!view,scene);
    f.providerHealth(false);const unavailable=f.visual.state(actor);assert.equal(unavailable.reason,'provider_unavailable');assert.equal(unavailable.captureActive,true);
    assert.equal(f.audience.snapshot(f.identity).privateAllowed,false);assert.equal(f.audience.cameraEvidence(f.identity),null);if(view)assert.equal(f.visual.contextCurrent(view),false);
    f.providerHealth(true);assert.equal(f.visual.state(actor).captureActive,true);assert.equal(f.audience.snapshot(f.identity).privateAllowed,false);assert.equal(f.prepare(),null,'health recovery requires a new accepted scene/count');
  }
});

test('provider health loss is fenced both during pending completion and before a new submission',async t=>{
  for(const pendingCompletion of [true,false]){
    const f=cameraAudienceFixture(t);await f.batch('one',20);f.qualify();
    if(pendingCompletion){const gate=f.holdNext(),pending=f.batch('one',1000);await gate.entered;f.providerHealth(false);gate.release();assert.equal((await pending).result.reason,'provider_unavailable');}
    else {f.providerHealth(false);await assert.rejects(()=>f.batch('one',1000,0,false,true),(error:unknown)=>error instanceof VisualAdmissionError&&error.reason==='provider_unavailable');}
    assert.equal(f.audience.snapshot(f.identity).privateAllowed,false,'no subsequent camera-state read is needed');assert.equal(f.audience.cameraEvidence(f.identity),null);
  }
});

function publicationFixture(t:import('node:test').TestContext){
  const epoch=Date.parse('2026-09-29T12:00:00Z');let mono=10_000,generation=1;
  let status:VisualPerceptionResult['status']='complete',providerReason:string|null=null,clockFailure=false;
  let afterProviderClock:(()=>void)|undefined,nextClock:(()=>void)|undefined;
  let last:VisualPerceptionRequest|undefined,raw:VisualPerceptionResult|undefined;
  const visual=new VisualInputHost({
    provider:fixtureVisualProvider(request=>{
      last=request;nextClock=afterProviderClock;afterProviderClock=undefined;
      return raw={requestId:request.requestId,status,reason:providerReason,observations:status==='complete'?[{observationId:'synthetic-observation',frameIds:[request.frames[0]!.frameId],appearance:'PRIVATE_SCENE_SENTINEL',inference:'PRIVATE_INFERENCE_SENTINEL',confidence:null,limitations:['PRIVATE_LIMITATION_SENTINEL']}]:[]};
    }),
    scopeFor:request=>({...request,relationshipId:null,environmentId:'test',conversationId:'conversation',endpointId:'endpoint',sessionRevision:1,audienceRevision:generation,scopeGeneration:1}),
    sourceFor:()=>({bindingRef:'synthetic-source',connected:true,configurationRevision:1}),captureAuthority:()=>authority,
    monotonicMs:()=>mono,utcMs:()=>{const change=nextClock;nextClock=undefined;change?.();if(clockFailure)throw Error('synthetic diagnostic clock failure');return epoch+mono;}
  });
  t.after(()=>visual.close());
  const begin=(owner=actor)=>{
    const offer=visual.capabilities(owner,['1.0.0']);mono+=20;const mappingMono=mono;
    const lease=visual.camera(owner,{action:'enable',expectedRevision:offer.camera.revision,idempotencyKey:randomUUID(),challengeId:offer.negotiation!.challenge!.id,endpointClockId:'clock',endpointReceivedMonotonicMs:5000});
    let sequence=0;
    return {owner,lease,batch:(correlationId=randomUUID())=>{
      const frameId=randomUUID();return visual.batch(owner,{leaseId:lease.leaseId!,endpointClockId:'clock',correlationId,frames:[{frameId,sequence:sequence++,capturedMonotonicMs:5000+mono-mappingMono,clockMappingId:lease.clockMappingId!,mediaType:'image/png',sha256:createHash('sha256').update(png).digest('hex')}]},new Map([[frameId,png]]));
    }};
  };
  const prepare=()=>visual.prepareContext(actor,{expectedConversationId:'conversation',expectedRelationshipId:null,viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),conversation:'[]',explicitQuestion:true,allowAside:false});
  return {visual,begin,prepare,last:()=>last!,raw:()=>raw!,advance:(ms:number)=>{mono+=ms;},outcome:(value:VisualPerceptionResult['status'],reason:string|null=null)=>{status=value;providerReason=reason;},beforePublication:(action:'scope'|'expiry')=>{afterProviderClock=()=>{if(action==='scope')generation++;else mono+=6001;};},failDiagnosticClock:()=>{afterProviderClock=()=>{clockFailure=true;};},restoreClock:()=>{clockFailure=false;}};
}

test('publication receipts separate successful interpretation from authority and freshness loss before publication',async t=>{
  for(const race of ['scope','expiry'] as const){
    const f=publicationFixture(t),session=f.begin();f.advance(20);f.beforePublication(race);
    const wire=await session.batch();assert.equal(wire.result.status,'complete','runtime interpretation settled successfully before the host race');
    assert.equal(f.prepare(),null,'neither loss may publish a usable scene');
    const receipts=f.visual.publicationReceipts(actor);assert.equal(receipts.length,1);
    const receipt=receipts[0]!;assert.equal(receipt.perceptionStatus,'complete');assert.equal(receipt.disposition,'discarded');
    assert.equal(receipt.reason,race==='scope'?'observation_not_admitted':'observation_expired');assert.equal(receipt.publication,null);assert.deepEqual(receipt.observationIds,[]);
    assert.equal(receipt.admission.requestId,wire.requestId);assert.equal(receipt.admission.capturedAtEarliestMs,f.last().capturedAtEarliestMs);
    assert.deepEqual(Object.keys(wire).sort(),['queued','requestId','result']);assert.deepEqual(Object.keys(wire.result).sort(),['observations','reason','requestId','status'],'closed HTTP response is unchanged');
  }
});

test('publication receipts distinguish empty withdrawal, unsuccessful perception and authentic foreground deferral',async t=>{
  const f=publicationFixture(t),session=f.begin();f.advance(20);
  f.outcome('empty');await session.batch();let receipt=f.visual.publicationReceipts(actor).at(-1)!;
  assert.equal(receipt.disposition,'withdrawn');assert.equal(receipt.reason,'no_observations');assert.equal(receipt.perceptionStatus,'empty');
  f.advance(1000);f.outcome('failed','foreground_priority');await session.batch();receipt=f.visual.publicationReceipts(actor).at(-1)!;
  assert.equal(receipt.disposition,'discarded');assert.equal(receipt.reason,'perception_unsuccessful','provider text cannot manufacture a scheduler receipt');assert.equal(receipt.perceptionStatus,'failed');
  const camera=cameraAudienceFixture(t);await camera.batch('one',20);camera.qualify();
  const occupied=await camera.occupyOtherSession(),pending=camera.batch('one',1000);camera.optionalWork(false);occupied.release();await occupied.pending;await pending;
  const deferred=camera.visual.publicationReceipts(actor).at(-1)!;assert.equal(deferred.disposition,'deferred');assert.equal(deferred.reason,'scheduler_deferral');assert.equal(camera.audience.snapshot(camera.identity).privateAllowed,true);
});

test('publication receipt retains admitted and rebound audience revisions without renewing capture freshness',async t=>{
  const f=cameraAudienceFixture(t);await f.batch('multiple',20);
  const receipt=f.visual.publicationReceipts(actor)[0]!,view=f.prepare();assert.ok(view);
  assert.equal(receipt.disposition,'published');assert.equal(receipt.admission.scope.audienceRevision,f.last().scope.audienceRevision);
  assert.ok(receipt.publication!.audienceRevision>receipt.admission.scope.audienceRevision);
  assert.ok(receipt.publication!.leaseRevision>receipt.admission.leaseRevision);
  assert.equal(receipt.publication!.audienceRevision,view.scope.audienceRevision);
  assert.equal(receipt.admission.capturedAtEarliestMs,f.last().capturedAtEarliestMs);assert.equal(receipt.captureFreshUntilMs,view.expiresAtMs);
  assert.deepEqual(receipt.observationIds,['synthetic-scene']);assert.deepEqual(receipt.admission.frameIds,view.observations[0]!.frameIds);
  f.at(Date.parse(f.audience.cameraEvidence(f.identity)!.expiresAt));f.audience.tick();
  assert.deepEqual(f.visual.publicationReceipts(actor)[0],receipt,'later count expiry cannot rewrite historical publication metadata');
});

test('publication journal is immutable, actor isolated and contains no scene, raw media or arbitrary provider reason',async t=>{
  const f=publicationFixture(t),session=f.begin();f.advance(20);
  await session.batch('PRIVATE_CORRELATION_SENTINEL'.repeat(1000));
  const receipts=f.visual.publicationReceipts(actor),receipt=receipts[0]!;
  assert.match(receipt.admission.correlationId,/^sha256:[a-f0-9]{64}$/u);
  assert.throws(()=>{(receipt.admission.scope as any).audienceRevision=999;},TypeError);
  assert.throws(()=>{(receipt.admission.frameIds as string[]).push('forged');},TypeError);
  assert.throws(()=>{(receipt.observationIds as string[]).push('forged');},TypeError);
  assert.throws(()=>{(receipts as unknown[]).length=0;},TypeError);
  (f.raw().observations[0] as any).appearance='LATE_PRIVATE_MUTATION';
  for(const key of ['principalId','sessionId','assistantId'] as const)assert.deepEqual(f.visual.publicationReceipts({...actor,[key]:'foreign'}),[]);
  f.advance(1000);f.outcome('failed','PRIVATE_PROVIDER_REASON');await session.batch();
  const json=JSON.stringify(f.visual.publicationReceipts(actor));
  for(const prohibited of ['PRIVATE_','LATE_PRIVATE_MUTATION',png.toString('base64'),'appearance','inference','limitations','humanCount','bytes'])assert.equal(json.includes(prohibited),false,prohibited);
  assert.ok(Buffer.byteLength(json)<10_000,'long metadata is represented by bounded labeled digests');
  assert.equal(f.visual.publicationReceipts(actor)[0],receipt);
});

test('publication journal has a host-wide capacity and expires on elapsed time or clock regression',async t=>{
  const f=publicationFixture(t),sessions=Array.from({length:4},(_,index)=>f.begin({...actor,sessionId:`bounded-${index}`}));
  f.outcome('empty');
  const ids:string[]=[];
  for(let round=0;round<34;round++){f.advance(1000);for(const session of sessions)ids.push((await session.batch()).requestId);}
  const retained=sessions.flatMap(session=>f.visual.publicationReceipts(session.owner));assert.equal(retained.length,128);
  assert.ok(retained.every(receipt=>!ids.slice(0,8).includes(receipt.admission.requestId)));assert.ok(retained.some(receipt=>receipt.admission.requestId===ids.at(-1)));
  f.advance(60_000);assert.ok(sessions.every(session=>f.visual.publicationReceipts(session.owner).length===0));
  const next=publicationFixture(t),session=next.begin();next.advance(20);next.outcome('empty');await session.batch();assert.equal(next.visual.publicationReceipts(actor).length,1);
  next.advance(-1);assert.deepEqual(next.visual.publicationReceipts(actor),[]);next.advance(1);assert.deepEqual(next.visual.publicationReceipts(actor),[],'clock recovery cannot restore cleared receipts');
});

test('diagnostic clock failure and shutdown do not change or retain the public batch outcome',async t=>{
  const f=publicationFixture(t),session=f.begin();f.advance(20);f.outcome('empty');f.failDiagnosticClock();
  const wire=await session.batch();assert.equal(wire.result.status,'empty');assert.deepEqual(f.visual.publicationReceipts(actor),[]);
  f.restoreClock();f.advance(1000);await session.batch();assert.equal(f.visual.publicationReceipts(actor).length,1);
  f.visual.close();assert.deepEqual(f.visual.publicationReceipts(actor),[]);
});
