import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test,{type TestContext} from 'node:test';
import {createContractValidator} from '@lifestream/contracts';
import {Database} from '@lifestream/storage-sqlite';
import type {InferenceProvider,InferenceRequest} from '@lifestream/runtime/inference';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import type {InitiativeSimulationEvent} from '../src/runtime/initiative-host.ts';
import {extensionSettings} from '../../../tests/fixtures/extension-settings.ts';
const validator=createContractValidator(),apiId='https://lifestream.dev/contracts/initiative-api/1.0.0';

async function fixture(t:TestContext,enabled=true,modality:'text'|'speech'='text'){
 const root=await mkdtemp(join(tmpdir(),'initiative-host-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};
 const events=new Map<string,InitiativeSimulationEvent>(),installerToken=randomUUID();
 const app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'safety'),installerToken},...(enabled?{initiativeSimulation:{resolve:(_scope:unknown,_session:string,id:string)=>events.get(id)}}:{})});await app.start();t.after(()=>app.shutdown());
 const base=`http://127.0.0.1:${app.address().port}`,headers:Record<string,string>={origin:base,'content-type':'application/json'};
 const send=async(path:string,body?:unknown,extra:Record<string,string>={})=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as any};};
 const setup=await fetch(base+'/api/auth/v1/setup',{method:'POST',headers,body:JSON.stringify({username:'owner',password:randomUUID()+randomUUID(),installerToken})});assert.equal(setup.status,201);headers.cookie=setup.headers.get('set-cookie')!.split(';')[0]!;const auth=(await setup.json() as any).session;headers['x-lifestream-csrf']=auth.csrfToken;
 const assistant=(await send('/api/admin/v1/assistants',{displayName:'Synthetic Initiative Host'})).body;
 assert.equal((await send(`/api/admin/v1/assistants/${assistant.assistantId}/activate`,{profileId:assistant.profile.profileId,expectedActiveRevision:null})).status,200);
 const rel=(await send(`/api/admin/v1/assistants/${assistant.assistantId}/relationships`,{})).body.relationship;
 const path=`/api/admin/v1/assistants/${assistant.assistantId}/relationships/${rel.relationshipId}`,route=path+'/initiative/v1';
 if(modality==='speech'){(app as any).providers.stt={};(app as any).providers.tts={};}
 const endpoint=(await send('/api/runtime/v1/session-context',{expectedRevision:0,mode:modality==='speech'?'audio':'text',audienceScope:'authenticatedSession'})).body.endpoint;
 const declaration=(await send(path+'/candidates',{content:'Allow a synthetic social opening in this explicitly reviewed test session.',category:'declaration',contextUse:'baseline',source:'authored',sourceFamily:'synthetic-owner',uncertainty:'low',expectedRevision:rel.revision,idempotencyKey:randomUUID()})).body;
 assert.equal((await send(path+`/candidates/${declaration.candidate.candidateId}/decision`,{decision:'approved',expectedRevision:(await send(path)).body.relationship.revision,idempotencyKey:randomUUID()})).status,200);
 const settings={...structuredClone(extensionSettings.initiative),preset:'custom',proactiveness:5,dimensions:{initiative:5,warmth:5,curiosity:3,followThrough:3,persistence:0},allowedContexts:['privateAvailable'],endpointIds:[endpoint.endpointId],allowedModalities:[modality],allowedKinds:['arrivalReturn','availableCheckIn','groundedFollowUp'],consentRefs:[declaration.candidate.candidateId],tuning:{...extensionSettings.initiative.tuning,openingsPerHour:2,openingsPerDay:8,minimumGapSeconds:120,checkInIntervalSeconds:300}};
 const extension=async(body:Record<string,unknown>,extra:Record<string,string>={})=>{const r=await send(route,{schemaVersion:'1.0.0',...body},extra);assert.equal(validator.validate(apiId,r.body).valid,true,JSON.stringify(r));return r;};
 const draft=await extension({operation:'draft',idempotencyKey:randomUUID(),expectedActiveConfigurationId:null,settings});assert.equal(draft.status,201,JSON.stringify(draft));const active=draft.body.records[0];assert.equal((await extension({operation:'activate',idempotencyKey:randomUUID(),configurationId:active.configurationId,expectedRevision:active.revision,confirmed:true})).status,200);
 let n=0;const event=(overrides:Partial<InitiativeSimulationEvent>={})=>{const e:InitiativeSimulationEvent={userId:auth.principalId,sessionId:auth.sessionId,sourceEventId:randomUUID(),kind:'availableCheckIn',topicRef:null,observedAt:Date.now()-10000+n++,expiresAt:Date.now()+60000,context:'privateAvailable',modality,...overrides};events.set(e.sourceEventId,e);return {schemaVersion:'1.0.0',operation:'simulate',idempotencyKey:randomUUID(),sessionId:auth.sessionId,sourceEventId:e.sourceEventId,kind:e.kind,topicRef:e.topicRef};};
 const db=new Database({path:config.storage.databasePath});t.after(()=>db.close());
 return {app,config,db,auth,assistant,rel,path,route,headers,base,send,extension,event,events,settings,active,ready:()=>extension({operation:'outputReadiness',sessionId:auth.sessionId,modality,ready:true})};
}
const outcome=(r:any,id?:string)=>r.body.records.find((x:any)=>x.recordType==='outcome'&&(!id||x.opportunityId===id));
const calls=(db:Database)=>Number(db.connection.prepare('SELECT count(*) AS n FROM initiative_inference_calls').get()!.n);

