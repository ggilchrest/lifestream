import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {defaultVoiceSettings} from '../src/runtime/voice-settings.ts';
import {savedVoiceFixture} from './saved-voice-fixture.ts';

// Authenticated HTTP + real SQLite/ownership machinery. Only inference, generated
// PCM and STT presence are synthetic; no microphone, speaker or renderer opens.
async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'ls-presence-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=join(root,'packs'),pack=join(directory,'synthetic-reference');await mkdir(pack,{recursive:true});
 const model=Buffer.from(JSON.stringify({asset:{version:'2.0'},scenes:[{nodes:[0]}],nodes:[{name:'Reference'}],scene:0}));
 await writeFile(join(pack,'model.gltf'),model);
 await writeFile(join(pack,'manifest.json'),JSON.stringify({schemaVersion:'1.0.0',id:'synthetic-reference',version:'1',label:'Synthetic reference',renderer:'three-glb.v1',model:'model.gltf',resources:[{path:'model.gltf',sha256:createHash('sha256').update(model).digest('hex'),bytes:model.length,mime:'model/gltf+json'}],framing:{distance:1.2,targetHeight:.5},animations:{},capabilities:{lipSync:'none',facialAnimation:false},fallback:'neutral'}));
 await writeFile(join(directory,'index.json'),JSON.stringify(['synthetic-reference']));
 const provider=await savedVoiceFixture();t.after(provider.close);
 const config=loadProfile('test');config.providers.tts='voxcpm';config.ttsProfile=provider.profile;config.authority.authentication='local-password';config.storage={databasePath:join(root,'state.sqlite'),artifactDirectory:join(root,'artifacts')};
 const password=randomBytes(24).toString('hex'),installerToken=randomBytes(32).toString('hex');
 const options={config,localAuth:{stateDirectory:join(root,'auth'),installerToken},audiencePrivacy:{sourceIds:[]},presentationPackages:{directory},sessionEnvironmentId:randomUUID()};
 let app=createLifestreamServer(options);await app.start();t.after(()=>app.shutdown());const port=app.address().port,base=`http://127.0.0.1:${port}`;
 const json=async(response:Response,status=200)=>{const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;};
 const client=async(setup=false)=>{
  const headers:Record<string,string>={origin:base,'content-type':'application/json'};
  const request=(path:string,body?:unknown)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
  const response=await request('/api/auth/v1/'+(setup?'setup':'sign-in'),{username:'owner',password,...(setup?{installerToken}:{})});
  headers.cookie=response.headers.get('set-cookie')!.split(';')[0]!;const {session}=await json(response,setup?201:200);headers['x-lifestream-csrf']=session.csrfToken;
  const read=async(path:string,body?:unknown,status=200)=>json(await request(path,body),status);
  return {request,read,headers,sessionId:session.sessionId};
 };
 const source=await client(true),target=await client();
 for(const c of [source,target]){await c.read('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',bindingKey:randomUUID()});await c.read('/api/runtime/v1/audience',{mode:'solo',seconds:300});}
 const created=await source.read('/api/admin/v1/assistants',{displayName:'Synthetic presence Assistant'},201),assistantId=created.assistantId;
 await source.read(`/api/admin/v1/assistants/${assistantId}/activate`,{profileId:created.profile.profileId,expectedActiveRevision:null});
 const inspect=(c=source)=>c.read('/api/runtime/v1/endpoint-configuration?assistantId='+assistantId);
 const preview=async(c=source,voiceRef?:string)=>{
  const response=await c.request('/api/runtime/v1/tts',{assistantId,...(voiceRef?{voiceRef}:{}),text:'Synthetic joined presence preview.'});assert.equal(response.status,200);
  const events=(await response.text()).trim().split('\n').map(JSON.parse);assert.equal(events.at(-1).outcome,'succeeded');
  const report={type:'playbackSettled',interactionTraceId:response.headers.get('x-lifestream-playback-trace'),outcome:'completed',receivedSamples:events.filter(e=>e.kind==='data').reduce((sum,e)=>sum+e.frame.sampleCount,0)};
  return {events,settle:()=>c.read('/api/runtime/v1/tts/playback',report)};
 };
 const ready=()=>target.read('/api/runtime/v1/handoff',{assistantId,operation:'ready'});
 const prepare=async()=>source.read('/api/runtime/v1/handoff',{assistantId,operation:'prepare',destinationReadinessId:(await ready()).readinessId});
 const commit=(review:any)=>source.request(`/api/runtime/v1/sessions/${source.sessionId}/handoff`,review.request);
 const delayedSelection=async()=>{
  let entered:()=>void=()=>{};const started=new Promise<void>(resolve=>{entered=resolve;});(app as any).server.once('request',entered);
  let finish:(status:number)=>void=()=>{};const status=new Promise<number>(resolve=>{finish=resolve;});
  const request=httpRequest(base+'/api/runtime/v1/presentation',{method:'POST',headers:{...source.headers,'transfer-encoding':'chunked'}},response=>{response.resume();response.on('end',()=>finish(response.statusCode!));});request.on('error',()=>finish(0));t.after(()=>request.destroy());request.flushHeaders();await started;
  return {finish:async(body:unknown)=>{request.end(JSON.stringify(body));return status;}};
 };
 return {get app(){return app;},source,target,client,assistantId,inspect,preview,prepare,commit,pack,provider,delayedSelection,restart:async()=>{await app.shutdown();app=createLifestreamServer({...options,port});await app.start();}};
}

