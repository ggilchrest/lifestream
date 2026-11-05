// Original AudioSession + Auth/Policy/Journal/SQLite owners; disposable state only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
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
const waitGate=async(gate,signal)=>{if(!gate)return;let abort;try{await Promise.race([gate.promise,new Promise(resolve=>{abort=resolve;signal.addEventListener('abort',abort,{once:true});if(signal.aborted)resolve();})]);}finally{signal.removeEventListener('abort',abort);}};
const held=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const settle=async()=>{for(let i=0;i<16;i++)await new Promise(r=>setImmediate(r));};
const wait=async check=>{for(let i=0;i<100&&!check();i++)await settle();assert.ok(check(),'Controlled original provider phase was not reached');};
const frame=(sampleCount=4800,format={encoding:'pcm_s16le',sampleRateHz:16000,channels:1})=>({frameId:randomUUID(),sequence:0,format,sampleOffset:0,sampleCount,dataBase64:Buffer.alloc(sampleCount*2).toString('base64')});
async function fixture({enabled=true,plans=[],generationGate,ttsGate,legacy=false}={}){
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
  const requests=[],inputs=[],signals=[];let ttsStarted=false,generationWaiting=false,generationClosed=false,recognitionStarted=false,completed=0;
  const text='Controlled completed voice response.';
  const host={assistantId,endpointId,isCurrent:current,conversation:port,onCompleted:()=>completed++,runtimeSelfContext:{sourceRevision:'synthetic-audio-history',runtimeStatus:'ready',inputModalities:{text:'active',microphone:'activeForSession',visual:'notConfigured'},outputModalities:{text:'active',speechGeneration:'healthy',speechDelivery:'notObserved',presentation:'notConfigured'},endpointScope:'sessionEndpoint',audienceScope:'authenticatedSession',permissionState:'authenticatedSession',limitations:['Controlled providers; no physical speaker or audibility claim.']}};
  const socket={readyState:1,send:raw=>events.push(JSON.parse(raw)),close(){this.readyState=3;}};
  session=new AudioSession(socket,{
   stt:{async *transcribe(_request,audio,signal){const index=inputs.length,plan=plans[index]??{text:'Synthetic input '+(index+1)},record={samples:0,frames:0,bytes:0},digest=createHash('sha256');inputs.push(record);signals.push(signal);recognitionStarted=true;for await(const item of audio){if(item.type==='frame'){record.samples+=item.frame.sampleCount;record.frames++;const bytes=Buffer.from(item.frame.dataBase64,'base64');record.bytes+=bytes.length;digest.update(bytes);}else assert.equal(item.sampleCount,record.samples);}record.pcmSha256=digest.digest('hex');if(plan.gate)await plan.gate.promise;for(const text of plan.partials??[])yield {kind:'data',payload:{type:'partial',text}};if(plan.fail)throw Error('Synthetic recognition failure');yield {kind:'data',payload:{type:'committed',text:plan.text??''}};for(const text of plan.extraFinals??[])yield {kind:'data',payload:{type:'committed',text}};if(!plan.noTerminal)yield {kind:'terminal',outcome:plan.failAfterFinal?'failed':'succeeded'};}},
   inference:{async *generate(request,{signal}){const index=requests.length;requests.push(request);try{if(index===0&&generationGate){generationWaiting=true;await waitGate(generationGate,signal);if(signal.aborted)throw Error('Synthetic obsolete reply cancelled');}yield {kind:'text',text:JSON.stringify({version:'voice-response/1'})+'\n'+JSON.stringify({channel:'speech',text})+'\n'};yield {kind:'done'};}finally{generationClosed=true;}}},
   tts:{withoutAdmissionRetries(){return this;},async *synthesize(request,signal){ttsStarted=true;if(signal.aborted)throw Error('Synthetic obsolete synthesis cancelled');yield {kind:'preAudio',mappingRevision:'synthetic-map:1',degradedDimensions:[]};yield {kind:'data',segmentId:request.segmentId,frame:frame(480,request.format),mappingRevision:'synthetic-map:1'};if(ttsGate&&requests.length===1)await ttsGate.promise;yield {kind:'terminal',outcome:'succeeded',outputSamples:480,frameCount:1,mappingRevision:'synthetic-map:1',degradedDimensions:[]};}},
   prepare:()=>host,inputCurrent:current,outputLease:()=>({current,release(){}})
  },sessionId);
  await session.message(JSON.stringify({type:'start',request:{...(legacy?{}:{continuationMode:'ordered-v1'}),schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,expectedSessionRevision:1,endpointId,audioInputId,assistantId,format:frame().format}}));assert.ok(events.some(e=>e.type==='accepted'));
  const release=()=>{synthesis.resolve();generation.resolve();recognition.resolve();generationGate?.resolve();ttsGate?.resolve();for(const plan of plans)plan.gate?.resolve();};
  return {session,events,lifecycle,host,port,text,requests,inputs,signals,audioInputId,raw:value=>session.message(JSON.stringify(value)),repository,scope,conversationId,current,phases:()=>({ttsStarted,generationWaiting,generationClosed,recognitionStarted,completed}),
   page:()=>repository.page(scope,conversationId,'older',50).entries,
   rows:()=>database.connection.prepare('SELECT speaker,modality,state,content_state,retained_text FROM conversation_timeline ORDER BY ordinal').all(),
   async turn(){const framed=session.message(JSON.stringify({type:'frame',audioInputId,frame:frame()}));const pending=session.message(JSON.stringify({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:4800}));running.add(pending);try{await framed;await pending;}finally{running.delete(pending);}},
   async continueAt(sequence){await session.message(JSON.stringify({type:'continueInput',audioInputId,afterCommitSequence:sequence}));},
   async interrupt(){await session.message(JSON.stringify({type:'interrupt',interactionTraceId:events.findLast(e=>e.type==='turnStarted').interactionTraceId,reason:'Controlled endpoint Stop/barge-in'}));release();},
   async acknowledge(outcome='completed'){await session.message(JSON.stringify({type:'playbackSettled',interactionTraceId:events.findLast(e=>e.type==='turnStarted').interactionTraceId,outcome,receivedSamples:events.filter(e=>e.type==='audio'&&e.interactionTraceId===events.findLast(e=>e.type==='turnStarted').interactionTraceId).reduce((n,e)=>n+e.chunk.frame.sampleCount,0)}));},
   revoke(){authentication.logout(context);session.invalidateIfStale();release();},
   disconnectOutput(){socket.readyState=3;},
   async reopen(){session.close();await Promise.allSettled([...running]);volatile.clear();owner.close();database.close();database=new Database({path:join(root,'test.sqlite')});database.migrate();authentication=new LocalAuthentication(database,{stateDirectory:join(root,'auth'),installerToken});context=authentication.hostSessionContext(sessionId);owner=new ConversationRetentionOwner({database,authentication,authDirectory:join(root,'auth'),stateRoot:root,configuration:{mode:'syntheticOnly',retention:'untilDeletion'}});const reopened=new ConversationHistoryRepository(database,{retention:owner});new ConversationRecoveryJournal(reopened,join(root,'safety'));const fresh={actorId:context.principalId,effectiveUserId:context.principalId,contextGeneration:context.effectiveContext.generation,authorityCurrent:current};return reopened.page(fresh,conversationId,'older',50).entries;},
   async close(){if(disposed)return;disposed=true;release();session.close();await Promise.allSettled([...running]);volatile.clear();owner.close();database.close();process.umask(mask);rmSync(root,{recursive:true,force:true});}
  };
 }catch(error){for(const plan of plans)plan.gate?.resolve();generationGate?.resolve();synthesis.resolve();generation.resolve();recognition.resolve();session?.close();volatile?.clear();owner?.close();database?.close();process.umask(mask);rmSync(root,{recursive:true,force:true});throw error;}
}


