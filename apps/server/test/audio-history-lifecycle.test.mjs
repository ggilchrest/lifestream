// Original AudioSession + Auth/Policy/Journal/SQLite owners; disposable state only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database,AssistantProfileRepository,ConversationHistoryRepository} from '@lifestream/storage-sqlite';
import {AudioSession} from '../src/runtime/audio.ts';
import {LocalAuthentication} from '../src/auth/local-auth.ts';
import {ConversationRetentionOwner} from '../src/runtime/conversation-retention-owner.ts';
import {ConversationRecoveryJournal} from '../src/admin/conversation-recovery-journal.ts';
import {bindDurableConversation} from '../src/runtime/conversation-history.ts';
import {ConversationHistory} from '../src/runtime/conversation.ts';
const held=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const settle=async()=>{for(let i=0;i<16;i++)await new Promise(r=>setImmediate(r));};
const wait=async check=>{for(let i=0;i<100&&!check();i++)await settle();assert.ok(check(),'Controlled original provider phase was not reached');};
const frame=(sampleCount=4800,format={encoding:'pcm_s16le',sampleRateHz:16000,channels:1})=>({frameId:randomUUID(),sequence:0,format,sampleOffset:0,sampleCount,dataBase64:Buffer.alloc(sampleCount*2).toString('base64')});
async function fixture({enabled=true,holdTTS=false,holdGeneration=false,holdRecognition=false,missingDone=false,lateText=false}={}){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'voice-history-source-'));chmodSync(root,0o700);const mask=process.umask(0o077),installerToken=randomBytes(32).toString('hex'),origin='http://127.0.0.1:43180';
 let database,authentication,owner,volatile,session,context,scope,disposed=false;const synthesis=held(),generation=held(),recognition=held(),running=new Set();
 try{
  database=new Database({path:join(root,'test.sqlite')});database.migrate();authentication=new LocalAuthentication(database,{stateDirectory:join(root,'auth'),installerToken});owner=new ConversationRetentionOwner({database,authentication,authDirectory:join(root,'auth'),stateRoot:root,configuration:{mode:'syntheticOnly',retention:'untilDeletion'}});
  const login=await authentication.setup('synthetic-owner',randomBytes(32).toString('hex'),installerToken,origin);context=authentication.hostSessionContext(login.session.sessionId);const assistantId=randomUUID(),endpointId=randomUUID(),audioInputId=randomUUID(),sessionId=context.sessionId;
  new AssistantProfileRepository(database).create({schemaVersion:'2.0.0',assistantId,profileId:randomUUID(),revision:1,status:'draft',createdBy:context.principalId,createdAt:new Date().toISOString()});
  const current=()=>{try{authentication.assertCurrent(context,false);return true;}catch{return false;}};
  scope={actorId:context.principalId,effectiveUserId:context.principalId,contextGeneration:context.effectiveContext.generation,authorityCurrent:current};
  owner.set(context,scope,{schemaVersion:'1.0.0',operation:'set',assistantId,expectedRevision:0,enabled,retention:'untilDeletion',bodyScope:'textAndTranscripts'});
  const repository=new ConversationHistoryRepository(database,{retention:owner});new ConversationRecoveryJournal(repository,join(root,'safety'));
  const conversationId=repository.mutate(scope,{schemaVersion:'1.0.0',operation:'create',operationId:randomUUID(),idempotencyKey:randomUUID(),payload:{assistantId,title:'Synthetic voice lifecycle'}}).conversationId;
  volatile=new ConversationHistory();const events=[],lifecycle=[],durable=bindDurableConversation(repository,scope,assistantId,conversationId,current),port={...volatile.bind({principalId:context.principalId,sessionId,conversationId,assistantId,relationshipId:null},current,Date.now()+30000),observe:event=>{lifecycle.push({...event});durable(event);}};
  let ttsStarted=false,generationWaiting=false,generationClosed=false,recognitionStarted=false,completed=0;
  const text=(holdGeneration?'Controlled partial response before cancellation. '.repeat(3):'Controlled completed voice response.').trim();
  const host={assistantId,endpointId,isCurrent:current,conversation:port,onCompleted:()=>completed++,runtimeSelfContext:{sourceRevision:'synthetic-audio-history',runtimeStatus:'ready',inputModalities:{text:'active',microphone:'activeForSession',visual:'notConfigured'},outputModalities:{text:'active',speechGeneration:'healthy',speechDelivery:'notObserved',presentation:'notConfigured'},endpointScope:'sessionEndpoint',audienceScope:'authenticatedSession',permissionState:'authenticatedSession',limitations:['Controlled providers; no physical speaker or audibility claim.']}};
  const socket={readyState:1,send:raw=>events.push(JSON.parse(raw)),close(){this.readyState=3;}};
  session=new AudioSession(socket,{
   stt:{async *transcribe(){recognitionStarted=true;if(holdRecognition)await recognition.promise;yield {kind:'data',payload:{type:'committed',text:'Controlled accepted voice question'}};yield {kind:'terminal',outcome:'succeeded'};}},
   inference:{async *generate(_request,{signal}){try{yield {kind:'text',text:JSON.stringify({version:'voice-response/1'})+'\n'+JSON.stringify({channel:'speech',text:text.trim()})+'\n'};if(holdGeneration){generationWaiting=true;await generation.promise;if(signal.aborted)throw Error('Controlled generation canceled');}if(!missingDone)yield {kind:'done'};if(lateText)yield {kind:'text',text:'PRIVATE_LATE_AFTER_DONE'};}finally{generationClosed=true;}}},
   tts:{async *synthesize(request,signal){ttsStarted=true;if(holdTTS)await synthesis.promise;if(signal.aborted)throw Error('Controlled synthesis canceled');yield {kind:'data',segmentId:request.segmentId,frame:frame(480,request.format)};yield {kind:'terminal',outcome:'succeeded'};}},
   prepare:()=>host,inputCurrent:current,outputLease:()=>({current,release(){}})
  },sessionId);
  await session.message(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,expectedSessionRevision:1,endpointId,audioInputId,assistantId,format:frame().format}}));assert.ok(events.some(e=>e.type==='accepted'));
  const release=()=>{synthesis.resolve();generation.resolve();recognition.resolve();};
  return {session,events,lifecycle,host,port,text,repository,scope,conversationId,current,phases:()=>({ttsStarted,generationWaiting,generationClosed,recognitionStarted,completed}),
   page:()=>repository.page(scope,conversationId,'older',50).entries,
   rows:()=>database.connection.prepare('SELECT speaker,modality,state,content_state,retained_text FROM conversation_timeline ORDER BY ordinal').all(),
   async turn(){await session.message(JSON.stringify({type:'frame',audioInputId,frame:frame()}));const pending=session.message(JSON.stringify({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:4800}));running.add(pending);try{await pending;}finally{running.delete(pending);}},
   async interrupt(){await session.message(JSON.stringify({type:'interrupt',interactionTraceId:events.findLast(e=>e.type==='turnStarted').interactionTraceId,reason:'Controlled endpoint Stop/barge-in'}));release();},
   async acknowledge(outcome='completed'){await session.message(JSON.stringify({type:'playbackSettled',interactionTraceId:events.findLast(e=>e.type==='turnStarted').interactionTraceId,outcome,receivedSamples:events.filter(e=>e.type==='audio').reduce((n,e)=>n+e.chunk.frame.sampleCount,0)}));},
   revoke(){authentication.logout(context);session.invalidateIfStale();release();},
   disconnectOutput(){socket.readyState=3;},
   async reopen(){session.close();await Promise.allSettled([...running]);volatile.clear();owner.close();database.close();database=new Database({path:join(root,'test.sqlite')});database.migrate();authentication=new LocalAuthentication(database,{stateDirectory:join(root,'auth'),installerToken});context=authentication.hostSessionContext(sessionId);owner=new ConversationRetentionOwner({database,authentication,authDirectory:join(root,'auth'),stateRoot:root,configuration:{mode:'syntheticOnly',retention:'untilDeletion'}});const reopened=new ConversationHistoryRepository(database,{retention:owner});new ConversationRecoveryJournal(reopened,join(root,'safety'));const fresh={actorId:context.principalId,effectiveUserId:context.principalId,contextGeneration:context.effectiveContext.generation,authorityCurrent:current};return reopened.page(fresh,conversationId,'older',50).entries;},
   async close(){if(disposed)return;disposed=true;release();session.close();await Promise.allSettled([...running]);volatile.clear();owner.close();database.close();process.umask(mask);rmSync(root,{recursive:true,force:true});}
  };
 }catch(error){synthesis.resolve();generation.resolve();recognition.resolve();session?.close();volatile?.clear();owner?.close();database?.close();process.umask(mask);rmSync(root,{recursive:true,force:true});throw error;}
}