test('protected synthetic Initiative joins approved scope, one generation, text emission, acknowledgment and ordinary reply',async t=>{
 const f=await fixture(t);assert.equal((await f.ready()).status,200);
 const request=f.event(),result=await f.extension(request);assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.delivery.text,'Fixture response: ');assert.equal(result.body.delivery.captureEnabled,false);
 const record=outcome(result),op=result.body.records.find((r:any)=>r.recordType==='opportunity');assert.equal(record.state,'emitted');assert.equal(record.acknowledgmentKind,null);assert.equal(record.response,'notObserved');assert.ok(record.sourceRefs.some((ref:string)=>new RegExp('^prepared-context:'+record.preparedViewId+':[0-9a-f]{64}$','u').test(ref)));assert.equal(op.sessionId,f.auth.sessionId);assert.equal(op.conversationId,f.db.connection.prepare('SELECT conversation_id FROM sessions WHERE id=?').get(f.auth.sessionId)!.conversation_id);assert.equal(calls(f.db),1);
 assert.equal((await f.extension(request)).body.delivery,null);assert.equal(calls(f.db),1);assert.equal((await f.extension({...request,topicRef:'different'})).status,409);
 assert.equal((await f.extension({operation:'inspect'})).body.delivery,null);
 const ack={operation:'acknowledge',sessionId:f.auth.sessionId,opportunityId:op.opportunityId,receiptId:record.deliveryReceiptRef,kind:'endpointAccepted'};
 assert.equal((await f.extension({...ack,receiptId:randomUUID()})).status,409);assert.equal((await f.extension({...ack,sessionId:randomUUID()})).status,409);
 assert.equal((await f.extension({...ack,kind:'playbackCompleted'})).status,409);
 const accepted=await f.extension(ack);assert.equal(outcome(accepted).acknowledgmentKind,'endpointAccepted');assert.equal(outcome(accepted).response,'notObserved');
 const response=await fetch(f.base+'/api/runtime/v1/messages',{method:'POST',headers:f.headers,body:JSON.stringify({assistantId:f.assistant.assistantId,relationshipId:f.rel.relationshipId,userInput:'Hello again.'})});assert.equal(response.status,200);assert.match(await response.text(),/Hello again/u);
 assert.equal(outcome(await f.extension({operation:'inspect'})).response,'replied');
 const cooled=await f.extension(f.event());assert.equal(outcome(cooled).state,'suppressed');assert.deepEqual(outcome(cooled).reasonCodes,['cooldown']);assert.equal(calls(f.db),1);
 assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='initiative_transcripts'").get()!.n,0);
 const stored=String(f.db.connection.prepare('SELECT outcome_json FROM initiative_delivery').get()!.outcome_json);assert.equal(stored.includes('Fixture response'),false);
});

