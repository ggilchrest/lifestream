// Disposable loopback host, original routes/Auth/History, controlled providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,chmodSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket} from 'ws';
import {AssistantProfileRepository} from '@lifestream/storage-sqlite';
import {unifiedDesktopContractPin} from '@lifestream/contracts/unified-desktop-contracts';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {readSessionEndpoint} from '../src/runtime/session-context.ts';
const secret=()=>randomBytes(32).toString('hex'),pin=unifiedDesktopContractPin('conversation-history'),route='/api/runtime/v1/conversations';
const envelope=(operation,payload)=>({producerPin:pin,request:{schemaVersion:'1.0.0',operation,operationId:randomUUID(),...(operation==='create'?{idempotencyKey:randomUUID()}:{}),payload}});
const settle=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));};
const wait=async check=>{for(let i=0;i<100&&!check();i++)await new Promise(r=>setTimeout(r,5));assert.ok(check(),'Controlled original route phase was not reached');};
async function fixture({enabled=true,selected=true,holdGeneration=false,endpointClass='desktopCompanion',retentionMode=true}={}){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'voice-history-http-'));chmodSync(root,0o700);const mask=process.umask(0o077),config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'test.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=secret(),app=createLifestreamServer({config,historyRetention:retentionMode?{mode:'localUserConsent',retention:'untilDeletion',journalInitialization:'initializeEmpty'}:{mode:'disabled'},historyStateRoot:root,localAuth:{stateDirectory:join(root,'auth'),installerToken}});let release,owner;const gate=new Promise(r=>{release=r;}),sockets=new Set(),calls={stt:0,inference:0,tts:0};
 try{
  await app.start();
  app.providers.stt={async *transcribe(){calls.stt++;yield {kind:'data',payload:{type:'committed',text:'Controlled normal-route voice question'}};yield {kind:'terminal',outcome:'succeeded'};}};
  app.providers.inference={async *generate(){calls.inference++;yield {kind:'text',text:JSON.stringify({version:'voice-response/1'})+'\n'+JSON.stringify({channel:'speech',text:'Controlled normal-route voice reply.'})+'\n'};if(holdGeneration){await gate;yield {kind:'text',text:'PRIVATE_LATE_AFTER_LOGOUT'};}yield {kind:'done'};}};
  app.providers.tts={async *synthesize(input){calls.tts++;yield {kind:'data',segmentId:input.segmentId,frame:{frameId:randomUUID(),sequence:0,format:input.format,sampleOffset:0,sampleCount:480,dataBase64:Buffer.alloc(960).toString('base64')}};yield {kind:'terminal',outcome:'succeeded'};}};
  const base=`http://127.0.0.1:${app.address().port}`;
  const request=(path,body,headers={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin:base,'content-type':'application/json',...(owner?{cookie:owner.cookie,'x-lifestream-csrf':owner.csrf,...(owner.contextRef?{'x-lifestream-user-context':owner.contextRef}:{})}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
  const setup=await request('/api/auth/v1/setup',{username:'synthetic-owner',password:secret(),installerToken});assert.equal(setup.status,201);const {session}=await setup.json();owner={sessionId:session.sessionId,principalId:session.principalId,csrf:session.csrfToken,cookie:setup.headers.get('set-cookie').split(';')[0],contextRef:''};
  const userContext=await request('/api/auth/v1/user-context');assert.equal(userContext.status,200);owner.contextRef=(await userContext.json()).contextRef;
  const initial=await request('/api/runtime/v1/session-context');assert.equal(initial.status,200);const sessionResponse=await request('/api/runtime/v1/session-context',{expectedRevision:(await initial.json()).revision,mode:'audio',audienceScope:'authenticatedSession',endpointClass,bindingKey:randomUUID()});assert.equal(sessionResponse.status,200,await sessionResponse.clone().text());
  const profile=new AssistantProfileRepository(app.database),assistantId=randomUUID();const createProfile=id=>{profile.create({schemaVersion:'2.0.0',assistantId:id,profileId:randomUUID(),revision:1,status:'draft',createdBy:owner.principalId,createdAt:new Date().toISOString()});app.localAuth.permitCreator(app.localAuth.hostSessionContext(owner.sessionId),id);};createProfile(assistantId);
  const refreshed=await request('/api/auth/v1/user-context');assert.equal(refreshed.status,200);owner.contextRef=(await refreshed.json()).contextRef;
  if(endpointClass==='desktopCompanion'){const retention=await request('/api/runtime/v1/conversation-retention',{assistantId,schemaVersion:'1.0.0',operation:'set',expectedRevision:0,enabled,retention:'untilDeletion',bodyScope:'textAndTranscripts'});assert.equal(retention.status,200,await retention.clone().text());}
  const created=await request(route,envelope('create',{assistantId,title:'Synthetic voice route'}));assert.equal(created.status,200);const conversationId=(await created.json()).result.conversationId;
  const select=async(id,assistant=assistantId)=>{const value=await request(route+'/select',{producerPin:pin,conversationId:id,assistantId:assistant,expectedSessionRevision:readSessionEndpoint(app.database,owner.sessionId).revision});assert.equal(value.status,200,await value.clone().text());};if(selected)await select(conversationId);

  return {app,owner,assistantId,conversationId,request,select,calls,release,
   async otherConversation(){const id=randomUUID();createProfile(id);const response=await request(route,envelope('create',{assistantId:id,title:'Other synthetic chat'}));assert.equal(response.status,200);return {assistantId:id,conversationId:(await response.json()).result.conversationId};},
   async page(){const response=await request(route,envelope('page',{conversationId,direction:'older',pageSize:50}));assert.equal(response.status,200,await response.clone().text());return (await response.json()).result.entries;},
   rows:()=>app.database.connection.prepare('SELECT speaker,state,modality,retained_text FROM conversation_timeline ORDER BY ordinal').all(),
   async connect(reference=owner.contextRef,requestOverrides={}){let completedTurns=0;const events=[],socket=new WebSocket(base.replace('http:','ws:')+'/api/runtime/v1/audio?userContextRef='+encodeURIComponent(reference),{headers:{origin:base,cookie:owner.cookie}});sockets.add(socket);socket.on('message',raw=>events.push(JSON.parse(raw)));await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});const inputId=randomUUID(),endpoint=readSessionEndpoint(app.database,owner.sessionId);socket.send(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId:owner.sessionId,assistantId,expectedSessionRevision:endpoint.revision,endpointId:endpoint.endpoint.endpointId,audioInputId:inputId,format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1},...requestOverrides}}));return {socket,events,async start(){await wait(()=>events.some(e=>e.type==='accepted'||e.type==='error'));assert.ok(events.some(e=>e.type==='accepted'),JSON.stringify(events));},turn(){socket.send(JSON.stringify({type:'frame',audioInputId:inputId,frame:{frameId:randomUUID(),sequence:0,format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1},sampleOffset:0,sampleCount:4800,dataBase64:Buffer.alloc(9600).toString('base64')}}));socket.send(JSON.stringify({type:'commitTurn',audioInputId:inputId,nextSequence:1,sampleCount:4800}));},async complete(){await wait(()=>events.filter(e=>e.event?.payload.type==='terminal').length>completedTurns);completedTurns++;const terminal=events.filter(e=>e.event?.payload.type==='terminal').at(-1);assert.equal(terminal.event.payload.state,'completed',JSON.stringify(terminal));socket.send(JSON.stringify({type:'playbackSettled',interactionTraceId:terminal.event.interactionTraceId,outcome:'completed',receivedSamples:events.filter(e=>e.type==='audio'&&e.interactionTraceId===terminal.event.interactionTraceId).reduce((n,e)=>n+e.chunk.frame.sampleCount,0)}));await settle();}};},
   async close(){release();for(const socket of sockets)socket.terminate();await app.shutdown();process.umask(mask);rmSync(root,{recursive:true,force:true});}
  };
 }catch(error){release();for(const socket of sockets)socket.terminate();await app.shutdown();process.umask(mask);rmSync(root,{recursive:true,force:true});throw error;}
}