test('original voice transcript and observed text persist exactly once through repository/journal reopen',async()=>{
 const f=await fixture();try{await f.turn();await f.acknowledge();const rows=f.page();assert.equal(rows.length,2);assert.ok(rows.every(r=>r.modality==='voice'&&r.state==='completed'));assert.equal(rows.find(r=>r.speaker==='human').content.text,'Controlled accepted voice question');assert.equal(rows.find(r=>r.speaker==='assistant').content.text,f.text);assert.equal(f.phases().completed,1);assert.equal(f.lifecycle.filter(e=>e.role==='assistant'&&e.state==='completed').length,1);const reopened=await f.reopen();assert.deepEqual(reopened.map(r=>[r.turnId,r.speaker,r.state,r.content]),rows.map(r=>[r.turnId,r.speaker,r.state,r.content]));}finally{await f.close();}
});
test('completed generated text stays completed when Stop interrupts pending synthesis before any audio',async()=>{
 const f=await fixture({holdTTS:true});let turn;try{turn=f.turn();await wait(()=>f.phases().ttsStarted&&f.phases().generationClosed);assert.equal(f.page().find(r=>r.speaker==='assistant')?.state,'completed');await f.interrupt();await turn;assert.equal(f.events.some(e=>e.type==='audio'),false);assert.equal(f.events.at(-1).event.payload.state,'interrupted');assert.equal(f.page().find(r=>r.speaker==='assistant').state,'completed');assert.equal(f.phases().completed,0);}finally{await f.close();if(turn)await turn;}
});
test('Stop during pending endpoint playback preserves completed text without claiming completed playback',async()=>{
 const f=await fixture();try{await f.turn();assert.ok(f.events.some(e=>e.type==='audio'));await f.interrupt();await f.acknowledge('stopped');assert.equal(f.page().find(r=>r.speaker==='assistant')?.state,'completed');assert.equal(f.phases().completed,0);}finally{await f.close();}
});
test('barge-in before generation done preserves only emitted partial text and interrupted lifecycle',async()=>{
 const f=await fixture({holdGeneration:true,holdTTS:true});let turn;try{turn=f.turn();await wait(()=>f.phases().generationWaiting&&f.phases().ttsStarted);await f.interrupt();await turn;const rows=f.page();assert.equal(rows.length,2);assert.equal(rows.find(r=>r.speaker==='human').state,'completed');assert.equal(rows.find(r=>r.speaker==='assistant').state,'interrupted');assert.equal(rows.find(r=>r.speaker==='assistant').content.text,f.text);assert.equal(f.events.some(e=>e.type==='audio'),false);assert.equal(f.lifecycle.filter(e=>e.role==='assistant'&&e.state==='completed').length,0);}finally{await f.close();if(turn)await turn;}
});
test('Stop during recognition cannot publish a late transcript, generation or history entry',async()=>{
 const f=await fixture({holdRecognition:true});let turn;try{turn=f.turn();await wait(()=>f.phases().recognitionStarted);f.session.close();await f.close();await turn;assert.equal(f.events.some(e=>e.type==='transcript'),false);assert.equal(f.lifecycle.length,0);}finally{await f.close();if(turn)await turn;}
});
test('Auth loss retires existing partial metadata without appending late text or another entry',async()=>{
 const f=await fixture({holdGeneration:true,holdTTS:true});let turn;try{turn=f.turn();await wait(()=>f.phases().generationWaiting&&f.phases().ttsStarted);f.revoke();await turn;const rows=f.rows();assert.equal(rows.length,2);assert.equal(rows.find(r=>r.speaker==='assistant').state,'interrupted');assert.equal(rows.find(r=>r.speaker==='assistant').retained_text,f.text);f.port.observe({interactionId:randomUUID(),role:'user',modality:'voice',state:'completed',text:'Denied late text'});assert.equal(f.rows().length,2);assert.equal(f.port.read(),'[]');}finally{await f.close();if(turn)await turn;}
});
test('existing saving-off policy retains voice metadata without transcript or reply bodies',async()=>{
 const f=await fixture({enabled:false});try{await f.turn();await f.acknowledge();assert.equal(f.page().length,2);assert.ok(f.page().every(r=>r.state==='completed'&&r.content.state==='unavailable'));assert.ok(f.rows().every(r=>r.retained_text===null));}finally{await f.close();}
});
test('canonical completion follows the original provider terminal and excludes text after done',async()=>{
 for(const missingDone of [false,true]){const f=await fixture({missingDone,lateText:!missingDone});try{await f.turn();await f.acknowledge();const row=f.page().find(r=>r.speaker==='assistant');assert.equal(row?.state,missingDone?'failed':'completed');assert.equal(row.content.text,f.text);assert.doesNotMatch(JSON.stringify(f.events),/PRIVATE_LATE_AFTER_DONE/);assert.equal(f.lifecycle.filter(e=>e.role==='assistant'&&['completed','failed','interrupted'].includes(e.state)).length,1);}finally{await f.close();}}
});
test('unavailable optional history observer cannot fabricate rows or break original voice delivery',async()=>{
 const f=await fixture();try{f.port.observe=()=>{throw Error('Controlled observer unavailable');};await f.turn();await f.acknowledge();assert.equal(f.events.filter(e=>e.type==='response'&&e.event.payload.type==='terminal').at(-1).event.payload.state,'completed');assert.equal(f.page().length,0);}finally{await f.close();}
});
test('unwritten voice response text cannot become a completed retained history reply',async()=>{
 const f=await fixture();try{f.disconnectOutput();await f.turn();const assistant=f.page().find(r=>r.speaker==='assistant');assert.equal(assistant?.state,'interrupted');assert.equal(assistant.content.state,'unavailable');assert.equal(f.events.some(e=>e.event?.payload.type==='textDelta'),false);assert.equal(f.lifecycle.some(e=>e.role==='assistant'&&e.text),false);}finally{await f.close();}
});
