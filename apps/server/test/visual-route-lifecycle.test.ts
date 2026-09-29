import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {request as httpRequest,type Server} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {crc32,deflateSync} from 'node:zlib';
import type {Database} from '@lifestream/storage-sqlite';
import {fixtureVisualProvider} from '@lifestream/runtime/perception/fixture';
import type {VisualPerceptionProvider} from '@lifestream/runtime/perception/port';
import type {CameraState} from '@lifestream/runtime/perception/admission';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {AUTH_PARAMETERS} from '../src/auth/local-auth.ts';
import {readSessionEndpoint} from '../src/runtime/session-context.ts';
import type {VisualActor} from '../src/runtime/visual-input.ts';

function deferred<T>() {
  let resolve!: (value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}

function pixel() {
  const chunk=(type:string,data:Buffer)=>{
    const name=Buffer.from(type),size=Buffer.alloc(4),checksum=Buffer.alloc(4);
    size.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));
    return Buffer.concat([size,name,data,checksum]);
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,0,0,0,255]))),chunk('IEND',Buffer.alloc(0))]);
}

const authority={sourceConnected:true,devicePermission:true,hostCaptureLease:true,interpretationAllowed:true,remoteEgressAllowed:false,foregroundVisible:true};
const emptyProvider=fixtureVisualProvider(request=>({requestId:request.requestId,status:'empty',observations:[],reason:null}));

async function fixture(t:import('node:test').TestContext,provider:VisualPerceptionProvider=emptyProvider) {
  const directory=await mkdtemp(join(tmpdir(),'ls-visual-route-lifecycle-'));
  const config=loadProfile('test');
  config.storage={databasePath:join(directory,'state.sqlite'),artifactDirectory:join(directory,'artifacts')};
  config.authority.authentication='local-password';
  const installerToken=randomBytes(32).toString('hex');
  let now=Date.now(),app:ReturnType<typeof createLifestreamServer>;
  const released:string[]=[];
  app=createLifestreamServer({config,localAuth:{stateDirectory:join(directory,'auth'),installerToken,now:()=>now},audiencePrivacy:{sourceIds:[]},visualInput:{
    provider,
    scopeFor:(actor:VisualActor)=>{
      const database=(app as unknown as {database:Database}).database;
      const session=readSessionEndpoint(database,actor.sessionId);
      const row=database.connection.prepare("SELECT conversation_id AS conversationId FROM sessions WHERE id=? AND status='active'").get(actor.sessionId) as {conversationId:string}|undefined;
      if(!session.endpoint||!row)return null;
      return {...actor,relationshipId:null,environmentId:'synthetic-route-test',conversationId:row.conversationId,endpointId:session.endpoint.endpointId,sessionRevision:session.revision,audienceRevision:1,scopeGeneration:1};
    },
    sourceFor:()=>({bindingRef:'synthetic-route-camera',connected:true,configurationRevision:1}),
    captureAuthority:()=>authority,
    releaseCapture:(_actor,_scope,leaseId)=>released.push(leaseId)
  }});
  t.after(async()=>{await app.shutdown();await rm(directory,{recursive:true,force:true});});
  await app.start();
  const base=`http://127.0.0.1:${app.address().port}`;
  const setup=await fetch(base+'/api/auth/v1/setup',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'owner',password:randomBytes(24).toString('hex'),installerToken})});
  assert.equal(setup.status,201);
  const session=(await setup.json()).session as {sessionId:string;csrfToken:string};
  const headers={origin:base,'content-type':'application/json',cookie:setup.headers.get('set-cookie')!.split(';')[0]!,'x-lifestream-csrf':session.csrfToken};
  const request=(path:string,body:unknown,method='POST')=>fetch(base+path,{method,headers,body:JSON.stringify(body)});
  const created=await(await request('/api/admin/v1/assistants',{displayName:'Synthetic lifecycle Assistant'})).json();
  const assistantId=created.assistantId as string;
  assert.equal((await request(`/api/admin/v1/assistants/${assistantId}/activate`,{profileId:created.profile.profileId,expectedActiveRevision:null})).status,200);
  assert.equal((await request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',bindingKey:randomUUID()})).status,200);
  assert.equal((await request('/api/runtime/v1/audience',{mode:'solo',seconds:300})).status,200);
  const common={schemaVersion:'1.0.0',assistantId};
  const route=(operation:string)=>`/api/runtime/vision/v1/sessions/${session.sessionId}/${operation}`;
  const capabilities=async()=>{
    const response=await request(route('capabilities'),{...common,supportedVersions:['1.0.0']});
    assert.equal(response.status,200,await response.clone().text());
    return response.json() as Promise<{available:boolean;camera:CameraState;negotiation:{challenge:{id:string}}}>;
  };
  const camera=async(body:Record<string,unknown>)=>{
    const response=await request(route('camera'),{...common,idempotencyKey:randomUUID(),...body},'PUT');
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).camera as CameraState;
  };
  const enable=async()=>{
    const offered=await capabilities();
    return camera({action:'enable',expectedRevision:offered.camera.revision,challengeId:offered.negotiation.challenge.id,endpointClockId:'synthetic-clock',endpointReceivedMonotonicMs:performance.now()});
  };
  const batch=(state:CameraState)=>{
    const bytes=pixel(),frameId=randomUUID(),boundary='synthetic-route-boundary';
    const metadata={...common,leaseId:state.leaseId,endpointClockId:'synthetic-clock',correlationId:randomUUID(),frames:[{frameId,sequence:0,capturedMonotonicMs:performance.now(),clockMappingId:state.clockMappingId,mediaType:'image/png',sha256:createHash('sha256').update(bytes).digest('hex')}]};
    const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="${frameId}"\r\nContent-Type: image/png\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const client=httpRequest(base+route('batches'),{method:'POST',headers:{...headers,'content-type':`multipart/form-data; boundary=${boundary}`,'content-length':String(body.length)}});
    client.on('error',()=>{});
    t.after(()=>client.destroy());
    return {client,body};
  };
  return {app,base,headers,request,route,common,released,capabilities,camera,enable,batch,expireAdministration:()=>{now+=AUTH_PARAMETERS.adminIdleMs+1;}};
}