const prefix='I was researching the Voynich Manuscript and comparing historical texts and illustrations.';
const tail='What do you think?';
const userRows=f=>f.page().filter(r=>r.speaker==='human');
const finals=f=>f.events.filter(e=>e.type==='transcript');
const queued=f=>f.events.filter(e=>e.type==='inputQueued');
test('negotiation echoes ordered mode and finite input capacity; legacy stays explicit',async()=>{
 for(const legacy of [false,true]){const f=await fixture({legacy});try{const accepted=f.events.find(e=>e.type==='accepted');assert.equal(accepted.continuationMode,legacy?undefined:'ordered-v1');assert.equal(accepted.inputCapacity,legacy?undefined:3);}finally{await f.close();}}
});
test('continued speech during pending ASR preserves ordered prefix and later request with one current reply',async()=>{
 const gate=held(),f=await fixture({plans:[{text:prefix,gate},{text:tail}]});let first,second;
 try{first=f.turn();await wait(()=>f.inputs.length===1);await f.continueAt(1);assert.equal(f.signals[0].aborted,false);second=f.turn();assert.equal(queued(f).length,2);assert.equal(f.signals[0].aborted,false);gate.resolve();await Promise.all([first,second]);await f.acknowledge();assert.equal(f.requests.length,1);assert.ok(JSON.stringify(f.requests[0]).includes('Voynich'));assert.ok(JSON.stringify(f.requests[0]).includes(tail));assert.equal(f.requests[0].sections.find(s=>s.kind==='userInput').content,tail);assert.equal(f.requests[0].sections.find(s=>s.kind==='conversation')?.content.includes(tail)??false,false);assert.deepEqual(userRows(f).map(r=>r.content.text),[prefix,tail]);assert.deepEqual(finals(f).map(e=>[e.inputSequence,e.transcriptRevision]),[[1,1],[2,1]]);assert.ok(finals(f).every(e=>typeof e.interactionTraceId==='string'));const settled=f.events.filter(e=>e.type==='inputSettled');assert.deepEqual(settled.map(e=>e.transcriptCommitted),[true,true]);assert.ok(f.events.indexOf(settled[0])<f.events.findIndex(e=>e.type==='turnStarted'&&e.inputSequence===2));}finally{await f.close();await Promise.allSettled([first,second]);}
});
test('continued speech while LLM pending cancels obsolete output but retains admitted input',async()=>{
 const generationGate=held(),f=await fixture({generationGate,plans:[{text:prefix},{text:tail}]});let first,second;
 try{first=f.turn();await wait(()=>f.phases().generationWaiting);assert.equal(userRows(f)[0].content.text,prefix);await f.continueAt(1);await f.acknowledge('stopped');second=f.turn();await Promise.all([first,second]);await f.acknowledge();assert.equal(f.requests.length,2);assert.ok(JSON.stringify(f.requests[1]).includes('Voynich'));assert.ok(JSON.stringify(f.requests[1]).includes(tail));assert.deepEqual(userRows(f).map(r=>r.content.text),[prefix,tail]);assert.equal(f.events.filter(e=>e.type==='audio').every(e=>e.interactionTraceId===finals(f)[1].interactionTraceId),true);}finally{await f.close();await Promise.allSettled([first,second]);}
});
test('barge-in wire hook after audio emission preserves prior user input and fences predecessor playback',async()=>{
 const f=await fixture({plans:[{text:prefix},{text:tail}]});try{await f.turn();const trace=finals(f)[0].interactionTraceId;assert.ok(f.events.some(e=>e.type==='audio'&&e.interactionTraceId===trace));await f.continueAt(1);await f.acknowledge('stopped');await f.turn();await f.acknowledge();assert.ok(JSON.stringify(f.requests[1]).includes('Voynich'));assert.equal(userRows(f).length,2);assert.equal(f.events.filter(e=>e.type==='transcript'&&e.inputSequence===1).length,1);}finally{await f.close();}
});
test('ongoing conversation references input five exchanges ago within existing projection budget',async()=>{
 const texts=[prefix,'A second small thought.','A third related thought.','A fourth small thought.','A fifth thought.','Compare that with what I first researched.'];const f=await fixture({plans:texts.map(text=>({text}))});try{for(let i=0;i<texts.length;i++){await f.turn();await f.acknowledge();await settle();}assert.equal(f.requests.length,6);assert.ok(JSON.stringify(f.requests[5]).includes('Voynich'));assert.ok(JSON.stringify(f.requests[5]).includes(texts[5]));assert.deepEqual(userRows(f).map(r=>r.content.text),texts);assert.equal(finals(f).length,6);}finally{await f.close();}
});
test('partials and repeated/revised provider finals never duplicate durable user input',async()=>{
 const f=await fixture({plans:[{text:prefix,partials:['An unstable hypothesis','A revised hypothesis'],extraFinals:[prefix,'A conflicting later final']},{text:tail}]});try{await f.turn();await f.acknowledge();await settle();await f.turn();await f.acknowledge();assert.deepEqual(userRows(f).map(r=>r.content.text),[prefix,tail]);assert.equal(finals(f).length,2);const request=JSON.stringify(f.requests[1]);assert.ok(request.includes('Voynich'));assert.equal(request.includes('unstable hypothesis'),false);assert.equal(request.includes('conflicting later final'),false);}finally{await f.close();}
});
for(const failure of ['fail','noTerminal','failAfterFinal','empty'])test(`failed recognition ${failure} has explicit settled gap and no transcript/history`,async()=>{
 const gate=held(),f=await fixture({plans:[{text:failure==='empty'?'':prefix,[failure]:true,gate},{text:tail}]});let first,second;try{first=f.turn();await wait(()=>f.inputs.length===1);second=f.turn();gate.resolve();await Promise.all([first,second]);await f.acknowledge();assert.deepEqual(finals(f).map(e=>e.inputSequence),[2]);assert.deepEqual(userRows(f).map(r=>r.content.text),[tail]);const settled=f.events.filter(e=>e.type==='inputSettled');assert.deepEqual(settled.map(e=>e.transcriptCommitted),[false,true]);assert.ok(f.events.indexOf(settled[0])<f.events.indexOf(finals(f)[0]));assert.equal(f.requests.length,1);}finally{await f.close();await Promise.allSettled([first,second]);}
});
test('future/stale continuation is rejected without abort; duplicate exact continuation is idempotent',async()=>{
 const gate=held(),f=await fixture({plans:[{text:prefix,gate},{text:tail}]});let first;
 try{first=f.turn();await wait(()=>f.inputs.length===1);await f.continueAt(2);assert.equal(f.signals[0].aborted,false);await f.continueAt(1);await f.continueAt(1);assert.equal(f.signals[0].aborted,false);gate.resolve();await first;await f.turn();await f.acknowledge();assert.equal(finals(f).filter(e=>e.inputSequence===1).length,1);assert.equal(userRows(f).length,2);await f.continueAt(0);assert.ok(f.events.some(e=>e.problem?.code==='audio_continuation_invalid'));}finally{await f.close();await Promise.allSettled([first]);}
});
test('full queue rejects only new admission, preserves pending ASR and retries known uncommitted accounting once',async()=>{
 const a=held(),b=held(),f=await fixture({plans:[{text:'Prefix1',gate:a},{text:'Prefix2',gate:b},{text:'Prefix3'},{text:tail}]});let first,second,third,retry;
 try{first=f.turn();await wait(()=>f.inputs.length===1);second=f.turn();third=f.turn();await f.turn();assert.equal(queued(f).length,3);assert.ok(f.events.some(e=>e.type==='inputBackpressure'));assert.equal(f.session.closed,false);assert.equal(f.signals[0].aborted,false);assert.equal(f.session.frames.length,1);a.resolve();await wait(()=>f.events.some(e=>e.type==='inputSettled'&&e.inputSequence===1));retry=f.raw({type:'commitTurn',audioInputId:f.audioInputId,nextSequence:1,sampleCount:4800});assert.equal(queued(f).at(-1).inputSequence,4);b.resolve();await Promise.all([first,second,third,retry]);await f.acknowledge();assert.deepEqual(userRows(f).map(r=>r.content.text),['Prefix1','Prefix2','Prefix3',tail]);assert.equal(f.inputs.length,4);assert.equal(f.requests.length,1);assert.ok(JSON.stringify(f.requests[0]).includes('Prefix1'));assert.equal(f.session.frames.length,0);}finally{await f.close();await Promise.allSettled([first,second,third,retry]);}
});
test('current segment overflow stops only new input and preserves earlier accepted recognition',async()=>{
 const gate=held(),f=await fixture({plans:[{text:prefix,gate}]});let first;
 try{first=f.turn();await wait(()=>f.inputs.length===1);await f.continueAt(1);let offset=0,sequence=0;while(offset<1440001){const count=Math.min(4800,1440001-offset),value=frame(count);value.sequence=sequence++;value.sampleOffset=offset;await f.raw({type:'frame',audioInputId:f.audioInputId,frame:value});offset+=count;}const error=f.events.find(e=>e.problem?.code==='audio_input_limit');assert.equal(error.acceptedInputsPreserved,true);assert.equal(error.inputScope,'uncommittedInput');assert.equal(f.signals[0].aborted,false);assert.equal(f.session.closed,false);assert.equal(f.session.frames.length,0);gate.resolve();await first;assert.deepEqual(userRows(f).map(r=>r.content.text),[prefix]);assert.equal(f.events.find(e=>e.type==='inputSettled').transcriptCommitted,true);assert.equal(f.requests.length,0);}finally{await f.close();await Promise.allSettled([first]);}
});
test('explicit Stop during ASR is cancellation, not continuation or automatic input replay',async()=>{
 const gate=held(),f=await fixture({plans:[{text:prefix,gate}]});let first;
 try{first=f.turn();await wait(()=>f.inputs.length===1);await f.interrupt();await first;assert.equal(f.signals[0].aborted,true);assert.equal(userRows(f).length,0);assert.equal(finals(f).length,0);assert.equal(f.events.find(e=>e.type==='inputSettled').transcriptCommitted,false);assert.equal(f.requests.length,0);}finally{await f.close();await Promise.allSettled([first]);}
});
test('revocation during queued ASR prevents late admission and further context',async()=>{
 const gate=held(),f=await fixture({plans:[{text:prefix,gate},{text:tail}]});let first,second;
 try{first=f.turn();await wait(()=>f.inputs.length===1);second=f.turn();f.revoke();await Promise.all([first,second]);assert.equal(finals(f).length,0);assert.equal(f.requests.length,0);assert.equal(f.rows().length,0);}finally{await f.close();await Promise.allSettled([first,second]);}
});


