import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database,MemoryRepository} from '@lifestream/storage-sqlite';
import {fixtureVisualProvider} from '@lifestream/runtime/perception/fixture';
import {VisualInputHost} from '../src/runtime/visual-input.ts';
import {AutomaticMemory} from '../src/runtime/automatic-memory.ts';
import type {VisualMemorySelection} from '../src/runtime/visual-memory-intake.ts';
import {visualOwner} from '../../../packages/storage-sqlite/test/fixtures/visual-episode.ts';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {readSessionEndpoint} from '../src/runtime/session-context.ts';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+5gz/qwAAAABJRU5ErkJggg==','base64');
function fixture(t:import('node:test').TestContext){
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const db=new Database({path:':memory:'});db.migrate();const owner=visualOwner(),actor={principalId:owner.principalId,assistantId:owner.assistantId,sessionId:randomUUID()},environmentId=randomUUID(),conversationId=randomUUID(),endpointId=randomUUID();
 let mono=10000,utc=Date.now(),generation=1,allowed=true,idle=true,calls=0,status='complete' as 'complete'|'empty'|'failed',family=randomUUID(),selected=true,hook=()=>{},content=()=>true,transform=(value:VisualMemorySelection)=>value;
 const worker=new AutomaticMemory({database:db,memories:new MemoryRepository(db),provider:()=>({revision:'unused',provider:{async *generate(){calls++;yield {kind:'done' as const};}}}),idle:()=>idle,scopeAllowed:()=>allowed,contentAllowed:()=>content(),changed:()=>{}});
 const selection=(observationId:string):VisualMemorySelection=>({reason:'appearanceContinuity',independenceKey:family,observations:[{observationId,subject:{subjectRef:'explicit-synthetic-subject',binding:'userConfirmed',basisRefs:['synthetic-observation-specific-confirmation'],limitations:['Account login does not identify the depicted subject.']},visibility:'inView'}]});
 const queued:string[]=[];
 const visual=new VisualInputHost({provider:fixtureVisualProvider(request=>({requestId:request.requestId,status,observations:status==='complete'?[{observationId:randomUUID(),frameIds:[request.frames[0]!.frameId],appearance:'A confirmed synthetic participant appears to wear a hat.',inference:'A tentative synthetic inference that must not become a user statement.',confidence:null,limitations:['Scripted downstream fixture.']}]:[],reason:null})),
  scopeFor:request=>({...request,relationshipId:owner.relationshipId,environmentId,conversationId,endpointId,sessionRevision:1,audienceRevision:1,scopeGeneration:generation}),sourceFor:()=>({bindingRef:'synthetic-camera',connected:true,configurationRevision:1}),
  captureAuthority:()=>({sourceConnected:true,devicePermission:true,hostCaptureLease:true,interpretationAllowed:true,remoteEgressAllowed:false,foregroundVisible:true}),monotonicMs:()=>mono,utcMs:()=>utc,
  memorySelection:publication=>{assert.ok(Object.isFrozen(publication.batch.observations[0]));hook();return selected?transform(selection(publication.batch.observations[0]!.observationId)):null;}
 },()=>{},()=>undefined,(publication,decision)=>queued.push(worker.queueVisualPublication(publication,decision).state));
 t.after(async()=>{visual.close();await worker.close();db.close();});
 const offer=visual.capabilities(actor,['1.0.0']);mono+=10;t.mock.timers.tick(10);utc=Date.now();const lease=visual.camera(actor,{action:'enable',expectedRevision:0,idempotencyKey:randomUUID(),challengeId:offer.negotiation!.challenge!.id,endpointClockId:'synthetic-clock',endpointReceivedMonotonicMs:5000});
 let sequence=0;
 const batch=()=>{mono+=1100;t.mock.timers.tick(1100);utc=Date.now();const frameId=randomUUID();return visual.batch(actor,{leaseId:lease.leaseId!,endpointClockId:'synthetic-clock',correlationId:randomUUID(),frames:[{frameId,sequence:sequence++,capturedMonotonicMs:mono-5000-10,clockMappingId:lease.clockMappingId!,mediaType:'image/png',sha256:createHash('sha256').update(png).digest('hex')}]},new Map([[frameId,png]]));};
 return {owner,db,worker,visual,queued,batch,calls:()=>calls,enable:()=>{worker.configure(owner,true,0);worker.configureVisual(owner,true,0,86400000);},inspect:()=>worker.inspect(owner).visual,deny:()=>allowed=false,busy:(value:boolean)=>idle=!value,select:(value:boolean)=>selected=value,outcome:(value:typeof status)=>status=value,
  family:()=>family=randomUUID(),invalidate:()=>generation++,stop:()=>visual.camera(actor,{action:'stop',expectedRevision:0,idempotencyKey:randomUUID(),leaseId:lease.leaseId!}),hook:(fn:()=>void)=>hook=fn,content:(fn:()=>boolean)=>content=fn,selection:(fn:typeof transform)=>transform=fn,advance:(ms:number)=>{if(ms>=0){mono+=ms;t.mock.timers.tick(ms);}else t.mock.timers.setTime(Date.now()+ms);utc=Date.now();}};
}

