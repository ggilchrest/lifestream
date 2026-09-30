import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixtureVisualProvider} from '@lifestream/runtime/perception/fixture';
import type {InferenceProvider,InferenceRequest} from '@lifestream/runtime/inference';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {readSessionEndpoint} from '../src/runtime/session-context.ts';

const marker='SYNTHETIC_VISUAL_SCENE_AZURE';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+5gz/qwAAAABJRU5ErkJggg==','base64');
const authority={sourceConnected:true,devicePermission:true,hostCaptureLease:true,interpretationAllowed:true,remoteEgressAllowed:false,foregroundVisible:true};

async function fixture(t:import('node:test').TestContext,cameraAudience=false,environmentId?:string,visualEnvironmentId=environmentId){
  const directory=await mkdtemp(join(tmpdir(),'ls-visual-context-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(directory,'state.sqlite'),artifactDirectory:join(directory,'artifacts')};
  let app:ReturnType<typeof createLifestreamServer>,mono=5000,sequence=0,connected=true,visualStatus:'complete'|'empty'|'failed'='complete',visualRelationshipId:string|null=null;
  const epoch=Date.now()-mono,requests:InferenceRequest[]=[];
  let count:'zero'|'one'|'multiple'|'uncertain'|undefined='multiple',providerReason:string|null=null;
  const installerToken=randomBytes(32).toString('hex');
  app=createLifestreamServer({config,...(environmentId?{sessionEnvironmentId:environmentId}:{}),localAuth:{stateDirectory:join(directory,'auth'),installerToken},audiencePrivacy:{sourceIds:[],...(cameraAudience?{cameraSourceIds:['synthetic-camera-count'],now:()=>epoch+mono,monotonicMs:()=>mono}:{})},visualInput:{
    provider:fixtureVisualProvider(request=>visualStatus!=='complete'?{requestId:request.requestId,status:visualStatus,reason:providerReason??(visualStatus==='failed'?'synthetic_provider_failure':null),observations:[]}:({requestId:request.requestId,status:'complete',reason:providerReason,...(cameraAudience&&count?{humanCount:{frameIds:[request.frames[0]!.frameId],classification:count,confidence:null,fieldOfView:'Generated test frame only',coverage:'frameOnly' as const,limitations:['Scripted count; no people observed.']}}:{}),observations:[{observationId:randomUUID(),frameIds:[request.frames[0]!.frameId],appearance:`${marker}: a blue notebook is visible on the table.`,inference:null,confidence:null,limitations:['Scripted observation from a synthetic fixture; no actual image understanding.']}]})),
    scopeFor:actor=>{const database=(app as any).database,current=readSessionEndpoint(database,actor.sessionId),row=database.connection.prepare("SELECT conversation_id AS conversationId FROM sessions WHERE id=? AND status='active'").get(actor.sessionId) as {conversationId:string}|undefined;if(!current.endpoint||!row)return null;return {...actor,relationshipId:visualRelationshipId,environmentId:visualEnvironmentId??'synthetic',conversationId:row.conversationId,endpointId:current.endpoint.endpointId,sessionRevision:current.revision,audienceRevision:cameraAudience?(app as any).audience.snapshot({principalId:actor.principalId,sessionId:actor.sessionId,endpointId:current.endpoint.endpointId}).revision:1,scopeGeneration:1};},
    sourceFor:()=>connected?{bindingRef:'synthetic-camera',connected:true,configurationRevision:1,...(cameraAudience?{audienceSourceId:'synthetic-camera-count'}:{})}:null,
    captureAuthority:()=>authority,monotonicMs:()=>mono,utcMs:()=>epoch+mono
  }});
  await app.start();t.after(()=>app.shutdown());
  const base=`http://127.0.0.1:${app.address().port}`,headers:Record<string,string>={origin:base,'content-type':'application/json'};
  const request=(path:string,body:unknown,method='POST')=>fetch(base+path,{method,headers,body:JSON.stringify(body)});
  const setup=await request('/api/auth/v1/setup',{username:'owner',password:randomBytes(24).toString('hex'),installerToken});assert.equal(setup.status,201);
  headers.cookie=setup.headers.get('set-cookie')!.split(';')[0]!;const session=(await setup.json()).session;headers['x-lifestream-csrf']=session.csrfToken;
  const create=async()=>{const created=await(await request('/api/admin/v1/assistants',{displayName:'Synthetic Visual Context'})).json();assert.equal((await request(`/api/admin/v1/assistants/${created.assistantId}/activate`,{profileId:created.profile.profileId,expectedActiveRevision:null})).status,200);return created.assistantId as string;};
  const assistantId=await create(),otherAssistantId=await create();
  assert.equal((await request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',bindingKey:randomUUID()})).status,200);
  assert.equal((await request('/api/runtime/v1/audience',{mode:'solo',seconds:300})).status,200);
  const setProvider=(provider:InferenceProvider)=>{(app as any).providers.inference=provider;};
  setProvider({async *generate(input){requests.push(input);yield {kind:'text',text:'Synthetic ordinary reply.'};yield {kind:'done'};}});
  const route=(operation:string)=>`/api/runtime/vision/v1/sessions/${session.sessionId}/${operation}`;
  const envelope={schemaVersion:'1.0.0',assistantId};
  const capability=async()=>{const response=await request(route('capabilities'),{...envelope,supportedVersions:['1.0.0']});assert.equal(response.status,200,await response.clone().text());return response.json();};
  const camera=async(action:'enable'|'renew',leaseId?:string)=>{const offer=await capability(),endpointReceivedMonotonicMs=mono;mono+=20;const response=await request(route('camera'),{...envelope,action,expectedRevision:offer.camera.revision,idempotencyKey:randomUUID(),challengeId:offer.negotiation.challenge.id,endpointClockId:'synthetic-clock',endpointReceivedMonotonicMs,...(leaseId?{leaseId}:{})},'PUT');return response;};
  const begin=async()=>{const response=await camera('enable');assert.equal(response.status,200,await response.clone().text());return (await response.json()).camera;};
  const stop=async(state:any)=>{const response=await request(route('camera'),{...envelope,action:'stop',expectedRevision:state.revision,leaseId:state.leaseId,idempotencyKey:randomUUID()},'PUT');assert.equal(response.status,200);return response.json();};
  const batch=async(state:any)=>{
    mono+=20;const frameId=randomUUID(),boundary='synthetic-visual-context',metadata={...envelope,leaseId:state.leaseId,endpointClockId:'synthetic-clock',correlationId:randomUUID(),frames:[{frameId,sequence:sequence++,capturedMonotonicMs:mono-20,clockMappingId:state.clockMappingId,mediaType:'image/png',sha256:createHash('sha256').update(png).digest('hex')}]};
    const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="${frameId}"\r\nContent-Type: image/png\r\n\r\n`),png,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const response=await fetch(base+route('batches'),{method:'POST',headers:{...headers,'content-type':`multipart/form-data; boundary=${boundary}`},body});assert.equal(response.status,200,await response.clone().text());const result=await response.json();assert.equal(result.result.status,visualStatus);return result;
  };
  const turn=async(userInput='What can you see?',selected=assistantId,relationshipId?:string)=>{const response=await request('/api/runtime/v1/messages',{assistantId:selected,userInput,...(relationshipId?{relationshipId}:{})});assert.equal(response.status,200,await response.clone().text());const output=await response.text();assert.match(output,/interaction.completed/,output);assert.ok(requests.length);return requests.at(-1)!;};
  return {app,base,headers,session,assistantId,otherAssistantId,requests,request,route,envelope,begin,camera,capability,batch,stop,turn,setProvider,advance:(ms:number)=>{mono+=ms;},disconnect:()=>{connected=false;},emptyNext:()=>{visualStatus='empty';},failNext:()=>{visualStatus='failed';},bindRelationship:(id:string|null)=>{visualRelationshipId=id;},setCount:(value:typeof count)=>{count=value;},setProviderReason:(value:string|null)=>{providerReason=value;},audience:()=>{const current=readSessionEndpoint((app as any).database,session.sessionId);return (app as any).audience.snapshot({principalId:session.principalId,sessionId:session.sessionId,endpointId:current.endpoint!.endpointId});}};
}

test('synthetic visual HTTP admission supplies only scoped ordinary conversation context and truthful host modality',{timeout:15000},async t=>{
  const f=await fixture(t);const before=await f.turn('Explain an ordinary task.');assert.doesNotMatch(JSON.stringify(before),new RegExp(marker));
  const state=await f.begin();await f.batch(state);
  assert.equal((f.app as any).visualInput.observations.diagnostics().observations,1,'HTTP result must publish to the volatile visual store');
  const visual=await f.turn();assert.equal(visual.sections.length,9);const conversation=visual.sections.find(section=>section.kind==='conversation')!;
  assert.equal(conversation.trusted,false);assert.match(conversation.content,new RegExp(marker));assert.ok(visual.sections.filter(section=>section.kind!=='conversation').every(section=>!section.content.includes(marker)));
  assert.match(visual.sections.find(section=>section.kind==='interactionState')!.content,/input.visual=activeForSession/);
  assert.equal(visual.sections.find(section=>section.kind==='userInput')!.content,'What can you see?');assert.doesNotMatch(JSON.stringify(visual),new RegExp(png.toString('base64')));
  const foreign=await f.turn('What can you see?',f.otherAssistantId);assert.doesNotMatch(JSON.stringify(foreign),new RegExp(marker));assert.equal(foreign.scope.assistantId,f.otherAssistantId);
  await f.stop(state);const after=await f.turn();assert.doesNotMatch(JSON.stringify(after),new RegExp(marker),'a visual observation was never inserted as a user or Assistant history turn');
  const turns=JSON.parse(after.sections.find(section=>section.kind==='conversation')!.content) as {role:string;text:string}[];assert.ok(turns.every(turn=>turn.text!==marker));assert.ok(turns.some(turn=>turn.text==='What can you see?'));
});

test('authenticated inspection reports exact visual selection, omissions and expiry without scene text',{timeout:15000},async t=>{
  const f=await fixture(t),state=await f.begin();await f.batch(state);
  const inspect=async(userInput:string)=>{
    const response=await f.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput,inspect:true,visualSelection:{reason:'FORGED_CLIENT',view:{appearance:'CLIENT_SCENE'}}});
    assert.equal(response.status,200);const stream=await response.text();assert.match(stream,/interaction.completed/);assert.doesNotMatch(stream,/FORGED_CLIENT|CLIENT_SCENE/);
    const inspection=JSON.parse(stream.split('\n\n').find(block=>block.startsWith('event: input.inspection'))!.split('\ndata: ')[1]!);assert.equal(inspection.preparedContext.schemaVersion,'1.0.0');if(inspection.visual.prepared){assert.equal(inspection.preparedContext.viewId,inspection.visual.prepared.viewId);assert.equal(inspection.preparedContext.invalidationKey,inspection.visual.prepared.invalidationKey);}return inspection.visual;
  };
  const selected=await inspect('What can you see?'),request=f.requests.at(-1)!;
  assert.equal(selected.reason,'selected');assert.equal(selected.selected,1);assert.equal(selected.considered,1);assert.equal(selected.prepared.observationIds.length,1);
  assert.equal(selected.prepared.conversationSectionDigest,request.sections.find(item=>item.kind==='conversation')!.contentDigest);
  assert.ok(selected.prepared.expiresAtMs>selected.prepared.selectedAtMs);assert.doesNotMatch(JSON.stringify(selected),new RegExp(marker));assert.doesNotMatch(JSON.stringify(selected),new RegExp(png.toString('base64')));
  const suppressed=await inspect('Help organize the table.');assert.equal(suppressed.reason,'unchanged_scene');assert.equal(suppressed.selected,0);assert.equal(suppressed.omissions.length,1);assert.equal(suppressed.prepared,null);
  const suppressedRequest=f.requests.at(-1)!;assert.match(suppressedRequest.sections[3]!.content,/input.visual=activeForSession/);assert.match(suppressedRequest.sections[0]!.content,/current visual information is unavailable/);
  f.advance(6001);const expired=await inspect('What am I holding?');assert.equal(expired.reason,'expired');assert.equal(expired.selected,0);assert.equal(expired.prepared,null);
  assert.match(f.requests.at(-1)!.sections[0]!.content,/do not guess from earlier dialogue/);assert.doesNotMatch(f.requests.at(-1)!.sections[7]!.content,new RegExp(marker));
});

test('renewal requires a fresh visual result, expiry cannot revive, and a foreign session path is denied',{timeout:15000},async t=>{
  const f=await fixture(t),state=await f.begin();await f.batch(state);assert.match(JSON.stringify(await f.turn()),new RegExp(marker));
  const freshRenewed=await f.camera('renew',state.leaseId);assert.equal(freshRenewed.status,200,await freshRenewed.clone().text());const renewedState=(await freshRenewed.json()).camera;assert.doesNotMatch(JSON.stringify(await f.turn()),new RegExp(marker),'renewal requires a fresh result for its new clock mapping');
  f.advance(1001);await f.batch(renewedState);assert.match(JSON.stringify(await f.turn()),new RegExp(marker));f.advance(6001);assert.doesNotMatch(JSON.stringify(await f.turn()),new RegExp(marker));
  const renewed=await f.camera('renew',state.leaseId);assert.equal(renewed.status,200,await renewed.clone().text());assert.doesNotMatch(JSON.stringify(await f.turn()),new RegExp(marker));
  const wrong=await fetch(f.base+`/api/runtime/vision/v1/sessions/${randomUUID()}/capabilities`,{method:'POST',headers:f.headers,body:JSON.stringify({...f.envelope,supportedVersions:['1.0.0']})});assert.equal(wrong.status,403);
  await f.stop((await renewed.json()).camera);const staleRenewal=await f.camera('renew',state.leaseId);assert.equal(staleRenewal.status,409);
});

test('suppressing repeated scene commentary preserves truthful fresh visual availability',{timeout:15000},async t=>{
  const f=await fixture(t),state=await f.begin();await f.batch(state);
  const first=await f.turn('Help organize the table.');assert.match(first.sections.find(section=>section.kind==='conversation')!.content,new RegExp(marker));
  const second=await f.turn('Continue the ordinary explanation.');
  assert.doesNotMatch(JSON.stringify(second),new RegExp(marker),'completed prior aside suppresses unchanged scene text');
  assert.match(second.sections.find(section=>section.kind==='interactionState')!.content,/input.visual=activeForSession/,'mention suppression does not disable a fresh observation source');
  assert.equal(second.sections.length,9);assert.ok(JSON.parse(second.sections.find(section=>section.kind==='conversation')!.content).length>0);
  await f.stop(state);const stopped=await f.turn('Continue the ordinary explanation.');
  assert.doesNotMatch(stopped.sections.find(section=>section.kind==='interactionState')!.content,/input.visual=activeForSession/);
});

test('ordinary current-topic selection omits unrelated scenes without consuming the next useful aside',{timeout:15000},async t=>{
  const f=await fixture(t),state=await f.begin();await f.batch(state);
  const irrelevant=await f.turn('Explain recursion.');assert.doesNotMatch(irrelevant.sections[7]!.content,new RegExp(marker));assert.match(irrelevant.sections[3]!.content,/input.visual=activeForSession/);
  const relevant=await f.turn('Help me organize the table.');assert.match(relevant.sections[7]!.content,new RegExp(marker));assert.equal(relevant.sections[8]!.content,'Help me organize the table.');
  const repeated=await f.turn('Help me organize the table.');assert.doesNotMatch(repeated.sections[7]!.content,new RegExp(marker));
  const explicit=await f.turn('What is this?');assert.match(explicit.sections[7]!.content,new RegExp(marker),'direct visual question can revisit the same fresh observations');
});

test('stopping capture fences an already prepared ordinary reply before delayed synthetic output',{timeout:15000},async t=>{
  const f=await fixture(t),state=await f.begin();await f.batch(state);let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());
  f.setProvider({async *generate(input){f.requests.push(input);entered();await gate;yield {kind:'text',text:'LATE_VISUAL_DISCLOSURE'};yield {kind:'done'};}});
  const pending=f.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'What can you see?'});await started;assert.match(JSON.stringify(f.requests.at(-1)),new RegExp(marker));
  try{await f.stop(state);}finally{release();}
  const output=await(await pending).text();assert.doesNotMatch(output,/LATE_VISUAL_DISCLOSURE|interaction.completed/);assert.match(output,/runtime_input_stale|cancelled/);
});

test('ordinary text continues with no visual text after source disconnection or audience restriction',{timeout:15000},async t=>{
  const f=await fixture(t),state=await f.begin();await f.batch(state);f.disconnect();assert.doesNotMatch(JSON.stringify(await f.turn()),new RegExp(marker));
  assert.equal((await f.request('/api/runtime/v1/audience',{mode:'shared'})).status,200);const fallback=await f.turn('Explain an ordinary task.');assert.doesNotMatch(JSON.stringify(fallback),new RegExp(marker));assert.doesNotMatch(fallback.sections.find(section=>section.kind==='interactionState')!.content,/input.visual=activeForSession/);
});

test('a newer empty interpretation removes future selection without cancelling an already admitted fresh visual reply',{timeout:15000},async t=>{
  const f=await fixture(t),state=await f.begin();await f.batch(state);let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());
  f.setProvider({async *generate(input){f.requests.push(input);entered();await gate;yield {kind:'text',text:'ADMITTED_CURRENT_REPLY'};yield {kind:'done'};}});
  const pending=f.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'What can you see?'});await started;
  try{assert.match(JSON.stringify(f.requests.at(-1)),new RegExp(marker));f.advance(1001);f.emptyNext();await f.batch(state);}finally{release();}
  const output=await(await pending).text();assert.match(output,/ADMITTED_CURRENT_REPLY/);assert.match(output,/interaction.completed/);assert.doesNotMatch(output,/runtime_input_stale/);
  f.setProvider({async *generate(input){f.requests.push(input);yield {kind:'text',text:'No current scene.'};yield {kind:'done'};}});
  assert.doesNotMatch(JSON.stringify(await f.turn()),new RegExp(marker));
});

test('expiry between host preparation check and prompt materialization returns typed conflict without inference',{timeout:15000},async t=>{
  const f=await fixture(t),state=await f.begin();await f.batch(state);
  const host=f.app as any,prepare=host.prepareRuntimeInput.bind(host);
  t.mock.method(host,'prepareRuntimeInput',(...args:any[])=>{
    const input=prepare(...args),current=input.isCurrent;let first=true;
    input.isCurrent=()=>{const admitted=current();if(first){first=false;f.advance(6001);}return admitted;};return input;
  });
  const response=await f.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'What can you see?'});
  assert.equal(response.status,409,await response.clone().text());assert.equal((await response.json()).code,'runtime_context_changed');assert.equal(f.requests.length,0);
});

test('an actual perception failure fences an already prepared visual reply and withholds future visual context',{timeout:15000},async t=>{
  const f=await fixture(t),state=await f.begin();await f.batch(state);let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());
  f.setProvider({async *generate(input){f.requests.push(input);entered();await gate;yield {kind:'text',text:'AFTER_PERCEPTION_FAILURE'};yield {kind:'done'};}});
  const pending=f.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'What can you see?'});await started;
  try{assert.match(JSON.stringify(f.requests.at(-1)),new RegExp(marker));f.advance(1001);f.failNext();await f.batch(state);}finally{release();}
  const output=await(await pending).text();assert.doesNotMatch(output,/AFTER_PERCEPTION_FAILURE|interaction.completed/);assert.match(output,/runtime_input_stale|cancelled/);
  f.setProvider({async *generate(input){f.requests.push(input);yield {kind:'text',text:'Visual interpretation unavailable.'};yield {kind:'done'};}});
  assert.doesNotMatch(JSON.stringify(await f.turn()),new RegExp(marker));
});

test('a visual binding for another relationship is withheld from the same Assistant ordinary conversation',{timeout:15000},async t=>{
  const f=await fixture(t),created=await f.request(`/api/admin/v1/assistants/${f.assistantId}/relationships`,{});assert.equal(created.status,201);
  const relationshipId=(await created.json()).relationship.relationshipId as string;
  f.bindRelationship(relationshipId);const matching=await f.begin();await f.batch(matching);assert.match(JSON.stringify(await f.turn('What can you see?',f.assistantId,relationshipId)),new RegExp(marker));await f.stop(matching);
  // The trusted synthetic source is deliberately misbound. The ordinary
  // relationship remains the existing authenticated owner's real selection.
  f.bindRelationship(randomUUID());const mismatched=await f.begin();await f.batch(mismatched);
  const reply=await f.turn('What can you see?',f.assistantId,relationshipId);assert.equal(reply.scope.assistantId,f.assistantId);assert.doesNotMatch(JSON.stringify(reply),new RegExp(marker));
});


test('camera count restricts private history while authenticated shared and unknown turns retain fresh nonprivate scene',{timeout:15000},async t=>{
  const f=await fixture(t,true);
  await f.turn('PRIVATE_BEFORE_CAMERA_481');
  assert.equal(f.audience().privateAllowed,true);
  const state=await f.begin();assert.equal(state.captureActive,true);assert.equal(f.audience().privateAllowed,false);
  const admitted=await f.batch(state);assert.deepEqual(Object.keys(admitted.result).sort(),['observations','reason','requestId','status']);
  assert.equal(f.audience().classification,'shared');
  const shared=await f.turn();assert.match(JSON.stringify(shared),new RegExp(marker));assert.doesNotMatch(JSON.stringify(shared),/PRIVATE_BEFORE_CAMERA_481/);
  assert.match(shared.sections.find(section=>section.kind==='interactionState')!.content,/audience.*unknown/);
  const revision=f.audience().revision;f.advance(1001);await f.batch(state);assert.equal(f.audience().revision,revision,'fresh same-class count does not fence every reply');
  f.advance(2001);assert.equal(f.audience().classification,'unknown');
  assert.equal((await f.capability()).camera.captureActive,true,'count expiry does not end authorized capture');
  assert.match(JSON.stringify(await f.turn()),new RegExp(marker),'2s audience expiry preserves the same <=6s scene');
  f.advance(4000);assert.doesNotMatch(JSON.stringify(await f.turn()),new RegExp(marker),'audience transition never refreshes original scene age');
  await f.stop(state);assert.equal(f.audience().privateAllowed,false,'old private declaration cannot revive after camera stop');
});

test('camera count changes synchronously fence an ordinary pending response and one cannot restore private disclosure',{timeout:15000},async t=>{
  const f=await fixture(t,true),state=await f.begin();f.setCount('one');await f.batch(state);assert.equal(f.audience().privateAllowed,false);
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());
  f.setProvider({async *generate(input){f.requests.push(input);entered();await gate;yield {kind:'text',text:'AFTER_AUDIENCE_CHANGE'};yield {kind:'done'};}});
  const pending=f.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'What can you see?'});await started;
  let audioFenced=false;const oldRevision=f.audience().revision;
  const audio={invalidateIfStale:()=>{if(f.audience().revision!==oldRevision)audioFenced=true;},close:()=>{},belongsTo:()=>false};
  (f.app as any).audioSessions.add(audio);
  try{f.advance(1001);f.setCount('multiple');await f.batch(state);assert.equal(audioFenced,true,'same synchronous camera callback reconciles endpoint output');}
  finally{(f.app as any).audioSessions.delete(audio);release();}
  const output=await(await pending).text();assert.doesNotMatch(output,/AFTER_AUDIENCE_CHANGE|interaction.completed/);assert.match(output,/runtime_input_stale|cancelled/);
  f.setProvider({async *generate(input){f.requests.push(input);yield {kind:'text',text:'Restricted scene reply.'};yield {kind:'done'};}});
  f.advance(1001);f.setCount(undefined);await f.batch(state);assert.equal(f.audience().classification,'unknown');assert.equal(f.audience().privateAllowed,false);
  assert.match(JSON.stringify(await f.turn()),new RegExp(marker),'absence of usable count withholds private access, not authorized scene text');
});

test('starting the camera revokes an in-flight private turn before any delayed text can escape',{timeout:15000},async t=>{
  const f=await fixture(t,true);assert.equal(f.audience().privateAllowed,true);
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());
  f.setProvider({async *generate(input){f.requests.push(input);entered();await gate;yield {kind:'text',text:'PRIVATE_AFTER_CAMERA_START'};yield {kind:'done'};}});
  const pending=f.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'An ordinary private question.'});await started;
  try{const state=await f.begin();assert.equal(state.captureActive,true);assert.equal(f.audience().privateAllowed,false);}finally{release();}
  const output=await(await pending).text();assert.doesNotMatch(output,/PRIVATE_AFTER_CAMERA_START|interaction.completed/);assert.match(output,/runtime_input_stale|cancelled/);
});


test('provider reason text cannot impersonate a host deferral or bypass camera privacy reduction',{timeout:15000},async t=>{
  const f=await fixture(t,true),state=await f.begin();f.setCount('one');await f.batch(state);
  f.advance(1001);f.setCount('multiple');f.setProviderReason('foreground_priority');await f.batch(state);
  assert.equal(f.audience().classification,'shared','provider reason cannot suppress admitted multiple-count evidence');
  assert.match(JSON.stringify(await f.turn()),new RegExp(marker));
  f.advance(1001);f.failNext();f.setProviderReason('replaced');await f.batch(state);
  assert.equal(f.audience().classification,'unknown');assert.equal(f.audience().privateAllowed,false);
  assert.doesNotMatch(JSON.stringify(await f.turn()),new RegExp(marker),'a provider failure cannot be downgraded to a benign admission outcome');
});

test('ordinary HTTP text evidence joins published visual lineage to the exact finalized provider request without scene or reply content',{timeout:15000},async t=>{
  const f=await fixture(t),state=await f.begin(),batch=await f.batch(state);
  const host=(f.app as any).visualInput as import('../src/runtime/visual-input.ts').VisualInputHost;

  const request=await f.turn();
  const actor={principalId:f.session.principalId,sessionId:f.session.sessionId,assistantId:f.assistantId};
  const records=host.turnReceipts(actor),publication=host.publicationReceipts(actor).find(item=>item.admission.requestId===batch.requestId)!;
  assert.deepEqual(host.turnContextTraces(actor),[],'unconfigured host environment must not be fabricated');
  const admitted=records.find(item=>item.stage==='providerInvoked'&&item.interactionId===request.scope.interactionId)!;
  assert.ok(admitted,JSON.stringify(records));assert.ok(publication);assert.equal(publication.disposition,'published');
  assert.equal(admitted.lineage.selected!.requestId,batch.requestId);assert.equal(admitted.lineage.publication!.requestId,publication.admission.requestId);
  assert.equal(admitted.lineage.publication!.hostSequence,publication.admission.hostSequence);assert.equal(admitted.lineage.publication!.audienceRevision,publication.publication!.audienceRevision);
  assert.equal(admitted.finalized!.conversationSectionDigest,request.sections[7]!.contentDigest);assert.equal(admitted.finalized!.manifestDigest,createHash('sha256').update(JSON.stringify(request.manifest)).digest('hex'));
  assert.ok(records.some(item=>item.stage==='generationEnded'&&item.outcome==='completed'));assert.ok(records.every(item=>!item.endpointAcknowledged));
  assert.doesNotMatch(JSON.stringify(records),new RegExp(marker));assert.doesNotMatch(JSON.stringify(records),new RegExp(png.toString('base64')));assert.doesNotMatch(JSON.stringify(records),/What can you see\?/);
  for(const key of ['principalId','sessionId','assistantId'] as const)assert.deepEqual(host.turnReceipts({...actor,[key]:randomUUID()}),[]);
  const before=JSON.stringify(records);await f.stop(state);assert.equal(JSON.stringify(host.turnReceipts(actor)),before,'withdrawal does not rewrite historical receipts or imply current permission');
  const absent=await f.turn();const noScene=host.turnReceipts(actor).find(item=>item.stage==='providerInvoked'&&item.interactionId===absent.scope.interactionId)!;assert.equal(noScene.finalized!.visualIncluded,false);assert.equal(noScene.lineage.selected,null);assert.equal(noScene.lineage.publication,null);
});

test('authenticated HTTP visual turn uses actual deployment identity for canonical context trace and exact provider manifest',{timeout:15000},async t=>{
 const environmentId=randomUUID(),f=await fixture(t,false,environmentId),state=await f.begin();await f.batch(state);
 const request=await f.turn(),host=(f.app as any).visualInput as import('../src/runtime/visual-input.ts').VisualInputHost;
 const actor={principalId:f.session.principalId,sessionId:f.session.sessionId,assistantId:f.assistantId};
 const trace=host.turnContextTraces(actor).find(item=>item.events[0]!.interactionTraceId===request.scope.interactionId)!;
 assert.ok(trace);assert.equal(trace.events[0]!.environmentId,environmentId);assert.equal(trace.manifest.bytes,JSON.stringify(request.manifest));
 assert.ok(trace.events.some(event=>(event.payload as {reference?:string}).reference===`urn:lifestream:prompt-section:sha256:${request.sections[7]!.contentDigest}`));
 assert.doesNotMatch(JSON.stringify(trace),new RegExp(marker));assert.doesNotMatch(JSON.stringify(trace),/What can you see\?/);assert.doesNotMatch(JSON.stringify(trace),new RegExp(png.toString('base64')));
 assert.equal(trace.complete,false);assert.equal(trace.deliveryProved,false);
 for(const key of ['principalId','sessionId','assistantId'] as const)assert.deepEqual(host.turnContextTraces({...actor,[key]:randomUUID()}),[]);
 const before=JSON.stringify(trace);await f.stop(state);assert.equal(JSON.stringify(host.turnContextTraces(actor)[0]),before,'historical metadata cannot restore capture or context eligibility');
});

test('foreign configured visual environment withholds canonical projection without changing ordinary source admission',{timeout:15000},async t=>{
 const f=await fixture(t,false,randomUUID(),randomUUID()),state=await f.begin();await f.batch(state);
 const request=await f.turn(),host=(f.app as any).visualInput as import('../src/runtime/visual-input.ts').VisualInputHost;
 const actor={principalId:f.session.principalId,sessionId:f.session.sessionId,assistantId:f.assistantId};
 assert.match(request.sections[7]!.content,new RegExp(marker));assert.ok(host.turnReceipts(actor).some(receipt=>receipt.stage==='providerInvoked'));
 assert.deepEqual(host.turnContextTraces(actor),[]);
});