test('synthetic ingress rejects forged facts, unbound subjects, missing readiness, quiet and short arrival without model calls',async t=>{
 const f=await fixture(t),request=f.event();assert.equal((await f.send(f.route,{...request,audience:'privateAvailable'})).status,422);
 assert.equal((await f.send(f.route,request,{'x-lifestream-csrf':'wrong'})).status,403);assert.equal((await f.send(f.route,request,{cookie:''})).status,401);
 assert.equal((await f.extension({...request,sessionId:randomUUID()})).status,409);
 assert.equal((await f.extension(f.event({userId:randomUUID()}))).status,409);
 const unready=await f.extension(request);assert.equal(outcome(unready).state,'suppressed');assert.ok(outcome(unready).reasonCodes.includes('endpointUnavailable'));assert.equal(calls(f.db),0);
 await f.ready();const quiet=await f.extension({operation:'temporaryMode',idempotencyKey:randomUUID(),sessionId:f.auth.sessionId,mode:'quiet',endsAt:null,dimensions:null});assert.equal(quiet.status,200);
 const suppressed=await f.extension(f.event());assert.ok(outcome(suppressed).reasonCodes.includes('quiet'));assert.equal(calls(f.db),0);
 await f.extension({operation:'temporaryMode',idempotencyKey:randomUUID(),sessionId:f.auth.sessionId,mode:'clear',endsAt:null,dimensions:null});
 const arrival=await f.extension(f.event({kind:'arrivalReturn',dwellSeconds:0,absenceSeconds:0}));assert.ok(outcome(arrival).reasonCodes.includes('insufficientDwell'));assert.equal(calls(f.db),0);
 const shared=await f.extension(f.event({context:'shared'}));assert.ok(outcome(shared).reasonCodes.includes('privacyInsufficient'));assert.equal(calls(f.db),0);
});

test('synthetic Initiative is disabled by default and cannot be enabled in a live profile',async t=>{
 const f=await fixture(t,false);await f.ready();const result=await f.extension(f.event());assert.equal(result.status,409);assert.equal(result.body.code,'simulation_not_enabled');assert.equal(calls(f.db),0);
 assert.throws(()=>createLifestreamServer({config:{...f.config,profile:'mac-local'},initiativeSimulation:{resolve:()=>undefined}}),/test profile/u);
});

test('an ordinary authenticated turn preempts an in-flight social candidate without refunding its call',async t=>{
 const f=await fixture(t);await f.ready();let entered:()=>void=()=>{},release:()=>void=()=>{};const started=new Promise<void>(r=>{entered=r;});let observed:InferenceRequest|undefined;
 const provider:InferenceProvider={async *generate(request){if(request.sections.at(-1)?.content){yield {kind:'text',text:'Ordinary reply.'};yield {kind:'done'};return;}observed=request;entered();await new Promise<void>(r=>{release=r;});yield {kind:'text',text:'Too late.'};yield {kind:'done'};}};
 (f.app as any).providers.inference=provider;
 const pending=f.extension(f.event());await started;
 try{
  assert.equal(observed!.sections.at(-1)!.content,'');assert.match(observed!.sections.find(s=>s.kind==='interactionState')!.content,/relationalOpportunity/u);
  const response=await fetch(f.base+'/api/runtime/v1/messages',{method:'POST',headers:f.headers,body:JSON.stringify({assistantId:f.assistant.assistantId,relationshipId:f.rel.relationshipId,userInput:'Please respond now.'})});assert.equal(response.status,200);await response.text();
  const stopped=await pending;assert.equal(stopped.body.delivery,null);assert.equal(outcome(stopped).state,'cancelled');assert.deepEqual(outcome(stopped).reasonCodes,['userTurn']);assert.equal(calls(f.db),1);
  assert.equal(f.db.connection.prepare('SELECT settled_ms FROM initiative_inference_calls').get()!.settled_ms,null);
 }finally{release();await new Promise(r=>setTimeout(r,20));}
});