test('validated publication automatically retains typed source at idle with consent and explicit visual association',async t=>{
 const f=fixture(t);f.enable();const result=await f.batch();assert.equal(result.result.status,'complete');assert.deepEqual(f.queued,['queued']);assert.equal(f.inspect().episodes.length,0,'publication does not synchronously persist or await memory');await f.worker.tick();
 const episode=f.inspect().episodes[0]!.episode!;assert.equal(episode.sourceObservationIds[0],result.result.observations[0]!.observationId);assert.equal(episode.observations[0]!.batchId,result.requestId);assert.equal(episode.observations[0]!.confidence,null);assert.equal(episode.observations[0]!.subject.binding,'userConfirmed');assert.equal(episode.memoryRecordId,null);assert.equal(episode.rawMediaRetained,false);
 assert.equal(JSON.stringify(episode).includes(png.toString('base64')),false);assert.equal(JSON.stringify(episode).includes('must not become a user statement'),false);assert.equal(f.calls(),0);assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM automatic_memory_work').get()!.n,0);assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM memories').get()!.n,0);
 assert.deepEqual(f.inspect().intakeReceipts,[{requestId:result.requestId,state:'retained'}]);
 // Same host event family cannot reinforce through a new frame or paraphrase.
 await f.batch();await f.worker.tick();assert.equal(f.inspect().episodes.length,1);
});

test('pending source expires during foreground work and cannot be restored by clock rollback',async t=>{
 const f=fixture(t);f.enable();f.busy(true);const source=await f.batch();f.advance(6000);await f.worker.tick();assert.equal(f.inspect().episodes.length,0);assert.deepEqual(f.inspect().intakeReceipts,[{requestId:source.requestId,state:'sourceExpired'}]);f.advance(-5000);f.busy(false);await f.worker.tick();assert.equal(f.inspect().episodes.length,0);
});

test('unidentified subject, nonexistent observation and malformed family remain ineligible with bounded non-content receipts',async t=>{
 for(const mode of ['unidentified','missingObservation','family'])await t.test(mode,async child=>{
  const f=fixture(child);f.enable();f.selection(value=>{if(mode==='unidentified')value.observations[0]!.subject.binding='unidentified';if(mode==='missingObservation')value.observations=[{...value.observations[0]!,observationId:randomUUID()}];if(mode==='family')value.independenceKey='not-a-uuid';return value;});const source=await f.batch();await f.worker.tick();assert.equal(f.inspect().episodes.length,0);assert.deepEqual(f.inspect().intakeReceipts,[{requestId:source.requestId,state:mode==='unidentified'?'unattributedSubject':'invalidEpisode'}]);
 });
});

test('forget removes retained content and source fences reject a late current reinterpretation of the same event',async t=>{
 const f=fixture(t);f.enable();await f.batch();await f.worker.tick();const row=f.inspect().episodes[0]!;f.worker.forgetVisual(f.owner,row.episodeId,row.revision);await f.batch();await f.worker.tick();assert.equal(f.inspect().episodes.length,1);assert.equal(f.inspect().episodes[0]!.episode,null);assert.equal(f.inspect().intakeReceipts.at(-1)!.state,'duplicateSource');
});

