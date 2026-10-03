import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {createReviewedGameObservationComposition,validateReviewedGameObservationRun,qualifiedCtVisionCurrent,type ReviewedGameObservationRun} from '../src/runtime/reviewed-game-observation.ts';
import {UnderstandingWorkCoordinator} from '@lifestream/runtime/understanding/coordinator';
import {GAME_HOST_PROTOCOL as protocol,gameHostDigest} from '@lifestream/contracts/game-host';
import {ActivityCheckpointRepository} from '../../../packages/storage-sqlite/src/game-activity.ts';
import {scriptedGameBounds} from '../../../packages/runtime/test/fixtures/game-policy.ts';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {fixture} from './fixtures/game-host.ts';
import type {GameHostOptions,GameHostJoin,GameHostPort} from '../src/runtime/game-host-port.ts';
import {isDeepStrictEqual} from 'node:util';
import {selectGameCampaignContext} from '@lifestream/runtime/activity/game-journal';
import {requestForFinalizedTurn} from '@lifestream/runtime/inference/prompt';
import type {ActivityScope} from '@lifestream/contracts/game-activity';
const secret=()=>`synthetic-${randomBytes(24).toString('hex')}`;
async function setup(t:import('node:test').TestContext,enabled=true,runtimeEnabled=false,ownedFrames=false){
 const root=await mkdtemp(join(tmpdir(),'ls-host-http-'));t.after(()=>rm(root,{recursive:true,force:true}));let now=Date.now(),qualified=true,approved=true,hostJoin:GameHostJoin|undefined,approvedScope:ActivityScope|undefined;const environmentId=randomUUID(),installerToken=secret(),approvedUntil=new Date(Date.now()+60000).toISOString();
 const config=loadProfile('test');if(runtimeEnabled)config.profile='ai5090';config.authority.authentication='local-password';config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};
 const gameHost:GameHostOptions={...(ownedFrames?{ownedFrames:true as const}:{}),maxAttachments:2,maxDurationMs:10000,createRepository:database=>new ActivityCheckpointRepository(database,{maxRuns:4,maxReservations:8,maxControllerReservations:8,maxCheckpointBytes:32768,scopeCurrent:()=>qualified,quarantined:()=>false,policyFor:()=>({enabled:true,revision:1,retentionMs:3600000,bounds:structuredClone(scriptedGameBounds)}),allowCreate:()=>true,checkpointCurrent:()=>qualified,transitionCurrent:()=>true,planningCurrent:()=>qualified,usageCurrent:()=>qualified,controllerCurrent:()=>qualified,controllerUsageCurrent:()=>qualified}),resolveAttachment:(_actor,metadata)=>{const {protocol:_,...binding}=metadata;return qualified?binding:null;},bindingCurrent:()=>qualified,controllerCurrent:()=>qualified,boundary:{sourceAvailable:()=>qualified,acceptAction:()=>qualified,acceptObservation:()=>qualified}};
 gameHost.onAttached=value=>hostJoin=value;
 const app=createLifestreamServer({config,sessionEnvironmentId:environmentId,localAuth:{stateDirectory:join(root,'auth'),installerToken,now:()=>now},audiencePrivacy:{sourceIds:[]},...(enabled?{gameHost}:{}),...(runtimeEnabled?{gameRuntime:{resolveApproval:scope=>approved&&approvedScope&&isDeepStrictEqual(scope,approvedScope)?{scope:structuredClone(approvedScope),approvedUntil,maximumRunMs:30000,maximumPlanningSteps:2,observations:true,campaignJournal:true,controllerInput:false,memoryEpisodes:false}:null,sourceCurrent:()=>qualified}}:{})});await app.start();t.after(()=>app.shutdown());
 const base=`http://127.0.0.1:${app.address().port}`,headers:Record<string,string>={origin:base,'content-type':'application/json'};
 const request=(path:string,input:unknown,extra:Record<string,string>={})=>fetch(base+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(input)});
 const enrollment=await request('/api/auth/v1/setup',{username:'synthetic-owner',password:secret(),installerToken});assert.equal(enrollment.status,201);headers.cookie=enrollment.headers.get('set-cookie')!.split(';')[0]!;const {session}=await enrollment.json() as {session:{principalId:string;sessionId:string;csrfToken:string}};headers['x-lifestream-csrf']=session.csrfToken;
 assert.equal((await request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'})).status,200);assert.equal((await request('/api/runtime/v1/audience',{mode:'solo',seconds:300})).status,200);
 const created=await request('/api/admin/v1/assistants',{displayName:'Synthetic Host Fixture'});assert.equal(created.status,201);const {assistantId}=await created.json() as {assistantId:string};const relationshipResponse=await request(`/api/admin/v1/assistants/${assistantId}/relationships`,{});assert.equal(relationshipResponse.status,201);const {relationship}=await relationshipResponse.json() as {relationship:{relationshipId:string}};
 const stored=app.database.connection.prepare('SELECT conversation_id,endpoint_id FROM sessions WHERE id=?').get(session.sessionId)!;
 const f=fixture({database:app.database,scope:{assistantId,principalId:session.principalId,relationshipId:relationship.relationshipId,environmentId,contextBinding:{conversationId:stored.conversation_id as string,sessionId:session.sessionId,endpointId:stored.endpoint_id as string,participationKind:'logicalActivity',humanSpeakerRef:null,audioOwnerEndpointId:null,ownerPermissionRef:'synthetic-current-permission'}}});
 approvedScope=structuredClone(f.input.request.scope);
 const metadata={protocol,hostId:randomUUID(),scope:f.input.request.scope,pinsDigest:f.input.request.payload.expectedPinsDigest,providerRef:'scripted:guarded',sourceRevision:'b'.repeat(64)},path='/api/runtime/v1/game-host/';
 return {app,headers,request,metadata,path,f,session,hostJoin:()=>hostJoin!,now:(value:number)=>now=value,advance:(ms:number)=>now+=ms,withdraw:()=>qualified=false,withdrawApproval:()=>approved=false};
}
test('host HTTP is disabled by default even for an existing authenticated owner',async t=>{const s=await setup(t,false),response=await s.request(s.path+'attach',s.metadata);assert.equal(response.status,404);assert.deepEqual(await response.json(),{error:'game_host_disabled'});assert.equal(s.app.database.connection.prepare('SELECT count(*) AS n FROM game_host_dispatch').get()!.n,0);});

test('server draining admits only bounded authenticated historical shutdown ingress while supervised stop waits',async t=>{
 const s=await setup(t);let finish!:()=>void;
 // Hold the source stop to exercise the actual HTTP dispatch/auth layer during
 // draining, without activating gameplay or making a native effect.
 (s.app as unknown as {gameplay:{stop:()=>Promise<import('../../../scripts/supervised-game-runtime.mjs').GameRetirementOutcome>}}).gameplay={stop:()=>new Promise(resolve=>{finish=()=>resolve({state:'retired',nativeShutdownConfirmed:null,workDrained:true});})};
 const stopped=s.app.shutdown();await new Promise(resolve=>setImmediate(resolve));
 try{
  assert.equal((await s.request(s.path+'shutdown',{})).status,400);
  assert.equal((await s.request(s.path+'shutdown',{}, {'x-lifestream-csrf':'synthetic-wrong'})).status,403);
  assert.equal((await s.request(s.path+'shutdown',{}, {cookie:''})).status,401);
  assert.equal((await s.request(s.path+'next',{})).status,503);
  assert.equal((await fetch(`http://127.0.0.1:${s.app.address().port}${s.path}shutdown`,{headers:s.headers})).status,503);
  assert.equal(s.app.database.connection.prepare('SELECT count(*) AS n FROM game_host_dispatch').get()!.n,0);
 }finally{finish();await stopped;}
});
test('chunked HTTP ingress applies the byte cap before JSON parsing and remains usable',async t=>{
 const s=await setup(t),url=`http://127.0.0.1:${s.app.address().port}${s.path}attach`;
 const status=await new Promise<number>((resolve,reject)=>{const req=httpRequest(url,{method:'POST',headers:s.headers},response=>{response.resume();response.once('end',()=>resolve(response.statusCode!));});req.once('error',reject);req.write('x'.repeat(70000));req.end('x'.repeat(70000));});assert.equal(status,413);assert.equal((await s.request(s.path+'attach',s.metadata)).status,200);assert.equal(s.app.database.connection.prepare('SELECT count(*) AS n FROM game_host_dispatch').get()!.n,0);
});
test('host HTTP uses real local auth, strict origin/CSRF, closed bounds and owned actor/session/endpoint/relationship',async t=>{
 const s=await setup(t);assert.equal((await s.request(s.path+'attach',s.metadata,{cookie:''})).status,401);assert.equal((await s.request(s.path+'attach',s.metadata,{origin:'https://synthetic-invalid.example'})).status,403);assert.equal((await s.request(s.path+'attach',s.metadata,{'x-lifestream-csrf':'synthetic-wrong'})).status,403);
 assert.equal((await s.request(s.path+'attach',{...s.metadata,scope:{...s.metadata.scope,principalId:randomUUID()}})).status,403);assert.equal((await s.request(s.path+'attach',{...s.metadata,scope:{...s.metadata.scope,relationshipId:randomUUID()}})).status,403);assert.equal((await s.request(s.path+'attach',{...s.metadata,scope:{...s.metadata.scope,contextBinding:{...s.metadata.scope.contextBinding,endpointId:randomUUID()}}})).status,403);
 assert.equal((await s.request(s.path+'attach',{...s.metadata,credential:'synthetic'})).status,400);assert.equal((await s.request(s.path+'attach',{...s.metadata,extra:'x'.repeat(131072)})).status,413);
 const response=await s.request(s.path+'attach',s.metadata);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));const attached=await response.json() as {attachmentId:string};assert.equal((await s.request(s.path+'attach',s.metadata)).status,409);
 const activity=s.app.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(s.session.sessionId)!.admin_last_activity;
 s.advance(1_800_000);assert.equal((await s.request(s.path+'next',{protocol,attachmentId:attached.attachmentId})).status,200);assert.equal(s.app.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(s.session.sessionId)!.admin_last_activity,activity);assert.equal((await s.request(s.path+'attach',{...s.metadata,hostId:randomUUID()})).status,401);
 assert.equal((await s.request('/api/auth/v1/sign-out',{})).status,200);assert.equal((await s.request(s.path+'next',{protocol,attachmentId:attached.attachmentId})).status,401);
});
for(const changed of ['permission','endpoint','relationship','source'] as const)test('host HTTP fences '+changed+' withdrawal without native dispatch',async t=>{
 const s=await setup(t),response=await s.request(s.path+'attach',s.metadata);assert.equal(response.status,200);const attached=await response.json() as {attachmentId:string};
 if(changed==='permission')s.app.database.connection.prepare('UPDATE local_assistant_permissions SET administer=0 WHERE principal_id=? AND assistant_id=?').run(s.session.principalId,s.metadata.scope.assistantId);
 if(changed==='endpoint')assert.equal((await s.request('/api/runtime/v1/session-context',{expectedRevision:1,mode:'text',audienceScope:'unknown'})).status,200);
 if(changed==='relationship')s.app.database.connection.prepare('UPDATE assistant_relationships SET payload_json=? WHERE relationship_id=?').run(JSON.stringify({status:'skipped'}),s.metadata.scope.relationshipId);
 if(changed==='source')s.withdraw();
 assert.ok([403,410].includes((await s.request(s.path+'next',{protocol,attachmentId:attached.attachmentId})).status));assert.equal(s.app.database.connection.prepare('SELECT count(*) AS n FROM game_host_dispatch').get()!.n,0);
});
for(const completed of [true,false])test('authenticated HTTP prepared controller '+(completed?'settles qualified receipt':'retains entered reservation after sign-out'),async t=>{
 const s=await setup(t);const response=await s.request(s.path+'attach',s.metadata);assert.equal(response.status,200);const attachment=await response.json() as {attachmentId:string};
 const pending=s.hostJoin().runController(s.f.input,{signal:s.f.controller.signal,current:s.f.ports.current,usageFor:s.f.ports.usageFor});
 const next=await s.request(s.path+'next',{protocol,attachmentId:attachment.attachmentId});assert.equal(next.status,200);const event=await next.json() as import('@lifestream/contracts/game-host').GameHostCommand;assert.equal(event.kind,'command');assert.equal(s.app.database.connection.prepare('SELECT state FROM game_host_dispatch').get()!.state,'claimed');
 const admission={protocol,attachmentId:event.attachmentId,commandId:event.commandId,requestDigest:event.requestDigest};assert.equal((await s.request(s.path+'admit',admission)).status,200);assert.equal((await s.request(s.path+'admit',admission)).status,409);
 if(completed){const result=await s.f.rawAdapter.applyController(event.request as never);assert.equal((await s.request(s.path+'result',{...admission,result,resultDigest:gameHostDigest(result)})).status,200);assert.equal((await pending).state,'settled');}
 else{assert.equal((await s.request('/api/auth/v1/sign-out',{})).status,200);assert.equal((await s.request(s.path+'admit',admission)).status,401);assert.equal((await pending).state,'requiresReconciliation');assert.equal(s.app.database.connection.prepare('SELECT state FROM activity_controller_reservations').get()!.state,'reserved');assert.equal(s.f.calls(),0);}
});