test('normal authenticated audio upgrade binds the selected conversation and saves voice lifecycle once', {timeout:20000},async()=>{
 const f=await fixture();try{const voice=await f.connect();await voice.start();voice.turn();await voice.complete();const rows=await f.page();assert.equal(rows.length,2);assert.ok(rows.every(r=>r.modality==='voice'&&r.state==='completed'));assert.equal(rows.find(r=>r.speaker==='human').content.text,'Controlled normal-route voice question');assert.equal(rows.find(r=>r.speaker==='assistant').content.text,'Controlled normal-route voice reply.');assert.equal(new Set(rows.map(r=>r.turnId)).size,1);assert.equal((await f.page()).length,2);assert.deepEqual(f.calls,{stt:1,inference:1,tts:1});voice.turn();await voice.complete();const later=await f.page();assert.equal(later.length,4);assert.equal(new Set(later.map(r=>r.turnId)).size,2);assert.deepEqual(f.calls,{stt:2,inference:2,tts:2});}finally{await f.close();}
});
test('normal audio history honors existing saving-off consent without retaining bodies', {timeout:20000},async()=>{
 const f=await fixture({enabled:false});try{const voice=await f.connect();await voice.start();voice.turn();await voice.complete();const rows=await f.page();assert.equal(rows.length,2);assert.ok(rows.every(r=>r.content.state==='unavailable'));assert.ok(f.rows().every(r=>r.retained_text===null));}finally{await f.close();}
});
for(const cause of ['context','foreign-selected-assistant','session-revision','endpoint'])test('audio start cannot adopt a '+cause+' history binding', {timeout:20000},async()=>{
 const f=await fixture();try{if(cause==='foreign-selected-assistant'){const other=await f.otherConversation();await f.select(other.conversationId,other.assistantId);}const voice=await f.connect(cause==='context'?randomUUID():f.owner.contextRef,cause==='session-revision'?{expectedSessionRevision:-1}:cause==='endpoint'?{endpointId:randomUUID()}:{});await new Promise(r=>setTimeout(r,40));assert.equal(voice.events.some(e=>e.type==='accepted'),false);assert.deepEqual(f.calls,{stt:0,inference:0,tts:0});assert.equal(f.rows().length,0);}finally{await f.close();}
});
test('logout during original route generation retains only admitted partial metadata and fences late text', {timeout:20000},async()=>{
 const f=await fixture({holdGeneration:true});try{const voice=await f.connect();await voice.start();voice.turn();await wait(()=>voice.events.some(e=>e.event?.payload.type==='textDelta'));const logout=await f.request('/api/auth/v1/sign-out',{});assert.equal(logout.status,200);f.release();await wait(()=>voice.events.some(e=>e.type==='stopPlayback'||e.event?.payload.type==='terminal'));await settle();const rows=f.rows();assert.equal(rows.length,2);assert.equal(rows.find(r=>r.speaker==='assistant').state,'interrupted');assert.equal(rows.find(r=>r.speaker==='assistant').retained_text,'Controlled normal-route voice reply.');assert.doesNotMatch(JSON.stringify(voice.events),/PRIVATE_LATE_AFTER_LOGOUT/);}finally{await f.close();}
});
test('original fixture-authenticated unselected audio stays volatile', {timeout:20000},async()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'voice-history-legacy-'));const config=loadProfile('test');config.storage={databasePath:join(root,'test.sqlite'),artifactDirectory:join(root,'artifacts')};const app=createLifestreamServer({config});let socket;
 try{
  await app.start();app.providers.stt={async *transcribe(){yield {kind:'data',payload:{type:'committed',text:'Controlled legacy voice'}};yield {kind:'terminal',outcome:'succeeded'};}};app.providers.inference={async *generate(){yield {kind:'text',text:JSON.stringify({version:'voice-response/1'})+'\n'+JSON.stringify({channel:'speech',text:'Controlled legacy reply.'})+'\n'};yield {kind:'done'};}};app.providers.tts={async *synthesize(input){yield {kind:'data',segmentId:input.segmentId,frame:{frameId:randomUUID(),sequence:0,format:input.format,sampleOffset:0,sampleCount:480,dataBase64:Buffer.alloc(960).toString('base64')}};yield {kind:'terminal',outcome:'succeeded'};}};
  const sessionId=randomUUID(),audioInputId=randomUUID(),events=[],base=`http://127.0.0.1:${app.address().port}`;socket=new WebSocket(base.replace('http:','ws:')+'/api/runtime/v1/audio?fixtureSession='+sessionId+'&fixturePrincipal='+randomUUID(),{headers:{origin:base}});socket.on('message',raw=>events.push(JSON.parse(raw)));await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  const format={encoding:'pcm_s16le',sampleRateHz:16000,channels:1};socket.send(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,assistantId:randomUUID(),expectedSessionRevision:0,endpointId:randomUUID(),audioInputId,format}}));await wait(()=>events.some(e=>e.type==='accepted'));
  socket.send(JSON.stringify({type:'frame',audioInputId,frame:{frameId:randomUUID(),sequence:0,format,sampleOffset:0,sampleCount:4800,dataBase64:Buffer.alloc(9600).toString('base64')}}));socket.send(JSON.stringify({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:4800}));await wait(()=>events.some(e=>e.event?.payload.type==='terminal'));assert.equal(events.find(e=>e.event?.payload.type==='terminal').event.payload.state,'completed');assert.equal(app.database.connection.prepare('SELECT COUNT(*) AS n FROM conversation_timeline').get().n,0);
 }finally{socket?.terminate();await app.shutdown();rmSync(root,{recursive:true,force:true});}
});


