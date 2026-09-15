import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket} from 'ws';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {AudioSession,type OutputOnlySpeech} from '../src/runtime/audio.ts';
import {SessionHandoffService} from '@lifestream/runtime/endpoints/handoff';

function fixture(){
 const events:any[]=[],requests:any[]=[],service=new SessionHandoffService(),sessionId=randomUUID(),endpointId=randomUUID();let sttCalls=0,inferenceCalls=0,noRetry=0,begins=0,emitted=0;
 const socket={readyState:1,send:(value:string)=>events.push(JSON.parse(value)),close:()=>{socket.readyState=3;}};
 const frame=(sequence=0)=>({frameId:randomUUID(),sequence,format:{encoding:'pcm_s16le' as const,sampleRateHz:48000 as const,channels:1 as const},sampleOffset:sequence*10,sampleCount:10,dataBase64:Buffer.alloc(20).toString('base64')});
 const tts:any={withoutAdmissionRetries(){noRetry++;return this;},async *synthesize(request:any){requests.push(request);yield {kind:'preAudio',mappingRevision:'synthetic-map:1',degradedDimensions:['affect']};yield {kind:'data',segmentId:request.segmentId,frame:frame(),mappingRevision:'synthetic-map:1'};yield {kind:'terminal',outcome:'succeeded',outputSamples:10,frameCount:1,mappingRevision:'synthetic-map:1',degradedDimensions:[]};}};
 const deps:any={stt:{async *transcribe(){sttCalls++;throw new Error('STT must not run');}},inference:{async *generate(){inferenceCalls++;throw new Error('Inference must not run');}},tts,outputLease:(endpoint:string,deadline:string)=>{const lease=service.acquire(sessionId,endpoint,randomUUID(),deadline);return {current:()=>service.owns(lease),release:()=>service.release(lease)};}};
 const session=new AudioSession(socket,deps,sessionId),input:OutputOnlySpeech={text:'Synthetic output only.',interactionId:randomUUID(),endpointId,deadlineAt:new Date(Date.now()+30000).toISOString(),warmth:0.8,signal:new AbortController().signal,current:()=>true,beforeEmission:()=>{begins++;},emitted:()=>{emitted++;}};
 return {events,requests,service,sessionId,endpointId,socket,frame,tts,deps,session,input,counts:()=>({sttCalls,inferenceCalls,noRetry,begins,emitted})};
}

test('output-only speech uses existing transport events without input setup, recognition or inference',async()=>{
 const f=fixture();const result=await f.session.speakOutputOnly(f.input);
 assert.deepEqual(f.counts(),{sttCalls:0,inferenceCalls:0,noRetry:1,begins:1,emitted:1});assert.equal(result.samples,10);assert.equal(result.frames,1);assert.equal(result.warmth,'unsupported');assert.deepEqual(result.degradedDimensions,['warmth','affect']);assert.equal(f.requests[0].delivery.urgency,'low');
 assert.equal(f.events.some(e=>['accepted','turnStarted','transcript'].includes(e.type)),false);assert.equal(f.events.filter(e=>e.type==='audio').length,1);assert.equal(f.events[0].event.payload.type,'textDelta');assert.equal(f.events.at(-1).event.payload.state,'completed');
 assert.equal(f.service.currentLease(f.sessionId),undefined);assert.equal(f.session.outputAvailable,true);
});

test('output-only admission refuses missing policy, closed transport, invalid warmth and another audio owner',async()=>{
 for(const reason of ['policy','socket','warmth','owner','expiry']){
  const f=fixture();if(reason==='policy')f.input.current=()=>false;if(reason==='socket')f.socket.readyState=3;if(reason==='warmth')f.input.warmth=NaN;if(reason==='expiry')f.input.deadlineAt=new Date(Date.now()-1).toISOString();if(reason==='owner')f.service.acquire(f.sessionId,randomUUID(),randomUUID(),f.input.deadlineAt);
  await assert.rejects(f.session.speakOutputOnly(f.input));assert.equal(f.requests.length,0);assert.equal(f.counts().begins,0);assert.equal(f.events.filter(e=>e.type==='audio').length,0);
 }
});

test('malformed, incomplete and failed synthesis cannot claim complete output',async()=>{
 for(const mode of ['noAudio','badCounts','badFrame','noTerminal','postTerminal']){
  const f=fixture();f.tts.synthesize=async function*(request:any){
   if(mode==='noAudio'){yield {kind:'terminal',outcome:'failed',outputSamples:0,frameCount:0,mappingRevision:'map',degradedDimensions:[]};return;}
   yield {kind:'data',segmentId:request.segmentId,frame:{...f.frame(),...(mode==='badFrame'?{sampleOffset:4}:{})},mappingRevision:'map'};
   if(mode!=='noTerminal')yield {kind:'terminal',outcome:'succeeded',outputSamples:mode==='badCounts'?9:10,frameCount:1,mappingRevision:'map',degradedDimensions:[]};
   if(mode==='postTerminal')yield {kind:'data',segmentId:request.segmentId,frame:f.frame(1),mappingRevision:'map'};
  };
  await assert.rejects(f.session.speakOutputOnly(f.input),undefined,mode);assert.equal(f.events.at(-1).event.payload.state,'failed');assert.equal(f.service.currentLease(f.sessionId),undefined);
  if(['noAudio','badFrame'].includes(mode))assert.equal(f.counts().emitted,0);else assert.equal(f.events.some(e=>e.type==='stopPlayback'),true);
 }
});