for(const kind of ['frame','commit'])test(`invalid new ${kind} rejects only uncommitted input while accepted ASR settles`,async()=>{
 const gate=held(),f=await fixture({plans:[{text:prefix,gate}]});let first;
 try{first=f.turn();await wait(()=>f.inputs.length===1);await f.continueAt(1);if(kind==='frame'){const value=frame();value.sequence=9;await f.raw({type:'frame',audioInputId:f.audioInputId,frame:value});}else{await f.raw({type:'frame',audioInputId:f.audioInputId,frame:frame()});await f.raw({type:'commitTurn',audioInputId:f.audioInputId,nextSequence:2,sampleCount:4800});}assert.equal(f.events.find(e=>e.problem?.code===`audio_${kind}_invalid`).acceptedInputsPreserved,true);assert.equal(f.signals[0].aborted,false);gate.resolve();await first;assert.deepEqual(userRows(f).map(r=>r.content.text),[prefix]);assert.equal(f.events.find(e=>e.type==='inputSettled').transcriptCommitted,true);}finally{await f.close();await Promise.allSettled([first]);}
});
test('recognized user input remains accepted if later memory preparation fails',async()=>{
 const f=await fixture({plans:[{text:prefix}]});try{f.host.prepareMemory=async()=>{throw Error('Synthetic memory preparation failure');};await f.turn();assert.equal(f.requests.length,0);assert.equal(finals(f).length,1);assert.equal(userRows(f)[0].content.text,prefix);assert.equal(f.events.find(e=>e.type==='inputSettled').transcriptCommitted,true);}finally{await f.close();}
});
test('retention-off keeps content unavailable in durable history without removing current volatile context',async()=>{
 const f=await fixture({enabled:false,plans:[{text:prefix},{text:tail}]});try{await f.turn();await f.acknowledge();await settle();await f.turn();await f.acknowledge();assert.ok(JSON.stringify(f.requests[1]).includes('Voynich'));assert.equal(f.rows().some(r=>r.retained_text?.includes('Voynich')),false);}finally{await f.close();}
});