test('legacy personal endpoint starts audio and preserves its newly adopted session conversation', {timeout:20000},async()=>{
 const f=await fixture({selected:false,endpointClass:'personalCompanion'});try{
  const id=f.app.database.connection.prepare("SELECT conversation_id FROM sessions WHERE id=?").get(f.owner.sessionId).conversation_id;
  assert.equal(f.app.database.connection.prepare('SELECT COUNT(*) n FROM conversation_catalog WHERE conversation_id=?').get(id).n,0);
  const voice=await f.connect();await voice.start();voice.turn();await voice.complete();
  const row=f.app.database.connection.prepare('SELECT assistant_id FROM conversation_catalog WHERE conversation_id=?').get(id);assert.equal(row.assistant_id,f.assistantId);
  assert.equal(f.rows().length,2);assert.ok(f.rows().every(row=>row.modality==='voice'));
 }finally{await f.close();}
});


test('legacy personal typed turn and voice share one durable session conversation', {timeout:20000},async()=>{
 const f=await fixture({selected:false,endpointClass:'personalCompanion'});try{
  const id=f.app.database.connection.prepare("SELECT conversation_id FROM sessions WHERE id=?").get(f.owner.sessionId).conversation_id;
  const typed=await f.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'Synthetic typed message'});
  assert.equal(typed.status,200,await typed.clone().text());await typed.text();
  const voice=await f.connect();await voice.start();voice.turn();await voice.complete();
  const entries=f.app.database.connection.prepare('SELECT modality,content_state FROM conversation_timeline WHERE conversation_id=? ORDER BY ordinal').all(id);
  assert.deepEqual(entries.map(row=>row.modality),['text','text','voice','voice']);assert.ok(entries.every(row=>row.content_state==='retained'),JSON.stringify(entries));
 }finally{await f.close();}
});