test('only newest current publication survives optional-work contention; foreground reply does not wait',async t=>{
 const f=fixture(t);f.enable();f.busy(true);const first=await f.batch();await f.worker.tick();assert.equal(f.inspect().episodes.length,0);f.family();const latest=await f.batch();f.busy(false);await f.worker.tick();assert.equal(f.inspect().episodes.length,1);assert.equal(f.inspect().episodes[0]!.episode!.observations[0]!.batchId,latest.requestId);assert.notEqual(latest.requestId,first.requestId);
});

test('camera permission alone, absent association and unpublished results never create durable visual memories',async t=>{
 for(const mode of ['noConsent','noVisualConsent','noAssociation','empty','failed'])await t.test(mode,async child=>{
  const f=fixture(child);if(mode==='noVisualConsent')f.worker.configure(f.owner,true,0);else if(mode!=='noConsent')f.enable();if(mode==='noAssociation')f.select(false);if(mode==='empty'||mode==='failed')f.outcome(mode);await f.batch();await f.worker.tick();assert.equal(f.inspect().episodes.length,0);assert.equal(f.calls(),0);
 });
});

test('queued publication cannot cross stop, source change, audience withdrawal, policy change or content-hook revocation',async t=>{
 for(const mode of ['stop','source','audience','visualPolicy','memoryPolicy','contentHook','selectorHook'])await t.test(mode,async child=>{
  const f=fixture(child);f.enable();if(mode==='selectorHook')f.hook(()=>f.stop());await f.batch();
  if(mode==='stop')f.stop();if(mode==='source')f.invalidate();if(mode==='audience')f.deny();if(mode==='visualPolicy')f.worker.configureVisual(f.owner,false,1,86400000);if(mode==='memoryPolicy')f.worker.configure(f.owner,false,1);if(mode==='contentHook')f.content(()=>{f.stop();return true;});
  await f.worker.tick();assert.equal(f.inspect().episodes.length,0);assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM visual_observation_episodes').get()!.n,0);assert.equal(f.calls(),0);
 });
});