test('temporary companionship uses one warmth value for ordinary and social replies, expires, and never changes durable settings',async t=>{
 const f=await fixture(t);await f.ready();const durable=String(f.db.connection.prepare('SELECT payload_json FROM assistant_relationship_configurations WHERE configuration_id=?').get(f.active.configurationId)!.payload_json);
 const mode={operation:'temporaryMode',idempotencyKey:randomUUID(),sessionId:f.auth.sessionId,mode:'companionship',endsAt:new Date(Date.now()+310000).toISOString(),dimensions:{initiative:5,warmth:9,curiosity:3,followThrough:3,persistence:0}};
 assert.equal((await f.extension({...mode,endsAt:new Date(Date.now()+1000).toISOString()})).status,409);assert.equal((await f.extension(mode)).status,200);
 const requests:InferenceRequest[]=[];(f.app as any).providers.inference={async *generate(request:InferenceRequest){requests.push(request);yield {kind:'text',text:'Synthetic reply.'};yield {kind:'done'};}};
 const ordinary=await fetch(f.base+'/api/runtime/v1/messages',{method:'POST',headers:f.headers,body:JSON.stringify({assistantId:f.assistant.assistantId,userInput:'A synthetic ordinary turn.'})});await ordinary.text();
 const social=await f.extension(f.event());assert.ok(social.body.delivery,JSON.stringify(social));assert.equal(requests.length,2);
 for(const r of requests)assert.match(r.sections.find(s=>s.kind==='preparedMemory')!.content,/warmth=0\.8181818181818182/u);
 assert.match(requests[1]!.sections.find(s=>s.kind==='interactionState')!.content,/"warmth":9/u);
 assert.equal(String(f.db.connection.prepare('SELECT payload_json FROM assistant_relationship_configurations WHERE configuration_id=?').get(f.active.configurationId)!.payload_json),durable);
 await new Promise(r=>setImmediate(r));t.mock.timers.enable({apis:['Date'],now:Date.now()+320000});
 const restored=await fetch(f.base+'/api/runtime/v1/messages',{method:'POST',headers:f.headers,body:JSON.stringify({assistantId:f.assistant.assistantId,relationshipId:f.rel.relationshipId,userInput:'After temporary expiry.'})});assert.equal(restored.status,200);await restored.text();
 assert.match(requests[2]!.sections.find(s=>s.kind==='preparedMemory')!.content,/warmth=0\.45454545454545453/u);
});

test('audience changes and host source changes fence an in-flight candidate before output',async t=>{
 for(const cause of ['audience','source']){
  const f=await fixture(t);await f.ready();let entered:()=>void=()=>{},release:()=>void=()=>{};const started=new Promise<void>(r=>{entered=r;});
  (f.app as any).providers.inference={async *generate(){entered();await new Promise<void>(r=>{release=r;});yield {kind:'text',text:'Discard this.'};yield {kind:'done'};}};
  const request=f.event(),pending=f.extension(request);await started;
  if(cause==='audience')assert.equal((await f.send('/api/runtime/v1/session-context',{expectedRevision:1,mode:'text',audienceScope:'unknown'})).status,200);
  else{f.events.get(request.sourceEventId)!.context='shared';release();}
  const result=await pending;assert.equal(result.body.delivery,null);assert.ok(['suppressed','cancelled'].includes(outcome(result).state));assert.equal(outcome(result).lastDeliveryStage,'none');assert.ok(outcome(result).reasonCodes.includes(cause==='audience'?'audienceChanged':'staleSource'));assert.equal(calls(f.db),1);release();await new Promise(r=>setImmediate(r));
 }
});

test('metadata write failure after payload issuance retains charged uncertainty and cannot replay output',async t=>{
 const f=await fixture(t);await f.ready();f.db.exec("CREATE TRIGGER reject_observed_emission BEFORE UPDATE ON initiative_delivery WHEN NEW.state='emitted' BEGIN SELECT RAISE(ABORT,'synthetic emission persistence failure'); END;");
 const request=f.event();await assert.rejects(f.extension(request));
 const row=f.db.connection.prepare('SELECT state,budget_state,outcome_json FROM initiative_delivery').get()!;assert.equal(row.state,'failed');assert.equal(row.budget_state,'charged');assert.equal(JSON.parse(String(row.outcome_json)).lastDeliveryStage,'queued');assert.equal(calls(f.db),1);
 f.db.exec('DROP TRIGGER reject_observed_emission');const retry=await f.extension(request);assert.equal(retry.body.delivery,null);assert.equal(outcome(retry).state,'failed');assert.equal(calls(f.db),1);
});