test('personal endpoint selects and reopens a named conversation', {timeout:20000},async()=>{
 const f=await fixture({selected:false,endpointClass:'personalCompanion'});try{
  const created=await f.request(route,envelope('create',{assistantId:f.assistantId,title:'Synthetic named thread'}));assert.equal(created.status,200);const id=(await created.json()).result.conversationId;
  await f.select(id);const session=await f.request('/api/runtime/v1/session-context');assert.equal(session.status,200);assert.equal((await session.json()).selectedConversation?.conversationId,id);
  const typed=await f.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'Synthetic named message'});assert.equal(typed.status,200,await typed.clone().text());await typed.text();
  const page=await f.request(route,envelope('page',{conversationId:id,direction:'older',pageSize:50}));assert.equal(page.status,200);assert.equal((await page.json()).result.entries.length,2);
 }finally{await f.close();}
});


test('legacy adoption fails closed when independent privacy evidence names the session', {timeout:20000},async()=>{
 const f=await fixture({selected:false,endpointClass:'personalCompanion'});try{
  const id=f.app.database.connection.prepare("SELECT conversation_id FROM sessions WHERE id=?").get(f.owner.sessionId).conversation_id;
  const journal=f.app.conversationRecoveryJournal,original=journal.snapshot.bind(journal);journal.snapshot=()=>({...original(),intents:[{conversationId:id}]});
  const typed=await f.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'Synthetic request'});assert.equal(typed.status,403);
  const voice=await f.connect();await new Promise(r=>setTimeout(r,80));assert.equal(voice.events.some(e=>e.type==='accepted'),false);assert.equal(f.app.database.connection.prepare('SELECT COUNT(*) n FROM conversation_catalog WHERE conversation_id=?').get(id).n,0);assert.deepEqual(f.calls,{stt:0,inference:0,tts:0});
 }finally{await f.close();}
});