test('authenticated HTTP publication reaches consented memory inspection through the server binding',{timeout:15000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'ls-visual-publication-http-'));
 const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'state.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex'),environmentId=randomUUID(),family=randomUUID();
 let app:ReturnType<typeof createLifestreamServer>,relationshipId:string|null=null;
 const internals=()=>app as unknown as {database:Database;automaticMemory:AutomaticMemory};
 app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'auth'),installerToken},audiencePrivacy:{sourceIds:[]},visualInput:{
  provider:fixtureVisualProvider(request=>({requestId:request.requestId,status:'complete',observations:[{observationId:randomUUID(),frameIds:[request.frames[0]!.frameId],appearance:'A synthetic participant appears to wear a hat.',inference:null,confidence:null,limitations:['Scripted interpretation of a one-pixel fixture; no real image understanding.']}],reason:null})),
  scopeFor:actor=>{const db=internals().database,session=readSessionEndpoint(db,actor.sessionId),row=db.connection.prepare("SELECT conversation_id AS conversationId FROM sessions WHERE id=? AND status='active'").get(actor.sessionId) as {conversationId:string}|undefined;
   if(!session.endpoint||!row||!relationshipId)return null;return {...actor,relationshipId,environmentId,conversationId:row.conversationId,endpointId:session.endpoint.endpointId,sessionRevision:session.revision,audienceRevision:1,scopeGeneration:1};},
  sourceFor:()=>({bindingRef:'isolated-synthetic-source',connected:true,configurationRevision:1}),captureAuthority:()=>({sourceConnected:true,devicePermission:true,hostCaptureLease:true,interpretationAllowed:true,remoteEgressAllowed:false,foregroundVisible:true}),
  memorySelection:publication=>({reason:'appearanceContinuity',independenceKey:family,observations:[{observationId:publication.batch.observations[0]!.observationId,subject:{subjectRef:'explicit-synthetic-subject',binding:'userConfirmed',basisRefs:['synthetic-specific-confirmation'],limitations:['Synthetic association, not inferred from account login.']},visibility:'inView'}]})
 }});
 t.after(async()=>{await app.shutdown();await rm(root,{recursive:true,force:true});});await app.start();
 const base=`http://127.0.0.1:${app.address().port}`;let cookie='',csrf='';
 const request=(path:string,body?:unknown,method=body===undefined?'GET':'POST',extra:Record<string,string>={})=>fetch(base+path,{method,headers:{origin:base,cookie,'content-type':'application/json','x-lifestream-csrf':csrf,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const setup=await request('/api/auth/v1/setup',{username:'synthetic',password,installerToken});assert.equal(setup.status,201);cookie=setup.headers.get('set-cookie')!.split(';')[0]!;const identity=(await setup.json()).session;csrf=identity.csrfToken;
 const assistant=await(await request('/api/admin/v1/assistants',{displayName:'Synthetic publication Assistant'})).json(),assistantId=assistant.assistantId as string;
 assert.equal((await request(`/api/admin/v1/assistants/${assistantId}/activate`,{profileId:assistant.profile.profileId,expectedActiveRevision:null})).status,200);
 relationshipId=(await(await request(`/api/admin/v1/assistants/${assistantId}/relationships`,{})).json()).relationship.relationshipId;
 assert.equal((await request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',bindingKey:randomUUID()})).status,200);assert.equal((await request('/api/runtime/v1/audience',{mode:'solo',seconds:300})).status,200);
 const scope={assistantId,relationshipId},memory='/api/runtime/v1/memory',query=memory+'?'+new URLSearchParams({assistantId,relationshipId:relationshipId!});
 assert.equal((await request(memory,{...scope,enabled:true,expectedRevision:0})).status,200);assert.equal((await request(memory,{...scope,operation:'configureVisual',enabled:true,expectedRevision:0,retentionMs:86400000})).status,200);
 const route=(op:string)=>`/api/runtime/vision/v1/sessions/${identity.sessionId}/${op}`,wire={schemaVersion:'1.0.0',assistantId};
 const offered=await request(route('capabilities'),{...wire,supportedVersions:['1.0.0']});assert.equal(offered.status,200,await offered.clone().text());const capability=await offered.json();
 const enabled=await request(route('camera'),{...wire,action:'enable',expectedRevision:0,idempotencyKey:randomUUID(),challengeId:capability.negotiation.challenge.id,endpointClockId:'synthetic-clock',endpointReceivedMonotonicMs:performance.now()},'PUT');assert.equal(enabled.status,200,await enabled.clone().text());const camera=(await enabled.json()).camera;
 const frameId=randomUUID(),metadata={...wire,leaseId:camera.leaseId,endpointClockId:'synthetic-clock',correlationId:randomUUID(),frames:[{frameId,sequence:0,capturedMonotonicMs:performance.now(),clockMappingId:camera.clockMappingId,mediaType:'image/png',sha256:createHash('sha256').update(png).digest('hex')}]},boundary='synthetic-publication-boundary';
 const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n`),Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${frameId}"\r\nContent-Type: image/png\r\n\r\n`),png,Buffer.from(`\r\n--${boundary}--\r\n`)]);
 const published=await fetch(base+route('batches'),{method:'POST',headers:{origin:base,cookie,'x-lifestream-csrf':csrf,'content-type':`multipart/form-data; boundary=${boundary}`},body});assert.equal(published.status,200,await published.clone().text());const receipt=await published.json();assert.equal(receipt.result.status,'complete');
 await internals().automaticMemory.tick();const inspected=await(await request(query)).json();assert.equal(inspected.visual.episodes.length,1,JSON.stringify(inspected.visual));const row=inspected.visual.episodes[0];assert.equal(row.episode.observations[0].batchId,receipt.requestId);assert.equal(row.episode.sourceObservationIds[0],receipt.result.observations[0].observationId);assert.equal(row.episode.memoryRecordId,null);assert.equal(row.episode.rawMediaRetained,false);assert.equal(row.episode.observations[0].confidence,null);assert.deepEqual(inspected.visual.intakeReceipts,[{requestId:receipt.requestId,state:'retained'}]);
 assert.equal((await request(memory,{...scope,operation:'forgetVisual',id:row.episodeId,expectedRevision:row.revision},'POST',{'x-lifestream-csrf':'wrong'})).status,403);
 assert.equal((await request(memory,{...scope,operation:'forgetVisual',id:row.episodeId,expectedRevision:row.revision})).status,200);assert.equal((await(await request(query)).json()).visual.episodes[0].episode,null);
 assert.equal((await request(route('camera'),{...wire,action:'stop',expectedRevision:0,idempotencyKey:randomUUID(),leaseId:camera.leaseId},'PUT')).status,200);
});