test('an explicit interrupt works on output-only speech without opening input capture',async()=>{
 const f=fixture();let release:()=>void=()=>{},entered:()=>void=()=>{};const started=new Promise<void>(r=>{entered=r;});
 f.tts.synthesize=async function*(request:any){yield {kind:'data',segmentId:request.segmentId,frame:f.frame(),mappingRevision:'map'};entered();await new Promise<void>(r=>{release=r;});yield {kind:'terminal',outcome:'succeeded',outputSamples:10,frameCount:1,mappingRevision:'map',degradedDimensions:[]};};
 const pending=f.session.speakOutputOnly(f.input);await started;await new Promise(r=>setImmediate(r));
 await f.session.message(JSON.stringify({type:'interrupt',interactionTraceId:f.input.interactionId,reason:'Explicit stop'}));
 try{await assert.rejects(pending);assert.equal(f.events.at(-1).event.payload.state,'interrupted');assert.equal(f.counts().sttCalls,0);assert.equal(f.counts().inferenceCalls,0);assert.ok(f.service.currentLease(f.sessionId));assert.equal(f.session.outputAvailable,false);}finally{release();await new Promise(r=>setImmediate(r));}assert.equal(f.service.currentLease(f.sessionId),undefined);assert.equal(f.session.outputAvailable,true);
});

test('handoff fences the old output stream and its cleanup cannot release the new owner',async()=>{
 const f=fixture();let release:()=>void=()=>{},entered:()=>void=()=>{};const started=new Promise<void>(r=>{entered=r;});
 f.tts.synthesize=async function*(request:any){entered();await new Promise<void>(r=>{release=r;});yield {kind:'data',segmentId:request.segmentId,frame:f.frame(),mappingRevision:'map'};yield {kind:'terminal',outcome:'succeeded',outputSamples:10,frameCount:1,mappingRevision:'map',degradedDimensions:[]};};
 const pending=f.session.speakOutputOnly(f.input);await started;const prior=f.service.currentLease(f.sessionId)!;
 const moved=f.service.handoff({handoffId:randomUUID(),sessionId:f.sessionId,sourceEndpointId:f.endpointId,destinationEndpointId:randomUUID(),expectedLeaseRevision:prior.revision,initiatorRef:'synthetic-host',authorized:true,destinationAvailable:true,privacyCompatible:true,occurredAt:new Date().toISOString()});assert.equal(moved.outcome,'completed');
 release();await assert.rejects(pending);assert.equal(f.events.filter(e=>e.type==='audio').length,0);assert.equal(f.service.owns(moved.newLease!),true);assert.equal(f.counts().begins,0);
});

test('failed durable emission callbacks stop playback and preserve the observed first write',async()=>{
 for(const afterWrite of [false,true]){
  const f=fixture();if(afterWrite)f.input.emitted=()=>{throw new Error('Synthetic receipt write failure');};else f.input.beforeEmission=()=>{throw new Error('Synthetic admission write failure');};
  await assert.rejects(f.session.speakOutputOnly(f.input));assert.equal(f.events.some(e=>e.event?.payload.type==='textDelta'),afterWrite);assert.equal(f.events.some(e=>e.type==='stopPlayback'),afterWrite);assert.equal(f.events.filter(e=>e.type==='audio').length,0);assert.equal(f.service.currentLease(f.sessionId),undefined);
 }
});