test('legacy adoption denies an unauthorized assistant without creating a catalog', {timeout:20000},async()=>{
 const f=await fixture({selected:false,endpointClass:'personalCompanion'});try{
  const id=f.app.database.connection.prepare("SELECT conversation_id FROM sessions WHERE id=?").get(f.owner.sessionId).conversation_id,foreign=randomUUID();
  const typed=await f.request('/api/runtime/v1/messages',{assistantId:foreign,userInput:'Synthetic request'});assert.equal(typed.status,403);
  const voice=await f.connect(f.owner.contextRef,{assistantId:foreign});await new Promise(r=>setTimeout(r,80));assert.equal(voice.events.some(e=>e.type==='accepted'),false);assert.equal(f.app.database.connection.prepare('SELECT COUNT(*) n FROM conversation_catalog WHERE conversation_id=?').get(id).n,0);
 }finally{await f.close();}
});


test('legacy text and voice honor disabled body retention', {timeout:20000},async()=>{
 const f=await fixture({selected:false,endpointClass:'personalCompanion',retentionMode:false});try{
  const typed=await f.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'Synthetic message'});assert.equal(typed.status,200,await typed.clone().text());await typed.text();
  const voice=await f.connect();await voice.start();voice.turn();await voice.complete();assert.equal(f.rows().length,4);assert.ok(f.rows().every(row=>row.retained_text===null));
 }finally{await f.close();}
});

for(const invalid of ['session-revision','endpoint'])test('invalid '+invalid+' cannot adopt a legacy session', {timeout:20000},async()=>{
 const f=await fixture({selected:false,endpointClass:'personalCompanion'});try{
  const id=f.app.database.connection.prepare("SELECT conversation_id FROM sessions WHERE id=?").get(f.owner.sessionId).conversation_id;
  const voice=await f.connect(f.owner.contextRef,invalid==='endpoint'?{endpointId:randomUUID()}:{expectedSessionRevision:-1});await new Promise(r=>setTimeout(r,80));assert.equal(voice.events.some(e=>e.type==='accepted'),false);assert.equal(f.app.database.connection.prepare('SELECT COUNT(*) n FROM conversation_catalog WHERE conversation_id=?').get(id).n,0);
 }finally{await f.close();}
});