test('production host exposes authentic scoped planning through the existing server and preserves P2 gate',async t=>{
 const s=await setup(t,true,true),response=await s.request(s.path+'attach',s.metadata);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
 const runtime=s.hostJoin().runtime!;assert.ok(runtime);assert.equal(runtime.controllerCurrent(),false);
 const selection=selectGameCampaignContext(s.f.f.input,s.f.f.boundary),step=runtime.preparePlanning(selection,{maximumInputTokens:4096,maximumOutputTokens:32,maximumOutputBytes:8192,maximumChunks:128,deadlineMs:10000});
 const req=requestForFinalizedTurn(step.turn,step.binding,runtime.isCurrent);assert.equal(req.sections.length,9);assert.equal(req.sections[8].content,'');assert.match(req.sections[3].content,/origin=activityStep;/);assert.match(req.sections[7].content,/Untrusted logical activity context/);assert.equal(step.binding.scope.sessionId,s.session.sessionId);assert.equal(step.binding.scope.principalId,s.session.principalId);
 const internals=s.app as unknown as {providers:{providers:{inference:{fixture:boolean}}}};internals.providers.providers.inference={...internals.providers.providers.inference,fixture:false};
 const result=await runtime.runPlanning(step,{current:()=>true,terminalRef:()=>null,publishDecision:()=>false});assert.equal(result.state,'suppressed');assert.equal(result.reason,'providerPriorityUnverified');
 assert.equal((await runtime.runPlanning(step,{current:()=>true,terminalRef:()=>null,publishDecision:()=>false})).state,'suppressed');
 assert.equal((await s.hostJoin().runController(s.f.input,{signal:s.f.controller.signal,current:s.f.ports.current,usageFor:s.f.ports.usageFor})).adapterInvoked,false);
 assert.equal(s.app.database.connection.prepare('SELECT count(*) AS n FROM game_host_dispatch').get()!.n,0);assert.equal(s.app.database.connection.prepare('SELECT count(*) AS n FROM activity_planning_reservations').get()!.n,0);
});
for(const cause of ['logout','approval','source']as const)test('scoped production planning fences '+cause+' without using a fresh account or coordinator',async t=>{
 const s=await setup(t,true,true),response=await s.request(s.path+'attach',s.metadata);assert.equal(response.status,200);const runtime=s.hostJoin().runtime!;
 if(cause==='logout')assert.equal((await s.request('/api/auth/v1/sign-out',{})).status,200);if(cause==='approval')s.withdrawApproval();if(cause==='source')s.withdraw();
 assert.equal(runtime.isCurrent(),false);assert.throws(()=>runtime.preparePlanning(selectGameCampaignContext(s.f.f.input,s.f.f.boundary),{maximumInputTokens:4096,maximumOutputTokens:32,maximumOutputBytes:8192,maximumChunks:128,deadlineMs:10000}),/unavailable/);assert.equal(s.f.calls(),0);
});