test('disconnecting a visual batch cancels interpretation and releases its exact lease',{timeout:15_000},async t=>{
  const entered=deferred<void>(),aborted=deferred<void>();
  const provider:VisualPerceptionProvider={...emptyProvider,interpret:async(request,signal)=>{
    entered.resolve();
    return new Promise(resolve=>signal.addEventListener('abort',()=>{aborted.resolve();resolve({requestId:request.requestId,status:'cancelled',observations:[],reason:'cancelled'});},{once:true}));
  }};
  const f=await fixture(t,provider),state=await f.enable();
  const upload=f.batch(state);upload.client.end(upload.body);
  await entered.promise;
  upload.client.destroy();
  await aborted.promise;
  assert.deepEqual(f.released,[state.leaseId]);
  const after=await f.capabilities();
  assert.equal(after.camera.captureActive,false);
  assert.equal(after.camera.leaseId,null);
});

test('an abandoned upload for an old lease cannot withdraw its successor',{timeout:15_000},async t=>{
  const f=await fixture(t),first=await f.enable(),received=deferred<void>();
  const server=(f.app as unknown as {server:Server}).server;
  server.once('request',()=>received.resolve());
  const oldUpload=f.batch(first),closed=deferred<void>();
  oldUpload.client.once('close',()=>closed.resolve());
  oldUpload.client.write(oldUpload.body.subarray(0,oldUpload.body.length-10));
  await received.promise;
  await f.camera({action:'stop',leaseId:first.leaseId,expectedRevision:first.revision});
  const successor=await f.enable();
  oldUpload.client.destroy();await closed.promise;
  const after=await f.capabilities();
  assert.equal(after.camera.leaseId,successor.leaseId);
  assert.equal(after.camera.captureActive,true);
  assert.deepEqual(f.released,[first.leaseId]);
});

test('camera capability, renewal and exact stop use conversation auth after administration expires',{timeout:15_000},async t=>{
  const f=await fixture(t),started=await f.enable();
  f.expireAdministration();
  const admin=await fetch(f.base+'/api/admin/v1/assistants',{headers:f.headers});
  assert.equal(admin.status,401,'the test must actually cross the administration idle boundary');
  const offered=await f.capabilities();
  assert.equal(offered.available,true);
  assert.equal(offered.camera.leaseId,started.leaseId);
  const renewed=await f.camera({action:'renew',leaseId:started.leaseId,expectedRevision:offered.camera.revision,challengeId:offered.negotiation.challenge.id,endpointClockId:'synthetic-clock',endpointReceivedMonotonicMs:performance.now()});
  assert.equal(renewed.leaseId,started.leaseId);
  assert.equal(renewed.captureActive,true);
  const stopped=await f.camera({action:'stop',leaseId:started.leaseId,expectedRevision:0});
  assert.equal(stopped.captureActive,false);
  assert.deepEqual(f.released,[started.leaseId]);
});