test('dismissal is atomic with its retry identity and never converts silence into a durable preference',async t=>{
 const f=await fixture(t);await f.ready();const emitted=await f.extension(f.event()),r=outcome(emitted),before=String(f.db.connection.prepare('SELECT payload_json FROM assistant_relationships').get()!.payload_json);
 const dismiss={operation:'dismiss',idempotencyKey:'synthetic-dismiss',sessionId:f.auth.sessionId,opportunityId:r.opportunityId};
 f.db.exec("CREATE TRIGGER reject_dismiss_retry BEFORE INSERT ON assistant_relationship_idempotency WHEN NEW.idempotency_key='synthetic-dismiss' BEGIN SELECT RAISE(ABORT,'synthetic retry persistence failure'); END;");
 assert.equal((await f.extension(dismiss)).status,409);assert.equal(outcome(await f.extension({operation:'inspect'})).response,'notObserved');
 f.db.exec('DROP TRIGGER reject_dismiss_retry');assert.equal(outcome(await f.extension(dismiss)).response,'dismissed');assert.equal((await f.extension(dismiss)).status,200);
 assert.equal(String(f.db.connection.prepare('SELECT payload_json FROM assistant_relationships').get()!.payload_json),before);
 const next=await f.extension(f.event());assert.equal(next.status,409);assert.equal(calls(f.db),1);
});