function ownedPng(){
 const chunk=(type:string,data:Buffer)=>{const head=Buffer.alloc(8),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);head.write(type,4);tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4),data])));return Buffer.concat([head,data,tail]);},header=Buffer.alloc(13);
 header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0]))),chunk('IEND',Buffer.alloc(0))]);
}
async function ownedFrameSetup(t:import('node:test').TestContext){
 const s=await setup(t,true,false,true),attached=await s.request(s.path+'attach',s.metadata);assert.equal(attached.status,200);
 const attachment=await attached.json() as {attachmentId:string},controller=new AbortController();t.after(()=>controller.abort());
 const scope=s.metadata.scope,request:import('@lifestream/contracts/game-activity').GameObserveRequest={schemaVersion:'1.0.0',operation:'GameActivityAdapter.observe',requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:new Date(Date.now()+5000).toISOString(),cancellationId:randomUUID(),executionMode:'normal',scope,idempotencyKey:randomUUID(),payload:{expectedPinsDigest:s.metadata.pinsDigest,afterActionId:null,maxScreenshots:1}};
 const pending=s.hostJoin().adapter.observe(request,{signal:controller.signal,isCurrent:()=>true}).then(result=>({result,error:null}),error=>({result:null,error}));
 const next=await s.request(s.path+'next',{protocol,attachmentId:attachment.attachmentId});assert.equal(next.status,200);
 const event=await next.json() as import('@lifestream/contracts/game-host').GameHostCommand;assert.equal(event.kind,'command');
 const admission={protocol,attachmentId:event.attachmentId,commandId:event.commandId,requestDigest:event.requestDigest},bytes=ownedPng(),mediaRef=randomUUID(),time=new Date().toISOString();
 const observation=structuredClone(s.f.f.input.observation);observation.scope=structuredClone(scope);observation.facts=[];observation.visibleState=[];observation.capturedAt=time;observation.receivedAt=time;
 const shot={screenshotId:mediaRef,mediaRef,sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,mediaType:'image/png' as const,width:1,height:1,capturedAt:time,frameNumber:observation.frameNumber,expiresAt:new Date(Date.now()+10000).toISOString()};observation.screenshots=[shot];
 const result:import('@lifestream/contracts/game-activity').GameObserveResult={schemaVersion:'1.0.0',operation:request.operation,requestId:request.requestId,correlationId:request.correlationId,providerRef:s.metadata.providerRef,completedAt:time,outcome:{status:'succeeded',error:null,payload:{observation,reconciledAction:null}}};
 const port=(s.app as unknown as {gameHost:GameHostPort}).gameHost;
 const upload=(data:Buffer=bytes,extra:Record<string,string>={},digest=event.requestDigest)=>fetch(`http://127.0.0.1:${s.app.address().port}${s.path}frame/${event.attachmentId}/${event.commandId}/${digest}/${mediaRef}`,{method:'POST',headers:{...s.headers,'content-type':'image/png',...extra},body:data});
 const complete=()=>s.request(s.path+'result',{...admission,result,resultDigest:gameHostDigest(result)});
 return {s,port,controller,pending,event,admission,bytes,observation,shot,upload,complete};
}
test('owned PNG HTTP uses real auth, admitted observe identity and single-use exact metadata consumption',async t=>{
 const f=await ownedFrameSetup(t);
 assert.equal((await f.upload(f.bytes,{cookie:''})).status,401);
 assert.equal((await f.upload(f.bytes,{origin:'https://fixture.invalid'})).status,403);
 assert.equal((await f.upload(f.bytes,{'x-lifestream-csrf':'wrong'})).status,403);
 assert.equal((await f.upload()).status,409); // no native admission yet
 assert.equal((await f.s.request(f.s.path+'admit',f.admission)).status,200);
 assert.equal((await f.upload(f.bytes,{},'f'.repeat(64))).status,409);
 assert.equal((await f.upload()).status,200);assert.equal((await f.upload()).status,409);
 assert.equal((await f.complete()).status,200);assert.equal((await f.pending).result!.outcome.status,'succeeded');
 assert.equal(f.port.consumeOwnedFrame({...f.observation.scope,runId:randomUUID()},f.observation,f.shot),null);
 assert.equal(f.port.consumeOwnedFrame(f.observation.scope,f.observation,{...f.shot,sha256:'f'.repeat(64)}),null);
 const owned=f.port.consumeOwnedFrame(f.observation.scope,f.observation,f.shot);assert.deepEqual(owned,f.bytes);
 assert.equal(f.port.consumeOwnedFrame(f.observation.scope,f.observation,f.shot),null);owned!.fill(0);
 assert.equal(f.s.app.database.connection.prepare('SELECT count(*) AS n FROM game_host_dispatch').get()!.n,0);
});
for(const mode of ['corrupt','oversize','mediaType'] as const)test('owned PNG HTTP rejects '+mode+' and cancels the one charged upload',async t=>{
 const f=await ownedFrameSetup(t);assert.equal((await f.s.request(f.s.path+'admit',f.admission)).status,200);
 const bytes=mode==='corrupt'?Buffer.from(f.bytes):mode==='oversize'?Buffer.alloc(2097153):f.bytes;if(mode==='corrupt')bytes[bytes.length-1]^=1;
 const response=await f.upload(bytes,mode==='mediaType'?{'content-type':'application/octet-stream'}:{});assert.notEqual(response.status,200);
 assert.ok((await f.pending).error instanceof Error);assert.equal((await f.upload()).status,409);
 assert.equal(f.port.consumeOwnedFrame(f.observation.scope,f.observation,f.shot),null);
});
for(const reason of ['cancellation','source','logout','metadata'] as const)test('owned PNG '+reason+' discards and zeros bytes before use',async t=>{
 const f=await ownedFrameSetup(t);assert.equal((await f.s.request(f.s.path+'admit',f.admission)).status,200);assert.equal((await f.upload()).status,200);
 const held=(f.port as unknown as {frame:{bytes:Buffer}}).frame.bytes;
 if(reason==='metadata'){f.shot.sha256='f'.repeat(64);assert.equal((await f.complete()).status,409);f.controller.abort();}
 if(reason==='cancellation')f.controller.abort();
 if(reason==='source'){f.s.withdraw();await f.s.request(f.s.path+'next',{protocol,attachmentId:f.event.attachmentId});}
 if(reason==='logout')assert.equal((await f.s.request('/api/auth/v1/sign-out',{})).status,200);
 assert.ok((await f.pending).error instanceof Error);assert.ok(held.every(byte=>byte===0));
 assert.equal(f.port.consumeOwnedFrame(f.observation.scope,f.observation,f.shot),null);
});

