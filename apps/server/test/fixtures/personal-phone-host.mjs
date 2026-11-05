// Disposable loopback host, original routes/Auth/History, controlled providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,chmodSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket} from '../../../../node_modules/ws/wrapper.mjs';
import {AssistantProfileRepository} from '../../../../packages/storage-sqlite/dist/index.js';
import {unifiedDesktopContractPin} from '../../../../packages/contracts/dist/unified-desktop-contracts.js';

import {loadProfile} from '../../src/config/loader.ts';
import {readSessionEndpoint} from '../../src/runtime/session-context.ts';

// Redirect only this disposable test process's audit object BEFORE importing the server.
// Neither the production switch nor its private storage is accessed by this harness.
import {audit,createAudit} from '../../src/runtime/bounded-audit.mjs';
const auditFixtureRoot=mkdtempSync(join(realpathSync(tmpdir()),'audit-enrollment-fixture-'));
chmodSync(auditFixtureRoot,0o700);
const isolatedAudit=createAudit({root:auditFixtureRoot,timers:false});
Object.assign(audit,isolatedAudit,{start(){}});
const {createLifestreamServer}=await import('../../src/index.ts');
const secret=()=>randomBytes(32).toString('hex'),pin=unifiedDesktopContractPin('conversation-history'),route='/api/runtime/v1/conversations';
const envelope=(operation,payload)=>({producerPin:pin,request:{schemaVersion:'1.0.0',operation,operationId:randomUUID(),...(operation==='create'?{idempotencyKey:randomUUID()}:{}),payload}});
const settle=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));};
const wait=async check=>{for(let i=0;i<1000&&!check();i++)await new Promise(r=>setTimeout(r,5));assert.ok(check(),'Controlled original route phase was not reached');};
async function fixture({enabled=true,selected=true,holdGeneration=false,endpointClass='desktopCompanion',retentionMode=true,persistentSession=false,personalPhoneAccess}={}){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'voice-history-http-'));chmodSync(root,0o700);const mask=process.umask(0o077),config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'test.sqlite'),artifactDirectory:join(root,'artifacts')};
 let authNow=Date.now();const installerToken=secret(),serverOptions={config,personalPhoneAccess,audiencePrivacy:{},historyRetention:retentionMode?{mode:'localUserConsent',retention:'untilDeletion',journalInitialization:'initializeEmpty'}:{mode:'disabled'},historyStateRoot:root,localAuth:{stateDirectory:join(root,'auth'),installerToken,now:()=>authNow,...(persistentSession?{personalSessionPolicy:{enabled:true,scope:'installationOwner',expiration:'untilRevoked',windowFocusRequired:false}}:{})}};let app=createLifestreamServer(serverOptions);let release,owner;const gate=new Promise(r=>{release=r;}),sockets=new Set(),calls={stt:0,inference:0,tts:0};
 try{
  await app.start();
  app.providers.stt={async *transcribe(){calls.stt++;yield {kind:'data',payload:{type:'committed',text:'Controlled normal-route voice question'}};yield {kind:'terminal',outcome:'succeeded'};}};
  app.providers.inference={async *generate(){calls.inference++;yield {kind:'text',text:JSON.stringify({version:'voice-response/1'})+'\n'+JSON.stringify({channel:'speech',text:'Controlled normal-route voice reply.'})+'\n'};if(holdGeneration){await gate;yield {kind:'text',text:JSON.stringify({channel:'speech',text:'Synthetic continuation after audit stop.'})+'\n'};}yield {kind:'done'};}};
  app.providers.tts={async *synthesize(input){calls.tts++;yield {kind:'data',segmentId:input.segmentId,frame:{frameId:randomUUID(),sequence:0,format:input.format,sampleOffset:0,sampleCount:480,dataBase64:Buffer.alloc(960).toString('base64')}};yield {kind:'terminal',outcome:'succeeded'};}};
  const base=`http://127.0.0.1:${app.address().port}`;
  const request=(path,body,headers={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin:base,'content-type':'application/json',...(owner?{cookie:owner.cookie,'x-lifestream-csrf':owner.csrf,...(owner.contextRef?{'x-lifestream-user-context':owner.contextRef}:{})}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
  const setupPassword=secret(),setup=await request('/api/auth/v1/setup',{username:'synthetic-owner',password:setupPassword,installerToken});assert.equal(setup.status,201);const {session}=await setup.json();owner={sessionId:session.sessionId,principalId:session.principalId,csrf:session.csrfToken,cookie:setup.headers.get('set-cookie').split(';')[0],contextRef:''};
  const userContext=await request('/api/auth/v1/user-context');assert.equal(userContext.status,200);owner.contextRef=(await userContext.json()).contextRef;
  const initial=await request('/api/runtime/v1/session-context');assert.equal(initial.status,200);const sessionResponse=await request('/api/runtime/v1/session-context',{expectedRevision:(await initial.json()).revision,mode:'audio',audienceScope:'authenticatedSession',endpointClass,bindingKey:randomUUID()});assert.equal(sessionResponse.status,200,await sessionResponse.clone().text());

  const initialPersonal=await (await request('/api/runtime/v1/audience/personal-session')).json();const boundSession=await (await request('/api/runtime/v1/session-context')).json();if(!personalPhoneAccess||endpointClass!=='personalCompanion'){const openedSession=await request('/api/runtime/v1/audience/personal-session',{operation:'unlock',operationId:randomUUID(),declarationId:randomUUID(),expectedAudienceRevision:initialPersonal.revision,expectedPersonalSessionEpoch:initialPersonal.personalSessionEpoch,expectedSessionRevision:boundSession.revision,endpointId:boundSession.endpoint.endpointId,expectedEndpointRevision:boundSession.endpoint.configurationRevision});assert.equal(openedSession.status,200);}
  const profile=new AssistantProfileRepository(app.database),assistantId=randomUUID();const createProfile=id=>{profile.create({schemaVersion:'2.0.0',assistantId:id,profileId:randomUUID(),revision:1,status:'draft',createdBy:owner.principalId,createdAt:new Date().toISOString()});app.localAuth.permitCreator(app.localAuth.hostSessionContext(owner.sessionId),id);};createProfile(assistantId);
  const refreshed=await request('/api/auth/v1/user-context');assert.equal(refreshed.status,200);owner.contextRef=(await refreshed.json()).contextRef;
  if(endpointClass==='desktopCompanion'){const retention=await request('/api/runtime/v1/conversation-retention',{assistantId,schemaVersion:'1.0.0',operation:'set',expectedRevision:0,enabled,retention:'untilDeletion',bodyScope:'textAndTranscripts'});assert.equal(retention.status,200,await retention.clone().text());}
  const created=await request(route,envelope('create',{assistantId,title:'Synthetic voice route'}));assert.equal(created.status,200);const conversationId=(await created.json()).result.conversationId;
  const select=async(id,assistant=assistantId)=>{const value=await request(route+'/select',{producerPin:pin,conversationId:id,assistantId:assistant,expectedSessionRevision:readSessionEndpoint(app.database,owner.sessionId).revision});assert.equal(value.status,200,await value.clone().text());};if(selected)await select(conversationId);

  return {initialPersonal,get app(){return app;},owner,
   async signIn(){const response=await request('/api/auth/v1/sign-in',{username:'synthetic-owner',password:setupPassword,totp:''});assert.equal(response.status,200,await response.clone().text());const {session}=await response.json();Object.assign(owner,{sessionId:session.sessionId,principalId:session.principalId,csrf:session.csrfToken,cookie:response.headers.get('set-cookie').split(';')[0],contextRef:''});const context=await request('/api/auth/v1/user-context');assert.equal(context.status,200);owner.contextRef=(await context.json()).contextRef;},
   async restart(personalPhoneAccess=serverOptions.personalPhoneAccess){const port=app.address().port,providers={stt:app.providers.stt,inference:app.providers.inference,tts:app.providers.tts};for(const socket of sockets)socket.terminate();await app.shutdown();serverOptions.personalPhoneAccess=personalPhoneAccess;app=createLifestreamServer({...serverOptions,port});await app.start();Object.assign(app.providers,providers);},assistantId,conversationId,request,select,calls,release,advance:ms=>{authNow+=ms;},
   async otherConversation(){const id=randomUUID();createProfile(id);const response=await request(route,envelope('create',{assistantId:id,title:'Other synthetic chat'}));assert.equal(response.status,200);return {assistantId:id,conversationId:(await response.json()).result.conversationId};},
   async page(){const response=await request(route,envelope('page',{conversationId,direction:'older',pageSize:50}));assert.equal(response.status,200,await response.clone().text());return (await response.json()).result.entries;},
   rows:()=>app.database.connection.prepare('SELECT speaker,state,modality,retained_text FROM conversation_timeline ORDER BY ordinal').all(),
   async connect(reference=owner.contextRef,requestOverrides={},auditHeaders={}){let completedTurns=0;const events=[],socket=new WebSocket(base.replace('http:','ws:')+'/api/runtime/v1/audio?userContextRef='+encodeURIComponent(reference),{headers:{origin:base,cookie:owner.cookie,...auditHeaders}});sockets.add(socket);socket.on('message',raw=>events.push(JSON.parse(raw)));await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});const inputId=randomUUID(),endpoint=readSessionEndpoint(app.database,owner.sessionId);socket.send(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId:owner.sessionId,assistantId,expectedSessionRevision:endpoint.revision,endpointId:endpoint.endpoint.endpointId,audioInputId:inputId,format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1},...requestOverrides}}));return {socket,events,async start(){await wait(()=>events.some(e=>e.type==='accepted'||e.type==='error'));assert.ok(events.some(e=>e.type==='accepted'),JSON.stringify(events));},turn(){socket.send(JSON.stringify({type:'frame',audioInputId:inputId,frame:{frameId:randomUUID(),sequence:0,format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1},sampleOffset:0,sampleCount:4800,dataBase64:Buffer.alloc(9600).toString('base64')}}));socket.send(JSON.stringify({type:'commitTurn',audioInputId:inputId,nextSequence:1,sampleCount:4800}));},async complete(){await wait(()=>events.filter(e=>e.event?.payload.type==='terminal').length>completedTurns);completedTurns++;const terminal=events.filter(e=>e.event?.payload.type==='terminal').at(-1);assert.equal(terminal.event.payload.state,'completed',JSON.stringify(terminal));socket.send(JSON.stringify({type:'playbackSettled',interactionTraceId:terminal.event.interactionTraceId,outcome:'completed',receivedSamples:events.filter(e=>e.type==='audio'&&e.interactionTraceId===terminal.event.interactionTraceId).reduce((n,e)=>n+e.chunk.frame.sampleCount,0)}));await settle();}};},
   async close(){release();for(const socket of sockets)socket.terminate();await app.shutdown();process.umask(mask);rmSync(root,{recursive:true,force:true});}
  };
 }catch(error){release();for(const socket of sockets)socket.terminate();await app.shutdown();process.umask(mask);rmSync(root,{recursive:true,force:true});throw error;}
}

export {fixture,auditFixtureRoot,isolatedAudit,settle,wait};