test('joined presence keeps global identity/voice and endpoint choices independent through handoff and restart',{timeout:20000},async t=>{
 const f=await fixture(t),path='/api/runtime/v1/session-definition',presentation='/api/runtime/v1/presentation';
 const original=await f.inspect(),catalog=await f.source.read(presentation),pack=catalog.packages[0];assert.ok(pack);
 const originalProfile=(await f.source.read(`/api/admin/v1/assistants/${f.assistantId}`)).profiles.find((p:any)=>p.status==='active');
 const definition={schemaVersion:'1.0.0',mode:'audio',audienceScope:'authenticatedSession'};
 assert.equal((await f.target.request(path,{operation:'preview',definition,expectedRevision:1})).status,409,'unconfigured STT does not silently negotiate audio');
 (f.app as any).providers.stt={}; // Presence only, never invoked as speech recognition.
 const reviewed=await f.target.read(path,{operation:'preview',definition,expectedRevision:1});
 assert.deepEqual((await f.inspect(f.target)).modalities.negotiatedInput,['text']);
 await f.target.read(path,{operation:'apply',definition,expectedRevision:1,reviewDigest:reviewed.reviewDigest});
 await f.source.read(presentation,{scope:'default',id:pack.id,digest:pack.digest,expectedRevision:0});
 await f.target.read(presentation,{scope:'default',id:'neutral',digest:'neutral-v1',expectedRevision:0});
 await f.target.read(presentation,{scope:'session',id:pack.id,digest:pack.digest,expectedRevision:0});
 let target=await f.inspect(f.target);assert.equal(target.presentation.source,'sessionOverride');assert.equal(target.presentation.selected.digest,pack.digest);assert.deepEqual(target.modalities.negotiatedInput,['text','audio']);
 assert.deepEqual(target.assistant,original.assistant);assert.deepEqual(target.voice,original.voice);
 // Reviewed voice activation changes the existing Assistant profile globally,
 // while neither endpoint's negotiated settings or appearance is replaced.
 const voices=`/api/admin/v1/assistants/${f.assistantId}/voices`,stale=await f.prepare();
 const {voice}=await f.source.read(voices,{label:'Synthetic calm',language:'en',settings:{...defaultVoiceSettings,description:'Calm clear delivery',seed:4}},201);
 const voicePreview=await f.preview(f.source,voice.voiceRef);await voicePreview.settle();
 await f.source.read(voices+'/activate',{voiceRef:voice.voiceRef,previewId:voicePreview.events.at(-1).voicePreview.previewId,reviewed:true,expectedActiveRevision:original.assistant.profileRevision});
 assert.equal((await f.commit(stale)).status,409,'activation invalidates a review of the previous profile');
 const source=await f.inspect();target=await f.inspect(f.target);
 assert.equal(source.assistant.assistantId,original.assistant.assistantId);assert.equal(source.assistant.profileRevision,2);assert.notEqual(source.assistant.personaRevision,original.assistant.personaRevision);assert.deepEqual(source.assistant,target.assistant);
 const activeProfile=(await f.source.read(`/api/admin/v1/assistants/${f.assistantId}`)).profiles.find((p:any)=>p.status==='active');
 const personaContent=(profile:any)=>Object.fromEntries(Object.entries(profile).filter(([key])=>!['profileId','revision','voiceProfile','createdAt','createdBy','activatedAt'].includes(key)));
 assert.deepEqual(personaContent(activeProfile),personaContent(originalProfile),'voice activation changes the profile revision, not persona or other profile content');
 assert.equal(source.voice.voiceRef,voice.voiceRef);assert.deepEqual(source.voice,target.voice);assert.equal(source.voice.compatible,true);
 assert.deepEqual(source.modalities.negotiatedInput,['text']);assert.deepEqual(target.modalities.negotiatedInput,['text','audio']);
 assert.equal(source.presentation.source,'endpointDefault');assert.equal(target.presentation.source,'sessionOverride');
 // Clear is revisioned inheritance, not deletion of a concurrency boundary.
 await f.target.read(presentation,{operation:'clearSessionOverride',expectedRevision:1});
 assert.equal((await f.target.request(presentation,{scope:'session',id:pack.id,digest:pack.digest,expectedRevision:0})).status,409);
 assert.equal((await f.inspect(f.target)).presentation.selected.id,'neutral');
 await f.target.read(presentation,{scope:'session',id:pack.id,digest:pack.digest,expectedRevision:2});
 await (await f.source.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'SYNTHETIC_PRESENCE_CONTINUITY'})).text();
 const before=await f.inspect(f.target),review=await f.prepare(),moved=await f.commit(review);assert.equal(moved.status,200,await moved.clone().text());
 const result=await moved.json();assert.equal(result.result.newLease,null);assert.equal(result.result.authorization.grantsTransferred,false);
 target=await f.inspect(f.target);assert.deepEqual(target.assistant,before.assistant);assert.deepEqual(target.voice,before.voice);assert.deepEqual(target.presentation,before.presentation);assert.deepEqual(target.modalities,before.modalities);assert.equal(target.session.endpointId,before.session.endpointId);assert.equal(target.session.revision,before.session.revision+1);
 assert.equal((await f.source.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'Ended source'})).status,409);
 // Missing pinned appearance after restart does not gate text or synthetic audio.
 await rm(join(f.pack,'model.gltf'));await f.restart();assert.equal((await f.target.request('/api/runtime/v1/endpoint-configuration?assistantId='+f.assistantId)).status,403);
 await f.target.read('/api/runtime/v1/audience',{mode:'solo',seconds:300});target=await f.inspect(f.target);
 assert.equal(target.presentation.available,false);assert.equal(target.presentation.selected.digest,pack.digest);assert.equal(target.voice.voiceRef,voice.voiceRef);assert.equal(target.audioOwnership.active,false);
 const text=await f.target.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'Continue without an appearance.'});assert.match(await text.text(),/interaction.completed/);
 const audio=await f.preview(f.target);assert.equal((await f.inspect(f.target)).audioOwnership.active,true);await audio.settle();assert.equal((await f.inspect(f.target)).audioOwnership.active,false);
 const fresh=await f.client();assert.equal((await fresh.read('/api/runtime/v1/session-context')).endpoint,null);assert.equal((await fresh.request('/api/runtime/v1/endpoint-configuration?assistantId='+f.assistantId)).status,403);
});

