import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Database} from '@lifestream/storage-sqlite';
import {FixtureInferenceProvider} from '@lifestream/runtime/inference/fixture';
import type {InferenceRequest,ProviderCallContext} from '@lifestream/runtime/inference/port';
import {fixtureVisualProvider} from '@lifestream/runtime/perception/fixture';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {readSessionEndpoint} from '../src/runtime/session-context.ts';
import type {VisualActor,VisualInputOptions} from '../src/runtime/visual-input.ts';

const wireProfile='lifestream.visual-input-http';
const authority={sourceConnected:true,devicePermission:true,hostCaptureLease:true,interpretationAllowed:true,remoteEgressAllowed:false,foregroundVisible:true};
type VisualMode='default'|'unconfigured'|'fixture';

async function fixture(t:import('node:test').TestContext,mode:VisualMode) {
  const directory=await mkdtemp(join(tmpdir(),'ls-visual-compatibility-'));
  const config=loadProfile('test');
  config.storage={databasePath:join(directory,'state.sqlite'),artifactDirectory:join(directory,'artifacts')};
  config.authority.authentication='local-password';
  const installerToken=randomBytes(32).toString('hex');
  let app:ReturnType<typeof createLifestreamServer>,calls=0,releases=0;
  const visualInput:VisualInputOptions={
    ...(mode==='fixture'?{provider:fixtureVisualProvider(request=>{calls++;return {requestId:request.requestId,status:'empty',observations:[],reason:null};})}:{}),
    scopeFor:(actor:VisualActor)=>{
      const database=(app as unknown as {database:Database}).database;
      const endpoint=readSessionEndpoint(database,actor.sessionId);
      const row=database.connection.prepare("SELECT conversation_id AS conversationId FROM sessions WHERE id=? AND status='active'").get(actor.sessionId) as {conversationId:string}|undefined;
      if (!endpoint.endpoint || !row) return null;
      return {...actor,relationshipId:null,environmentId:'synthetic-compatibility',conversationId:row.conversationId,endpointId:endpoint.endpoint.endpointId,sessionRevision:endpoint.revision,audienceRevision:1,scopeGeneration:1};
    },
    sourceFor:()=>({bindingRef:'synthetic-source-only',connected:true,configurationRevision:1}),
    captureAuthority:()=>authority,releaseCapture:()=>{releases++;}
  };
  const options={config,localAuth:{stateDirectory:join(directory,'auth'),installerToken},audiencePrivacy:{sourceIds:[]},...(mode==='default'?{}:{visualInput})};
  app=createLifestreamServer(options);await app.start();
  t.after(async()=>{await app.shutdown();await rm(directory,{recursive:true,force:true});});
  const port=app.address().port,base=`http://127.0.0.1:${port}`;
  const headers:Record<string,string>={origin:base,'content-type':'application/json'};
  const request=(path:string,body?:unknown,method=body===undefined?'GET':'POST')=>fetch(base+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
  const setup=await request('/api/auth/v1/setup',{username:'owner',password:randomBytes(24).toString('hex'),installerToken});
  assert.equal(setup.status,201);
  headers.cookie=setup.headers.get('set-cookie')!.split(';')[0]!;
  const session=(await setup.json()).session as {sessionId:string;principalId:string;csrfToken:string};
  headers['x-lifestream-csrf']=session.csrfToken;
  const created=await(await request('/api/admin/v1/assistants',{displayName:'Synthetic compatibility Assistant'})).json();
  const assistantId=created.assistantId as string;
  assert.equal((await request(`/api/admin/v1/assistants/${assistantId}/activate`,{profileId:created.profile.profileId,expectedActiveRevision:null})).status,200);
  assert.equal((await request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',bindingKey:randomUUID()})).status,200);
  const audience=async()=>assert.equal((await request('/api/runtime/v1/audience',{mode:'solo',seconds:300})).status,200);
  await audience();
  const route=(operation:string)=>`/api/runtime/vision/v1/sessions/${session.sessionId}/${operation}`;
  const common={schemaVersion:'1.0.0',assistantId};
  const capabilities=async(supportedVersions=['1.0.0'])=>{
    const response=await request(route('capabilities'),{...common,supportedVersions});
    assert.equal(response.status,200,await response.clone().text());
    const value=await response.json();
    assert.equal(value.wireProfile,wireProfile);assert.equal(value.schemaVersion,'1.0.0');
    return value;
  };
  const text=async(input:string)=>{
    // Deliberately retain the existing text request shape, with no visual fields.
    const response=await request('/api/runtime/v1/messages',{assistantId,userInput:input});
    assert.equal(response.status,200,await response.clone().text());
    const events=await response.text();
    assert.match(events,/event: interaction.completed/);
    assert.doesNotMatch(events,/event: interaction.error/);
    const delta=events.split('\n\n').filter(block=>block.startsWith('event: message.delta\n')).map(block=>JSON.parse(block.split('\ndata: ')[1]!).text).join('');
    assert.equal(delta,`Fixture response: ${input}`);
    return events;
  };
  const snapshot=()=>{
    const database=(app as unknown as {database:Database}).database;
    return database.connection.prepare('SELECT id,conversation_id,status,revision FROM sessions WHERE id=?').get(session.sessionId);
  };
  return {request,route,common,session,capabilities,text,audience,snapshot,calls:()=>calls,releases:()=>releases,restart:async()=>{await app.shutdown();app=createLifestreamServer({...options,port});await app.start();}};
}

test('unavailable visual input preserves ordinary text requests and repeated delivery',{timeout:15_000},async t=>{
  for (const mode of ['default','unconfigured'] as const) {
    await t.test(mode,async child=>{
      const f=await fixture(child,mode);
      await f.text('SYNTHETIC_LEGACY_TEXT');
      const before=f.snapshot(), offered=await f.capabilities();
      assert.equal(offered.available,false);
      assert.equal(offered.reason,mode==='default'?'source_unavailable':'unconfigured');
      assert.equal(offered.camera.captureActive,false);
      if (mode==='unconfigured') {
        assert.equal(offered.negotiation.selectedVersion,null);
        assert.equal(offered.negotiation.challenge,null);
      }
      const enabled=await f.request(f.route('camera'),{...f.common,action:'enable',expectedRevision:0,idempotencyKey:randomUUID(),challengeId:randomUUID(),endpointClockId:'synthetic-clock',endpointReceivedMonotonicMs:performance.now()},'PUT');
      assert.equal(enabled.status,503);
      await f.text('SYNTHETIC_LEGACY_TEXT');
      assert.deepEqual(f.snapshot(),before,'visual rejection leaves the ordinary session unchanged');
      assert.equal(f.calls(),0);
      assert.equal(f.releases(),0);
    });
  }
});

test('unsupported visual version never invokes perception and leaves the legacy text path usable',{timeout:15_000},async t=>{
  const f=await fixture(t,'fixture');
  await f.text('Before unsupported visual negotiation.');
  const before=f.snapshot(), offered=await f.capabilities(['0.9.0']);
  assert.equal(offered.available,false);assert.equal(offered.reason,'unsupported');
  assert.equal(offered.negotiation.selectedVersion,null);assert.equal(offered.negotiation.challenge,null);
  assert.equal(offered.camera.captureActive,false);
  const response=await f.request(f.route('camera'),{...f.common,action:'enable',expectedRevision:0,idempotencyKey:randomUUID(),challengeId:randomUUID(),endpointClockId:'synthetic-clock',endpointReceivedMonotonicMs:performance.now()},'PUT');
  assert.equal(response.status,422);
  await f.text('After unsupported visual negotiation.');
  assert.deepEqual(f.snapshot(),before);
  assert.equal(f.calls(),0);assert.equal(f.releases(),0);
});

test('restart retires the synthetic camera lease while preserving ordinary authenticated session semantics',{timeout:15_000},async t=>{
  const inputs:InferenceRequest[]=[];
  const generate=FixtureInferenceProvider.prototype.generate;
  t.mock.method(FixtureInferenceProvider.prototype,'generate',async function*(this:FixtureInferenceProvider,input:InferenceRequest,context:ProviderCallContext){inputs.push(structuredClone(input));yield* generate.call(this,input,context);});
  const f=await fixture(t,'fixture');
  await f.text('SYNTHETIC_VOLATILE_DIALOGUE');
  const offered=await f.capabilities();
  const enable={...f.common,action:'enable',expectedRevision:offered.camera.revision,idempotencyKey:randomUUID(),challengeId:offered.negotiation.challenge.id,endpointClockId:'synthetic-clock',endpointReceivedMonotonicMs:performance.now()};
  const response=await f.request(f.route('camera'),enable,'PUT');
  assert.equal(response.status,200,await response.clone().text());
  const prior=(await response.json()).camera;
  assert.equal(prior.captureActive,true);
  await f.text('Continue the ordinary text conversation.');
  assert.match(inputs.at(-1)!.sections.find(section=>section.kind==='conversation')!.content,/SYNTHETIC_VOLATILE_DIALOGUE/);
  const before=f.snapshot();
  assert.equal(f.releases(),0,'ordinary text does not revoke separately enabled synthetic capture');
  await f.restart();
  assert.equal(f.releases(),1,'shutdown releases the exact synthetic lease');
  assert.deepEqual(f.snapshot(),before,'authentication and conversation identity survive server restart');
  // Existing privacy behavior requires a fresh audience declaration after restart.
  await f.audience();
  const restarted=await f.capabilities();
  assert.equal(restarted.camera.captureActive,false);assert.equal(restarted.camera.leaseId,null);
  const renew=await f.request(f.route('camera'),{...f.common,action:'renew',expectedRevision:restarted.camera.revision,idempotencyKey:randomUUID(),leaseId:prior.leaseId,challengeId:restarted.negotiation.challenge.id,endpointClockId:'synthetic-clock',endpointReceivedMonotonicMs:performance.now()},'PUT');
  assert.equal(renew.status,409);
  assert.equal((await renew.json()).code,'stale_lease');
  const repeatedEnable=await f.request(f.route('camera'),enable,'PUT');
  assert.equal(repeatedEnable.status,422,'an old enable challenge cannot silently restart capture');
  await f.text('Ordinary text after restart.');
  assert.doesNotMatch(inputs.at(-1)!.sections.find(section=>section.kind==='conversation')!.content,/SYNTHETIC_VOLATILE_DIALOGUE/,'volatile dialogue is not secretly made durable by vision');
  assert.equal(f.calls(),0,'negotiation and enablement alone never interpret pixels');
});