async function speechFixture(t:TestContext){
 const f=await fixture(t,true,'speech'),wire:any[]=[],synthesis:any[]=[],model:InferenceRequest[]=[];let stt=0,finish:()=>void=()=>{};
 const completed=new Promise<void>(resolve=>{finish=resolve;});
 const tts:any={withoutAdmissionRetries(){return this;},async *synthesize(request:any){synthesis.push(request);yield {kind:'data',segmentId:request.segmentId,frame:{frameId:randomUUID(),sequence:0,format:request.format,sampleOffset:0,sampleCount:10,dataBase64:Buffer.alloc(20).toString('base64')},mappingRevision:'synthetic-speech:1'};yield {kind:'terminal',outcome:'succeeded',outputSamples:10,frameCount:1,mappingRevision:'synthetic-speech:1',degradedDimensions:[]};}};
 (f.app as any).providers.tts=tts;(f.app as any).providers.stt={async *transcribe(){stt++;throw new Error('No synthetic input capture');}};
 (f.app as any).providers.inference={async *generate(request:InferenceRequest){model.push(request);yield {kind:'text',text:'Synthetic opening.'};yield {kind:'done'};}};
 const socket=new WebSocket(f.base.replace('http:','ws:')+'/api/runtime/v1/audio',{origin:f.base,headers:{cookie:f.headers.cookie!}});t.after(()=>socket.close());
 socket.on('message',raw=>{const e=JSON.parse(raw.toString());wire.push(e);if(e.event?.payload.type==='terminal')finish();});await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
 const ack=(r:any,kind='endpointAccepted')=>f.extension({operation:'acknowledge',sessionId:f.auth.sessionId,opportunityId:outcome(r).opportunityId,receiptId:outcome(r).deliveryReceiptRef,kind});
 const pending=()=>Number(f.db.connection.prepare('SELECT count(*) AS n FROM initiative_playback_pending').get()!.n);
 const preview=()=>fetch(f.base+'/api/runtime/v1/tts',{method:'POST',headers:f.headers,body:JSON.stringify({text:'Synthetic competing output.'})});
 return {...f,socket,wire,synthesis,model,tts,completed,ack,pending,preview,stt:()=>stt};
}
async function until(check:()=>boolean){for(let n=0;n<200;n++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Bounded synthetic state did not settle');}

test('protected speech delivery holds ownership after synthesis until receipt-bound playback acknowledgment', {timeout:15000},async t=>{
 const f=await speechFixture(t);assert.equal((await f.ready()).status,200);const request=f.event(),r=await f.extension(request);await f.completed;
 assert.equal(r.body.delivery.modality,'speech');assert.equal(r.body.delivery.captureEnabled,false);assert.equal(outcome(r).state,'emitted');assert.equal(f.stt(),0);assert.equal(f.model.length,1);assert.equal(f.synthesis.length,1);assert.equal(f.model[0]!.scope.interactionId,r.body.delivery.interactionId);assert.equal(f.model[0]!.sections.find(s=>s.kind==='userInput')!.content,'');
 assert.equal(f.wire.some(e=>['transcript','accepted','turnStarted'].includes(e.type)),false);assert.equal(f.wire.find(e=>e.type==='audio').interactionTraceId,r.body.delivery.interactionId);assert.equal(f.pending(),1);
 assert.equal((await f.preview()).status,409);assert.equal(outcome(await f.ack(r)).acknowledgmentKind,'endpointAccepted');assert.equal(f.pending(),1);assert.equal((await f.preview()).status,409);
 assert.equal((await f.extension({operation:'acknowledge',sessionId:f.auth.sessionId,opportunityId:outcome(r).opportunityId,receiptId:randomUUID(),kind:'playbackCompleted'})).status,409);assert.equal(f.pending(),1);
 assert.equal(outcome(await f.ack(r,'playbackCompleted')).acknowledgmentKind,'playbackCompleted');await until(()=>!(f.app as any).audioOwnership.currentLease(f.auth.sessionId));assert.equal(f.pending(),0);
 assert.equal((await f.extension(request)).body.delivery,null);assert.equal(f.model.length,1);assert.equal((await f.ack(r,'playbackCompleted')).status,200);
});

test('speech readiness is bound to one connected transport and cannot enable fallback output', {timeout:15000},async t=>{
 const f=await fixture(t,true,'speech');assert.equal((await f.ready()).status,409);const r=await f.extension(f.event());assert.equal(outcome(r).state,'suppressed');assert.equal(calls(f.db),0);assert.equal(r.body.delivery,null);
 const g=await speechFixture(t);assert.equal((await g.ready()).status,200);g.socket.close();await new Promise<void>(r=>g.socket.once('close',()=>r()));
 const next=new WebSocket(g.base.replace('http:','ws:')+'/api/runtime/v1/audio',{origin:g.base,headers:{cookie:g.headers.cookie!}});t.after(()=>next.close());await new Promise<void>((resolve,reject)=>{next.once('open',resolve);next.once('error',reject);});
 const stale=await g.extension(g.event());assert.equal(outcome(stale).state,'suppressed');assert.equal(g.model.length,0);assert.equal(stale.body.delivery,null);
});

test('premature playback acknowledgment fails and partial failure preserves endpoint acceptance without a playback claim', {timeout:15000},async t=>{
 const f=await speechFixture(t);let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});const original=f.tts.synthesize;
 f.tts.synthesize=async function*(request:any){for await(const e of original(request)){if(e.kind==='terminal'){await gate;throw new Error('Synthetic partial provider failure');}yield e;}};
 await f.ready();const r=await f.extension(f.event());try{assert.equal((await f.ack(r,'playbackCompleted')).status,409);assert.equal((await f.ack(r)).status,200);}finally{release();}
 await until(()=>f.pending()===0);const final=outcome(await f.extension({operation:'inspect'}));assert.equal(final.state,'failed');assert.equal(final.lastDeliveryStage,'acknowledged');assert.equal(final.acknowledgmentKind,'endpointAccepted');assert.equal((await f.ack(r,'playbackCompleted')).status,409);assert.ok(f.wire.some(e=>e.type==='stopPlayback'));
});