test('appearance cannot switch while synthesized preview audio still owns endpoint playback',{timeout:15000},async t=>{
 const f=await fixture(t),path='/api/runtime/v1/presentation',pack=(await f.source.read(path)).packages[0];
 const review=await f.prepare(),playing=await f.preview();
 assert.equal((await f.inspect()).audioOwnership.active,true,'synthesis completion is not playback completion');
 assert.equal((await f.commit(review)).status,409,'handoff waits for endpoint playback settlement');
 assert.equal((await f.source.request(path,{scope:'default',id:pack.id,digest:pack.digest,expectedRevision:0})).status,409,'between-turn switching also waits for playback settlement');
 assert.equal((await f.source.read(path)).selection.default,null);
 await playing.settle();await f.source.read(path,{scope:'default',id:pack.id,digest:pack.digest,expectedRevision:0});
 assert.equal((await f.inspect()).presentation.selected.digest,pack.digest);
 assert.equal((await f.commit(await f.prepare())).status,200);
});

for(const changed of ['signedOut','playbackStarted','sessionRevised'] as const)test(`delayed appearance selection cannot cross ${changed}`,{timeout:15000},async t=>{
 const f=await fixture(t),path='/api/runtime/v1/presentation',pack=(await f.source.read(path)).packages[0];
 const delayed=await f.delayedSelection();let playing:Awaited<ReturnType<typeof f.preview>>|undefined;
 if(changed==='signedOut')await f.source.read('/api/auth/v1/sign-out',{});
 if(changed==='playbackStarted')playing=await f.preview();
 if(changed==='sessionRevised')await f.source.read('/api/runtime/v1/session-context',{expectedRevision:1,mode:'text',audienceScope:'authenticatedSession'});
 assert.equal(await delayed.finish({scope:'default',id:pack.id,digest:pack.digest,expectedRevision:0}),changed==='signedOut'?401:409);
 assert.equal((f.app as any).database.connection.prepare('SELECT count(*) AS n FROM presentation_selections').get().n,0,'rejected request cannot persist appearance');
 if(playing)await playing.settle();
});