test('owned PNG expiry zeros retained bytes and forbids late consumption',async t=>{
 const f=await ownedFrameSetup(t);assert.equal((await f.s.request(f.s.path+'admit',f.admission)).status,200);assert.equal((await f.upload()).status,200);
 f.shot.expiresAt=new Date(Date.now()+150).toISOString();assert.equal((await f.complete()).status,200);assert.ok((await f.pending).result);
 const held=(f.port as unknown as {frame:{bytes:Buffer}}).frame.bytes;await new Promise(resolve=>setTimeout(resolve,180));
 assert.ok(held.every(byte=>byte===0));assert.equal(f.port.consumeOwnedFrame(f.observation.scope,f.observation,f.shot),null);
});
async function compositionFixture(t:import('node:test').TestContext){
 const s=await setup(t),attachment=structuredClone(s.metadata),root=await mkdtemp(join(tmpdir(),'ls-observation-composition-'));t.after(()=>rm(root,{recursive:true,force:true}));
 // Synthetic trusted host ports exercise composition mechanics, never native qualification.
 attachment.scope.contextBinding.sessionId=null as unknown as string;attachment.scope.contextBinding.conversationId=null as unknown as string;
 const configuration:ReviewedGameObservationRun={schemaVersion:'1.0.0',recordType:'reviewedGameObservationRun',approvedUntil:new Date(Date.now()+60000).toISOString(),attachment,vision:{pid:1,processStartTicks:'1',configurationDigest:'e'.repeat(64),qualificationRef:'fixture:synthetic-not-native-qualification',qualificationReceiptSha256:'f'.repeat(64),binarySha256:'7c1f73825337d8839d21debc4340ebdbca1da508a538cec50fe42f86e486d66f',projectorSha256:'a2c009ea5ab5479383729820f49163e067ee4e46817e8d875f0cead17ffd2c46',modelSha256:'66bb238d41de38b11dd406d932d8fb97433d529022cef60f2f422b9221cae743'}};
 let current=true,calls=0,observes=0,closed=0;let owned:Buffer|undefined;
 const coordinator=new UnderstandingWorkCoordinator({pressureAllowsWork:()=>true}),bytes=ownedPng(),observation=structuredClone(s.f.f.input.observation),time=new Date().toISOString(),mediaRef=randomUUID();
 observation.scope=structuredClone(s.metadata.scope);observation.facts=[];observation.visibleState=[];observation.capturedAt=observation.receivedAt=time;observation.screenshots=[{screenshotId:mediaRef,mediaRef,sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,mediaType:'image/png',width:1,height:1,capturedAt:time,frameNumber:observation.frameNumber,expiresAt:new Date(Date.now()+10000).toISOString()}];
 const provider={async *generateGameFrame(){calls++;yield {kind:'text',text:JSON.stringify({kind:'unknown',scene:'One synthetic red pixel.',text:[],uncertainty:'Synthetic fixture; no native game.'})};yield {kind:'done'};}};
 const ports={database:()=>s.app.database,provider:()=>provider as unknown as import('@lifestream/providers-sglang').SglangInferenceProvider,runBackground:<T>(work:import('@lifestream/runtime/understanding/coordinator').BackgroundWork<T>)=>coordinator.run(work),runtimeCurrent:()=>current,visionCurrent:()=>current,configurationDigest:()=>'e'.repeat(64),artifactDirectory:()=>root,readFrame:()=>owned=Buffer.from(bytes),closeAttachment:()=>{closed++;}};
 const composition=createReviewedGameObservationComposition(configuration,ports);t.after(()=>composition.stop());
 const actor={principalId:s.session.principalId,sessionId:s.session.sessionId,isCurrent:()=>true};
 const hostJoin={attachmentId:randomUUID(),scope:s.metadata.scope,runtime:{isCurrent:()=>current},adapter:{observe:async(request:import('@lifestream/contracts/game-activity').GameObserveRequest)=>{observes++;return {schemaVersion:'1.0.0',operation:request.operation,requestId:request.requestId,correlationId:request.correlationId,providerRef:s.metadata.providerRef,completedAt:time,outcome:{status:'succeeded',error:null,payload:{observation:structuredClone(observation),reconciledAction:null}}};}}} as unknown as GameHostJoin;
 const receipt=async()=>{for(let i=0;i<100;i++){const files=await readdir(root);if(files.length)return JSON.parse(await readFile(join(root,files[0]!),'utf8'));await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Synthetic composition receipt missing');};
 return {s,configuration,composition,actor,hostJoin,provider,receipt,coordinator,counts:()=>({calls,observes,closed}),owned:()=>owned,withdraw:()=>current=false};
}
test('reviewed composition fixture derives only actual transport IDs, observes once through existing coordinator and writes one metadata receipt',async t=>{
 const f=await compositionFixture(t);
 assert.equal(f.composition.gameHost.resolveAttachment(f.actor,{...f.s.metadata,sourceRevision:'c'.repeat(64)}),null);
 assert.equal(f.composition.gameHost.resolveAttachment(f.actor,{...f.s.metadata,scope:{...f.s.metadata.scope,contextBinding:{...f.s.metadata.scope.contextBinding,conversationId:randomUUID()}}}),null);
 assert.ok(f.composition.gameHost.resolveAttachment(f.actor,f.s.metadata));assert.equal(f.composition.gameHost.resolveAttachment(f.actor,f.s.metadata),null);
 assert.equal(f.composition.gameRuntime.resolveApproval(f.s.metadata.scope)!.controllerInput,false);assert.equal(f.composition.gameRuntime.resolveApproval(f.s.metadata.scope)!.memoryEpisodes,false);
 f.composition.gameHost.onAttached!(f.hostJoin);const receipt=await f.receipt();assert.equal(receipt.state,'observed');assert.deepEqual(f.counts(),{calls:1,observes:1,closed:1});assert.ok(f.owned()!.every(b=>b===0));assert.equal(f.coordinator.isIdle(),true);
 assert.equal(receipt.planningCalls,0);assert.equal(receipt.controllerCalls,0);assert.equal(receipt.memoryWrites,0);assert.equal(receipt.visionCalls,1);assert.equal(receipt.rawFramesRetained,false);assert.equal(receipt.meaningfulGameplayAccepted,false);assert.deepEqual(receipt.observation.visibleState,[]);assert.ok(receipt.observation.facts.every((fact:{untrusted:boolean;epistemicKind:string})=>fact.untrusted&&fact.epistemicKind==='inference'));
 assert.throws(()=>f.composition.gameHost.onAttached!(f.hostJoin));
});
for(const changed of ['configuration','providerWithdrawal'] as const)test('reviewed composition fixture discards '+changed+' during selected provider inference',async t=>{
 const f=await compositionFixture(t);assert.ok(f.composition.gameHost.resolveAttachment(f.actor,f.s.metadata));
 f.provider.generateGameFrame=async function*(){if(changed==='configuration')f.configuration.vision.configurationDigest='a'.repeat(64);else f.withdraw();yield {kind:'text',text:JSON.stringify({kind:'unknown',scene:'Synthetic pixel.',text:[],uncertainty:'Fixture only.'})};yield {kind:'done'};};
 f.composition.gameHost.onAttached!(f.hostJoin);const receipt=await f.receipt();assert.equal(receipt.state,'unavailable');assert.equal(receipt.observation,null);assert.equal(f.counts().closed,1);assert.ok(f.owned()!.every(b=>b===0));assert.equal(f.coordinator.isIdle(),true);
});
test('reviewed configuration rejects guessed transport IDs, extended expiry and artifact mismatch; synthetic PID never qualifies production',async t=>{
 const f=await compositionFixture(t);assert.equal(qualifiedCtVisionCurrent(f.configuration,'e'.repeat(64)),false);
 for(const mode of ['session','expiry','projector','extra']as const){const c=structuredClone(f.configuration);if(mode==='session')(c.attachment as typeof f.s.metadata).scope.contextBinding.sessionId=randomUUID();if(mode==='expiry')c.approvedUntil=new Date(Date.now()+120001).toISOString();if(mode==='projector')c.vision.projectorSha256='a'.repeat(64);if(mode==='extra')Object.assign(c.vision,{controllerInput:true});assert.throws(()=>validateReviewedGameObservationRun(c),mode);}
});