test('quiet, endpoint change, explicit stop and ordinary typed replies cancel uncompleted speech playback', {timeout:20000},async t=>{
 for(const cause of ['quiet','endpoint','stop','reply']){
  const f=await speechFixture(t);await f.ready();const r=await f.extension(f.event());await f.completed;await f.ack(r);
  if(cause==='quiet')await f.extension({operation:'temporaryMode',idempotencyKey:randomUUID(),sessionId:f.auth.sessionId,mode:'quiet',endsAt:null,dimensions:null});
  if(cause==='endpoint')await f.send('/api/runtime/v1/session-context',{expectedRevision:1,mode:'audio',audienceScope:'unknown'});
  if(cause==='stop')f.socket.send(JSON.stringify({type:'interrupt',interactionTraceId:r.body.delivery.interactionId,reason:'Explicit stop'}));
  if(cause==='reply'){const response=await fetch(f.base+'/api/runtime/v1/messages',{method:'POST',headers:f.headers,body:JSON.stringify({assistantId:f.assistant.assistantId,relationshipId:f.rel.relationshipId,userInput:'Synthetic ordinary reply.'})});assert.equal(response.status,200);await response.text();}
  await until(()=>f.pending()===0);const final=outcome(await f.extension({operation:'inspect'}));assert.equal(final.state,'cancelled',cause);assert.equal(final.lastDeliveryStage,'acknowledged');assert.equal(final.acknowledgmentKind,'endpointAccepted');if(cause==='reply')assert.equal(final.response,'replied');assert.equal((await f.ack(r,'playbackCompleted')).status,409);await until(()=>f.wire.some(e=>e.type==='stopPlayback'));
 }
});


test('lost speech playback acknowledgment expires unknown and never releases a replayable payload', {timeout:10000},async t=>{
 const f=await speechFixture(t);await f.ready();const request=f.event({expiresAt:Date.now()+1000}),r=await f.extension(request);await f.completed;await f.ack(r);
 await until(()=>f.pending()===0);const final=outcome(await f.extension({operation:'inspect'}));assert.equal(final.state,'unknown');assert.deepEqual(final.reasonCodes,['ackTimeout']);assert.equal(final.lastDeliveryStage,'acknowledged');assert.equal(final.acknowledgmentKind,'endpointAccepted');assert.equal((await f.extension(request)).body.delivery,null);assert.equal(f.model.length,1);assert.equal((await f.ack(r,'playbackCompleted')).status,409);
});

test('authenticated microphone start requires the current audio endpoint and closes when disclosure changes',{timeout:15000},async t=>{
 const f=await fixture(t,true,'speech');let recognition=0;
 (f.app as any).providers.stt={async *transcribe(){recognition++;yield {kind:'terminal',outcome:'failed'};}};
 const endpoint=(await f.send('/api/runtime/v1/session-context')).body.endpoint;
 const connect=async()=>{const wire:any[]=[];const socket=new WebSocket(f.base.replace('http:','ws:')+'/api/runtime/v1/audio',{origin:f.base,headers:{cookie:f.headers.cookie!}});t.after(()=>socket.close());socket.on('message',data=>wire.push(JSON.parse(data.toString())));await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});return {socket,wire};};
 const request=(revision:number,endpointId=endpoint.endpointId)=>({schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId:f.auth.sessionId,expectedSessionRevision:revision,endpointId,audioInputId:randomUUID(),format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1},assistantId:f.assistant.assistantId,relationshipId:f.rel.relationshipId});
 for(const invalid of [request(0),request(1,randomUUID())]){const c=await connect();c.socket.send(JSON.stringify({type:'start',request:invalid}));await until(()=>c.socket.readyState===WebSocket.CLOSED);assert.equal(c.wire.some(e=>e.type==='accepted'),false);assert.equal(c.wire.find(e=>e.type==='error').problem.code,'audio_input_scope_changed');}
 const c=await connect(),input=request(1);c.socket.send(JSON.stringify({type:'start',request:input}));await until(()=>c.wire.some(e=>e.type==='accepted'));
 c.socket.send(JSON.stringify({type:'frame',audioInputId:input.audioInputId,frame:{frameId:randomUUID(),sequence:0,format:input.format,sampleOffset:0,sampleCount:10,dataBase64:Buffer.alloc(20).toString('base64')}}));
 assert.equal((await f.send('/api/runtime/v1/session-context',{expectedRevision:1,mode:'audio',audienceScope:'unknown'})).status,200);await until(()=>c.socket.readyState===WebSocket.CLOSED);assert.equal(recognition,0);assert.equal(c.wire.find(e=>e.type==='error').problem.code,'audio_input_scope_changed');
 const fresh=await connect();fresh.socket.send(JSON.stringify({type:'start',request:request(2)}));await until(()=>fresh.wire.some(e=>e.type==='accepted'));assert.equal(fresh.wire.some(e=>e.type==='error'),false);
});