test('ordinary voice transport and HTTP speech preview share the same server audio owner', {timeout:15000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'shared-audio-output-'));t.after(()=>rm(root,{recursive:true,force:true}));const config=loadProfile('test');config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};
 const app=createLifestreamServer({config});await app.start();t.after(()=>app.shutdown());const base=`http://127.0.0.1:${app.address().port}`,sessionId=randomUUID(),audioInputId=randomUUID();let release:()=>void=()=>{},entered:()=>void=()=>{},calls=0;const started=new Promise<void>(r=>{entered=r;});
 (app as any).providers.stt={async *transcribe(){yield {kind:'data',payload:{type:'committed',text:'Synthetic user voice.'}};yield {kind:'terminal',outcome:'succeeded'};}};
 (app as any).providers.tts={async *synthesize(request:any){calls++;if(calls===1){entered();await new Promise<void>(r=>{release=r;});}yield {kind:'data',segmentId:request.segmentId,frame:{frameId:randomUUID(),sequence:0,format:request.format,sampleOffset:0,sampleCount:10,dataBase64:Buffer.alloc(20).toString('base64')},mappingRevision:'fixture-map'};yield {kind:'terminal',outcome:'succeeded',outputSamples:10,frameCount:1,mappingRevision:'fixture-map',degradedDimensions:[],disposition:'fullyApplied'};}};
 const socket=new WebSocket(base.replace('http:','ws:')+`/api/runtime/v1/audio?fixtureSession=${sessionId}&fixturePrincipal=human`,{origin:base});t.after(()=>socket.close());
 let accepted:()=>void=()=>{},completed:()=>void=()=>{};const ready=new Promise<void>(r=>{accepted=r;}),done=new Promise<void>(r=>{completed=r;});const messages:any[]=[];
 socket.on('message',raw=>{const e=JSON.parse(raw.toString());messages.push(e);if(e.type==='accepted')accepted();if(e.event?.payload.type==='terminal')completed();});await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
 socket.send(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,expectedSessionRevision:1,endpointId:randomUUID(),audioInputId,format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1}}}));await ready;
 socket.send(JSON.stringify({type:'frame',audioInputId,frame:{frameId:randomUUID(),sequence:0,format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1},sampleOffset:0,sampleCount:10,dataBase64:Buffer.alloc(20).toString('base64')}}));socket.send(JSON.stringify({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:10}));await started;
 const preview=()=>fetch(base+'/api/runtime/v1/tts',{method:'POST',headers:{origin:base,'content-type':'application/json','x-lifestream-fixture-session':sessionId,'x-lifestream-fixture-principal':'human'},body:JSON.stringify({text:'Synthetic preview.'})});
 try{const rejected=await preview();assert.equal(rejected.status,409);assert.equal((await rejected.json() as any).code,'audio_output_owned');assert.equal(calls,1);}finally{release();}
 await done;assert.equal(messages.at(-1).event.payload.state,'completed');const after=await preview();assert.equal(after.status,200);assert.match(await after.text(),/succeeded/u);assert.equal(calls,2);
});


test('output-only speech retains its owner through browser playback and explicit interruption',async()=>{
 const f=fixture();let entered:()=>void=()=>{},finish:()=>void=()=>{};const started=new Promise<void>(r=>{entered=r;}),played=new Promise<void>(r=>{finish=r;});
 f.input.synthesized=async signal=>{entered();await new Promise<void>((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('Stopped')),{once:true});void played.then(resolve);});};
 const pending=f.session.speakOutputOnly(f.input);await started;assert.equal(f.events.at(-1).event.payload.state,'completed');assert.equal(f.session.outputAvailable,false);assert.ok(f.service.currentLease(f.sessionId));
 await f.session.message(JSON.stringify({type:'interrupt',interactionTraceId:f.input.interactionId,reason:'Explicit stop'}));await assert.rejects(pending);finish();assert.equal(f.service.currentLease(f.sessionId),undefined);assert.equal(f.events.at(-1).type,'stopPlayback');assert.equal(f.session.outputAvailable,true);
});

test('committing ordinary input preempts social playback and processes the queued user turn after release',async()=>{
 const f=fixture();let entered:()=>void=()=>{},foreground=0;const started=new Promise<void>(r=>{entered=r;});f.deps.foregroundStarted=()=>{foreground++;return()=>{foreground--;};};
 f.input.synthesized=async signal=>{entered();await new Promise<void>((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('Preempted')),{once:true}));};
 const pending=f.session.speakOutputOnly(f.input);await started;assert.equal(foreground,0);
 const audioInputId=randomUUID();await f.session.message(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId:f.sessionId,expectedSessionRevision:1,endpointId:f.endpointId,audioInputId,format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1}}}));
 assert.equal(foreground,0);await f.session.message(JSON.stringify({type:'frame',audioInputId,frame:{...f.frame(),format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1}}}));
 const committed=f.session.message(JSON.stringify({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:10}));assert.equal(foreground,1);await assert.rejects(pending);await committed;
 assert.equal(f.counts().sttCalls,1);assert.equal(foreground,0);assert.ok(f.events.some(e=>e.type==='turnStarted'));assert.equal(f.session.outputAvailable,true);
});


test('a provider that will not settle produces a bounded ordinary-reply error without overlapping recognition', {timeout:22000},async()=>{
 const f=fixture();let release:()=>void=()=>{},entered:()=>void=()=>{},foreground=0;const started=new Promise<void>(r=>{entered=r;});
 f.tts.synthesize=async function*(request:any){yield {kind:'data',segmentId:request.segmentId,frame:f.frame(),mappingRevision:'map'};entered();await new Promise<void>(r=>{release=r;});};
 f.deps.foregroundStarted=()=>{foreground++;return()=>{foreground--;};};const pending=f.session.speakOutputOnly(f.input);await started;
 const audioInputId=randomUUID();await f.session.message(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId:f.sessionId,expectedSessionRevision:1,endpointId:f.endpointId,audioInputId,format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1}}}));await f.session.message(JSON.stringify({type:'frame',audioInputId,frame:{...f.frame(),format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1}}}));
 const committed=f.session.message(JSON.stringify({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:10}));
 try{await assert.rejects(pending);await committed;assert.equal(foreground,0);assert.equal(f.counts().sttCalls,0);assert.equal(f.events.at(-1).problem.code,'audio_previous_output_unsettled');assert.equal(f.session.outputAvailable,false);}finally{release();await new Promise(r=>setImmediate(r));}
 assert.equal(f.session.outputAvailable,true);
});