test('ordered continuation preempts output-only speech without fabricating or cancelling user recognition',async()=>{
 const f=await fixture({plans:[{text:tail}]});try{const interactionId=randomUUID();const output=f.session.speakOutputOnly({text:'Synthetic unsolicited output.',interactionId,endpointId:f.host.endpointId,deadlineAt:new Date(Date.now()+10000).toISOString(),warmth:0.5,signal:new AbortController().signal,current:f.current,beforeEmission(){},emitted(){}});void output.catch(()=>{});await wait(()=>f.events.some(e=>e.type==='audio'&&e.interactionTraceId===interactionId));assert.equal(f.inputs.length,0);assert.ok(f.events.some(e=>e.type==='audio'&&e.interactionTraceId===interactionId));await f.continueAt(0);await f.raw({type:'playbackSettled',interactionTraceId:interactionId,outcome:'stopped',receivedSamples:f.events.filter(e=>e.type==='audio'&&e.interactionTraceId===interactionId).reduce((n,e)=>n+e.chunk.frame.sampleCount,0)});await assert.rejects(output,/interrupted|stale|stopped/);await settle();await f.turn();await f.acknowledge();assert.equal(f.inputs.length,1);assert.equal(f.requests.length,1);assert.deepEqual(userRows(f).map(r=>r.content.text),[tail]);}finally{await f.close();}
});

test('accepted next input recognizes and persists while old cancelled producer is still settling',async()=>{
 const ttsGate=held(),f=await fixture({ttsGate,plans:[{text:prefix},{text:tail}]});let first,second;
 try{first=f.turn();await wait(()=>f.events.some(e=>e.type==='audio'));await f.continueAt(1);await f.acknowledge('stopped');await first;second=f.turn();await wait(()=>f.inputs.length===2&&userRows(f).length===2);assert.equal(f.requests.length,1,'New reply still respects old output settlement');assert.equal(userRows(f)[1].content.text,tail);assert.equal(finals(f)[1].inputSequence,2);ttsGate.resolve();await second;await f.acknowledge();assert.equal(f.requests.length,2);assert.ok(JSON.stringify(f.requests[1]).includes('Voynich'));}finally{ttsGate.resolve();await f.close();await Promise.allSettled([first,second]);}
});

export {fixture,held,wait,settle};
