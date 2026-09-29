import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AudioSession, hasAudioEnergy, VOICE_TURN_DEADLINE_MS } from "../src/runtime/audio.ts";
import {defaultVoiceSettings} from '../src/runtime/voice-settings.ts';
import {VisualObservationStore} from '@lifestream/runtime/perception/observation';
import {createPreparedTurnBinding} from '@lifestream/runtime/inference/prompt';
import type {VisualScope} from '@lifestream/runtime/perception/port';
import type {HostRuntimeInput} from '../src/runtime/inference.ts';

const frame = (value: number) => { const bytes = Buffer.alloc(4800 * 2); for (let offset = 0; offset < bytes.length; offset += 2) bytes.writeInt16LE(value, offset); return { frameId: randomUUID(), sequence: 0, format: { encoding: "pcm_s16le" as const, sampleRateHz: 16000 as const, channels: 1 as const }, sampleOffset: 0, sampleCount: 4800, dataBase64: bytes.toString("base64") }; };

function visualAudioHarness(beforeSynthesisTerminal:()=>Promise<void>=async()=>{}) {
  let now=100_000,authority=true,releases=0;
  const events:any[]=[],prompts:any[]=[],completed:string[]=[];
  const sessionId=randomUUID(),endpointId=randomUUID(),assistantId=randomUUID(),audioInputId=randomUUID(),leaseId=randomUUID();
  const scope:VisualScope={assistantId,principalId:randomUUID(),relationshipId:null,environmentId:'synthetic-audio',conversationId:randomUUID(),sessionId,endpointId,sessionRevision:1,audienceRevision:1,scopeGeneration:1,sourceBindingRef:'camera:synthetic-no-device',captureConfigurationRevision:1};
  const store=new VisualObservationStore({now:()=>now,current:()=>authority});
  assert.equal(store.publish({scope,leaseId,sequence:1,requestId:randomUUID(),capturedAtEarliestMs:now-100,capturedAtLatestMs:now-50,receivedAtMs:now-30,interpretedAtMs:now,provider:{id:'synthetic-visual',version:'1'},observations:[{observationId:'synthetic-scene',frameIds:[randomUUID()],appearance:'A striped synthetic object is beside a chair.',inference:'It may be a toy.',confidence:null,limitations:['Scripted fixture, not interpreted pixels.']}]}),true);
  const preparedTurnBinding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),scope:{assistantId:scope.assistantId,principalId:scope.principalId,relationshipId:scope.relationshipId,conversationId:scope.conversationId,sessionId:scope.sessionId,endpointId:scope.endpointId},conversation:'[]',sourceRevisions:{runtime:'synthetic-visual-audio',conversation:'synthetic-dialogue-1'}});
  const view=store.prepare({scope,leaseId,viewId:preparedTurnBinding.viewId,revision:preparedTurnBinding.revision,invalidationKey:preparedTurnBinding.invalidationKey,conversation:preparedTurnBinding.conversation,explicitQuestion:false,allowAside:true});
  assert.ok(view);
  const prepare=():HostRuntimeInput=>({assistantId,endpointId,preparedTurnBinding,preparedVisualContext:view,conversation:{read:()=>preparedTurnBinding.conversation,remember(){}},runtimeSelfContext:{sourceRevision:'synthetic-visual-audio',runtimeStatus:'ready',inputModalities:{text:'active',microphone:'activeForSession',visual:'activeForSession'},outputModalities:{text:'active',speechGeneration:'healthy',speechDelivery:'notObserved',presentation:'notConfigured'},endpointScope:'sessionEndpoint',audienceScope:'authenticatedSession',permissionState:'authenticatedSession',limitations:['Synthetic route verification; no physical audibility proof.']},isCurrent:()=>store.isCurrent(view),onCompleted:trace=>{completed.push(trace);store.markUsed(view);}});
  const stt={async *transcribe(){yield {kind:'data',payload:{type:'committed',text:'Explain the next task.'}};yield {kind:'terminal',outcome:'succeeded'};}};
  const inference={async *generate(request:unknown){prompts.push(request);yield {kind:'text',text:'Continue with the next task.'};}};
  const tts={async *synthesize(request:any){yield {kind:'data',segmentId:request.segmentId,frame:{...frame(100),format:request.format}};await beforeSynthesisTerminal();yield {kind:'terminal',outcome:'succeeded'};}};
  const session=new AudioSession({readyState:1,send:raw=>events.push(JSON.parse(raw)),close(){}},{stt:stt as never,inference:inference as never,tts:tts as never,prepare,outputLease:()=>({current:()=>true,release(){releases++;}})},sessionId);
  const receipt=()=>{const trace=events.findLast(event=>event.type==='turnStarted')?.interactionTraceId;return {trace,samples:events.filter(event=>event.type==='audio'&&event.interactionTraceId===trace).reduce((sum,event)=>sum+event.chunk.frame.sampleCount,0)};};
  const acknowledge=async(outcome='completed',receivedSamples=receipt().samples,interactionTraceId=receipt().trace)=>session.message(JSON.stringify({type:'playbackSettled',interactionTraceId,outcome,receivedSamples}));
  return {session,store,view,events,prompts,completed,receipt,acknowledge,releases:()=>releases,
    withdraw(){authority=false;store.invalidate(sessionId);},expire(){now=view.expiresAtMs;},
    async start(){await session.message(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,assistantId,expectedSessionRevision:1,endpointId,audioInputId,format:frame(0).format}}));},
    async turn(){await session.message(JSON.stringify({type:'frame',audioInputId,frame:frame(100)}));await session.message(JSON.stringify({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:4800}));},
    async close(){if(receipt().trace)await acknowledge('stopped',0);session.close();store.clear();}
  };
}

test('ordinary speech uses fresh visual context only in untrusted conversation and completes once after exact endpoint acknowledgment',async()=>{
  const f=visualAudioHarness();
  try{
    await f.start();await f.turn();
    assert.equal(f.prompts.length,1);
    const prompt=f.prompts[0],conversation=prompt.sections.find((section:any)=>section.kind==='conversation');
    assert.equal(prompt.sections.length,9);assert.equal(conversation.trusted,false);assert.equal(conversation.content,f.view.conversationContent);
    assert.match(conversation.content,/striped synthetic object/);assert.match(conversation.content,/Untrusted sampled visual observations/);
    assert.ok(prompt.sections.filter((section:any)=>section.kind!=='conversation').every((section:any)=>!section.content.includes('striped synthetic object')));
    assert.equal(prompt.sections.find((section:any)=>section.kind==='userInput').content,'Explain the next task.');
    assert.equal(f.events.at(-1).event.payload.state,'completed');assert.ok(f.receipt().samples>0);
    assert.deepEqual(f.completed,[],'synthesis completion is not endpoint playback settlement');assert.equal(f.releases(),0);
    await f.acknowledge('completed',f.receipt().samples-1);
    await f.acknowledge('completed',f.receipt().samples+1);
    await f.acknowledge('completed',f.receipt().samples,randomUUID());
    assert.deepEqual(f.completed,[]);assert.equal(f.releases(),0,'invalid receipts do not release the output lease');
    const trace=f.receipt().trace;await f.acknowledge();await f.acknowledge();
    assert.deepEqual(f.completed,[trace]);assert.equal(f.releases(),1);
  }finally{await f.close();}
});

test('visual withdrawal or capture expiry after synthesis fences unplayed speech and cannot count as completed',async()=>{
  for(const cause of ['withdrawal','expiry']){
    const f=visualAudioHarness();
    try{
      await f.start();await f.turn();assert.equal(f.events.at(-1).event.payload.state,'completed');assert.equal(f.releases(),0);
      if(cause==='withdrawal')f.withdraw();else f.expire();
      f.session.invalidateIfStale();
      assert.ok(f.events.some(event=>event.type==='stopPlayback'&&event.interactionTraceId===f.receipt().trace),cause);
      assert.deepEqual(f.completed,[]);await f.acknowledge();assert.deepEqual(f.completed,[],'a stale endpoint completed receipt cannot accept the view');
      await f.acknowledge('stopped',0);assert.equal(f.releases(),1);assert.deepEqual(f.completed,[]);
    }finally{await f.close();}
  }
});

test('stopped endpoint playback never records a completed visual mention',async()=>{
  const f=visualAudioHarness();
  try{await f.start();await f.turn();await f.acknowledge('stopped',0);await f.acknowledge();assert.deepEqual(f.completed,[]);assert.equal(f.releases(),1);}
  finally{await f.close();}
});

test('endpoint completed receipt before synthesis terminal is ignored until validated completion',async()=>{
  let release!:()=>void;const terminal=new Promise<void>(resolve=>{release=resolve;});
  const f=visualAudioHarness(()=>terminal);let turning:Promise<void>|undefined;
  try{
    await f.start();turning=f.turn();
    for(let attempt=0;attempt<30&&!f.events.some(event=>event.type==='audio');attempt++)await new Promise(resolve=>setImmediate(resolve));
    assert.ok(f.receipt().samples>0);await f.acknowledge();assert.deepEqual(f.completed,[]);assert.equal(f.releases(),0);
    release();await turning;assert.deepEqual(f.completed,[]);
    await f.acknowledge();await f.acknowledge();assert.deepEqual(f.completed,[f.receipt().trace]);assert.equal(f.releases(),1);
  }finally{release();await turning;await f.close();}
});
test('ordinary audio admits reference-only controls while rejecting unsupported description and seed',async()=>{
 const reference={sampleRateHz:16000 as const,dataBase64:Buffer.alloc(64000).toString('base64'),transcript:'Synthetic sample',consent:true as const};
 for(const [extra,referenceSupported,accepted] of [[{},true,true],[{description:'Unsupported'},true,false],[{seed:4},true,false],[{},false,false]] as const){
  const events:any[]=[],designs:any[]=[];const settings={...defaultVoiceSettings,reference,...extra};
  const tts={voiceControls:async()=>({description:false,reference:referenceSupported}),withVoiceDesign(design:any){designs.push(design);return this;},async *synthesize(request:any){yield {kind:'data',segmentId:request.segmentId,frame:frame(100)};yield {kind:'terminal',outcome:'succeeded'};}};
  const stt={async *transcribe(){yield {kind:'data',payload:{type:'committed',text:'Hello.'}};yield {kind:'terminal',outcome:'succeeded'};}},inference={async *generate(){yield {kind:'text',text:'A neutral reply.'};}};
  const sessionId=randomUUID(),audioInputId=randomUUID(),session=new AudioSession({readyState:1,send:raw=>events.push(JSON.parse(raw)),close(){}},{stt:stt as never,inference:inference as never,tts:tts as never},sessionId);
  try{
   await session.message(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,expectedSessionRevision:0,endpointId:randomUUID(),audioInputId,format:frame(0).format,voiceSettings:settings}}));assert.equal(events.some(e=>e.type==='accepted'),accepted);
   if(accepted){await session.message(JSON.stringify({type:'frame',audioInputId,frame:frame(100)}));await session.message(JSON.stringify({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:4800}));assert.equal(events.at(-1).event.payload.state,'completed');assert.deepEqual(designs[0],{description:'',seed:0,reference});}
   else {assert.equal(events.at(-1).type,'error');assert.equal(designs.length,0);}
  }finally{session.close();}
 }
});
test('ordinary voice starts a substantial first clause before inference completes without dropping its continuation',async()=>{
 const events:any[]=[],spoken:string[]=[];
 const first='The gardener carefully checked the quiet greenhouse before opening the door,',rest='and found a smooth blue stone beside the oldest rose bush.';
 let synthesisStarted!:()=>void,timer:ReturnType<typeof setTimeout>|undefined;
 const started=new Promise<void>((resolve,reject)=>{synthesisStarted=resolve;timer=setTimeout(()=>reject(new Error('First clause did not reach synthesis while inference was pending')),1000);});
 const stt={async *transcribe(){yield {kind:'data',payload:{type:'committed',text:'Tell me a story.'}};yield {kind:'terminal',outcome:'succeeded'};}};
 const inference={async *generate(){yield {kind:'text',text:first+' '};await started;assert.deepEqual(spoken,[first]);yield {kind:'text',text:rest};}};
 const tts={async *synthesize(request:any){spoken.push(request.text);synthesisStarted();yield {kind:'data',segmentId:request.segmentId,frame:{...frame(100),format:request.format}};yield {kind:'terminal',outcome:'succeeded'};}};
 const sessionId=randomUUID(),audioInputId=randomUUID(),session=new AudioSession({readyState:1,send:raw=>events.push(JSON.parse(raw)),close(){}},{stt:stt as never,inference:inference as never,tts:tts as never},sessionId);
 try{
  await session.message(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,expectedSessionRevision:0,endpointId:randomUUID(),audioInputId,format:frame(0).format}}));
  await session.message(JSON.stringify({type:'frame',audioInputId,frame:frame(100)}));
  await session.message(JSON.stringify({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:4800}));
  assert.deepEqual(spoken,[first,rest]);assert.equal(events.at(-1).event.payload.state,'completed');
  assert.equal(events.filter(e=>e.event?.payload.type==='textDelta').map(e=>e.event.payload.text).join(''),first+' '+rest);
 }finally{clearTimeout(timer);session.close();}
});
test('a cached acknowledgment follows accepted recognition and lease, before inference, without entering the answer',async()=>{
 const events:any[]=[],order:string[]=[],prompts:any[]=[];let failed=false,cacheBroken=false;
 const socket={readyState:1,send:(raw:string)=>{const value=JSON.parse(raw);events.push(value);order.push(value.type);},close(){}},stt={async *transcribe(){yield {kind:'data',payload:{type:'committed',text:'Synthetic speech.'}};order.push('recognition-settled');yield {kind:'terminal',outcome:failed?'failed':'succeeded'};}},inference={async *generate(request:any){order.push('inference');prompts.push(request);yield {kind:'text',text:'Actual answer.'};}},tts={async *synthesize(request:any){yield {kind:'data',segmentId:request.segmentId,frame:frame(100)};yield {kind:'terminal',outcome:'succeeded'};}};
 const sessionId=randomUUID(),audioInputId=randomUUID(),session=new AudioSession(socket,{stt:stt as never,inference:inference as never,tts:tts as never,outputLease:()=>{order.push('lease');return {current:()=>true,release(){}};},acknowledgment:()=>{if(cacheBroken)throw Error('Broken catalog');return {binding:'synthetic-voice',revision:4,clipIds:['synthetic-clip']};}},sessionId);
 await session.message(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,expectedSessionRevision:1,endpointId:randomUUID(),audioInputId,format:frame(0).format}}));
 const turn=async()=>{await session.message(JSON.stringify({type:'frame',audioInputId,frame:frame(100)}));await session.message(JSON.stringify({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:4800}));const trace=events.findLast(e=>e.type==='turnStarted').interactionTraceId;if(events.at(-1).event?.payload.state==='completed')await session.message(JSON.stringify({type:'playbackSettled',interactionTraceId:trace,outcome:'completed',receivedSamples:events.filter(e=>e.type==='audio'&&e.interactionTraceId===trace).reduce((n,e)=>n+e.chunk.frame.sampleCount,0)}));};await turn();assert.ok(order.indexOf('acknowledgment')>order.indexOf('recognition-settled'));assert.ok(order.indexOf('acknowledgment')>order.indexOf('lease'));assert.ok(order.indexOf('acknowledgment')<order.indexOf('inference'));assert.equal(events.filter(e=>e.type==='acknowledgment').length,1);assert.doesNotMatch(JSON.stringify(prompts),/synthetic-clip|synthetic-voice/);assert.equal(events.at(-1).event.payload.state,'completed');assert.equal(events.filter(e=>e.event?.payload.type==='textDelta').map(e=>e.event.payload.text).join(''),'Actual answer.');failed=true;await turn();assert.equal(events.filter(e=>e.type==='acknowledgment').length,1);failed=false;cacheBroken=true;await turn();assert.equal(events.at(-1).event.payload.state,'completed');assert.equal(events.filter(e=>e.type==='acknowledgment').length,1);session.close();
});
test('saved voice settings reach ordinary speech and voice replacement fences the microphone binding',async()=>{
 const events:any[]=[],spoken:any[]=[],designs:any[]=[];let current=true;
 const settings={...defaultVoiceSettings,description:'Synthetic saved voice',seed:7,pace:.35};
 const tts={voiceControls:async()=>({description:true,reference:true}),withVoiceDesign(design:any){designs.push(design);return this;},async *synthesize(request:any){spoken.push(request);yield {kind:'data',segmentId:request.segmentId,frame:frame(1200)};yield {kind:'terminal',outcome:'succeeded'};}};
 const stt={async *transcribe(){yield {kind:'data',payload:{type:'committed',text:'Hello.'}};yield {kind:'terminal',outcome:'succeeded'};}},inference={async *generate(){yield {kind:'text',text:'A synthetic reply.'};}};
 const sessionId=randomUUID(),audioInputId=randomUUID(),session=new AudioSession({readyState:1,send:value=>events.push(JSON.parse(value)),close:()=>{}},{stt:stt as never,inference:inference as never,tts:tts as never,resolveVoice:()=>({settings,voiceProfile:{voiceRef:'saved-voice:synthetic',revision:3},language:'en',current:()=>current})},sessionId);
 await session.message(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,expectedSessionRevision:1,endpointId:randomUUID(),audioInputId,format:frame(0).format}}));
 await session.message(JSON.stringify({type:'frame',audioInputId,frame:frame(100)}));await session.message(JSON.stringify({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:4800}));assert.equal(events.at(-1).event.payload.state,'completed');assert.deepEqual(spoken[0].voiceProfile,{voiceRef:'saved-voice:synthetic',revision:3});assert.equal(spoken[0].delivery.pace,.35);assert.equal(designs[0].description,settings.description);assert.doesNotMatch(spoken[0].text,/Synthetic saved voice/);
 current=false;session.invalidateIfStale();assert.equal(session.outputConnected,false);assert.equal(events.at(-1).problem.code,'audio_input_scope_changed');assert.equal(spoken.length,1);
});

test("PCM level diagnostic measures energy only, not speech qualification", () => { assert.equal(hasAudioEnergy(frame(0).dataBase64), false); assert.equal(hasAudioEnergy(frame(1200).dataBase64), true); });

test("audio uses host world preparation and fences an invalidated world reply before text or PCM", async () => {
  const events: any[] = []; const requests: any[] = []; let current = true;
  const socket = { readyState: 1, send: (value: string) => events.push(JSON.parse(value)), close: () => undefined };
  const stt = { async *transcribe() { yield { kind: "data", payload: { type: "committed", text: "synthetic input" } }; } };
  const inference = { async *generate(request: unknown) { requests.push(request); current = false; yield { kind: "text", text: "STALE_PRIVATE_SPEECH" }; } };
  const tts = { async *synthesize() { yield { kind: "data", segmentId: randomUUID(), frame: frame(1200) }; yield { kind: "terminal", outcome: "succeeded" }; } };
  const prepare = () => ({ assistantId: "synthetic-assistant", runtimeSelfContext: { sourceRevision: "host-state-2", runtimeStatus: "ready" as const, inputModalities: { text: "active" as const, microphone: "activeForSession" as const, visual: "notConfigured" as const }, outputModalities: { text: "active" as const, speechGeneration: "healthy" as const, speechDelivery: "notObserved" as const, presentation: "notConfigured" as const }, endpointScope: "sessionEndpoint" as const, audienceScope: "authenticatedSession" as const, permissionState: "authenticatedSession" as const, limitations: ["No physical audibility observation."] }, profileProjection: { sourceRef: "assistant-profile:synthetic", sourceRevision: "3", corePersona: "Synthetic active core", adaptivePersona: "No active adaptation" }, prepareWorld: async () => ({context:{content:"Synthetic qualified world",sourceRef:"pwce:prepared-world",sourceRevision:"synthetic-world-revision"},isCurrent:()=>current,isSnapshotCurrent:()=>current}), isCurrent: () => true });
  const sessionId = randomUUID(), audioInputId = randomUUID(); const session = new AudioSession(socket, { stt: stt as never, inference: inference as never, tts: tts as never, prepare }, sessionId);
  await session.message(JSON.stringify({ type: "start", request: { schemaVersion: "1.0.0", requestId: randomUUID(), correlationId: randomUUID(), sessionId, expectedSessionRevision: 1, endpointId: randomUUID(), audioInputId, format: frame(0).format } }));
  await session.message(JSON.stringify({ type: "frame", audioInputId, frame: frame(0) })); await session.message(JSON.stringify({ type: "commitTurn", audioInputId, nextSequence: 1, sampleCount: 4800 }));
  assert.equal(requests[0].sections.find((section:any)=>section.kind==="worldContext").content,"Synthetic qualified world"); assert.equal(requests[0].sections.find((section:any)=>section.kind==="worldContext").trusted,false);
  assert.equal(requests[0].scope.assistantId, "synthetic-assistant"); assert.equal(requests[0].sections.find((section: any) => section.kind === "corePersona").sourceRevision, "3"); assert.match(requests[0].sections.find((section: any) => section.kind === "interactionState").content, /speechDelivery=notObserved/u);
  assert.ok(events.some((event) => event.type === "stopPlayback")); assert.equal(events.filter((event) => event.type === "audio").length, 0); assert.doesNotMatch(JSON.stringify(events), /STALE_PRIVATE_SPEECH/u); assert.equal(events.at(-1).event.payload.state, "interrupted");
});

test('recognition finishes and releases its transport before inference and playback', async () => {
  const events:any[]=[]; let released=false;
  const socket={readyState:1,send:(value:string)=>events.push(JSON.parse(value)),close:()=>undefined};
  const stt={async *transcribe(){try{yield {kind:'data',payload:{type:'committed',text:'Hello.'}};yield {kind:'terminal',outcome:'succeeded'};}finally{released=true;}}};
  const inference={async *generate(){assert.equal(released,true,'STT must not retain its socket/deadline across TTS');yield {kind:'text',text:'Ready.'};}};
  const tts={async *synthesize(){yield {kind:'data',segmentId:randomUUID(),frame:frame(1200)};yield {kind:'terminal',outcome:'succeeded'};}};
  const sessionId=randomUUID(),audioInputId=randomUUID(),session=new AudioSession(socket,{stt:stt as never,inference:inference as never,tts:tts as never},sessionId);
  await session.message(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,expectedSessionRevision:1,endpointId:randomUUID(),audioInputId,format:frame(0).format}}));
  await session.message(JSON.stringify({type:'frame',audioInputId,frame:frame(0)}));
  await session.message(JSON.stringify({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:4800}));
  assert.equal(events.at(-1).event.payload.state,'completed');
  assert.equal(events.filter(e=>e.event?.payload.type==='terminal').length,1);
});

test('STT terminal failure is visible and does not poison the next turn', async () => {
  const events:any[]=[]; let attempts=0;
  const socket={readyState:1,send:(value:string)=>events.push(JSON.parse(value)),close:()=>undefined};
  const stt={async *transcribe(){if(++attempts===1)yield {kind:'terminal',outcome:'failed'};else yield {kind:'data',payload:{type:'committed',text:'Recovered.'}};}};
  const inference={async *generate(){yield {kind:'text',text:'Ready.'};}};
  const tts={async *synthesize(){yield {kind:'data',segmentId:randomUUID(),frame:frame(1200)};yield {kind:'terminal',outcome:'succeeded'};}};
  const sessionId=randomUUID(),audioInputId=randomUUID(),session=new AudioSession(socket,{stt:stt as never,inference:inference as never,tts:tts as never},sessionId);
  await session.message(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,expectedSessionRevision:1,endpointId:randomUUID(),audioInputId,format:frame(0).format}}));
  for(let i=0;i<2;i++){
    await session.message(JSON.stringify({type:'frame',audioInputId,frame:frame(0)}));
    await session.message(JSON.stringify({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:4800}));
    if(!i)assert.match(events.at(-1).event.payload.error.message,/Speech recognition failed/);
  }
  assert.equal(events.at(-1).event.payload.state,'completed');
  assert.equal(events.filter(e=>e.type==='transcript').length,1);
});

test("a multi-sentence reply over 30 seconds gets fresh bounded segment deadlines", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const events: any[] = [], deadlines: number[] = [];
  const socket = { readyState: 1, send: (value: string) => events.push(JSON.parse(value)), close: () => undefined };
  const stt = { async *transcribe() { yield {kind:"data",payload:{type:"committed",text:"Explain in three sentences"}}; } };
  const inference = { async *generate() { for(let i=0;i<3;i++) yield {kind:"text",text:"This is one sentence that should be spoken clearly. "}; } };
  const tts = { async *synthesize(request: {deadlineAt:string}) {deadlines.push(Date.parse(request.deadlineAt));context.mock.timers.tick(16_000);yield {kind:"data",segmentId:randomUUID(),frame:frame(1200)};yield {kind:"terminal",outcome:"succeeded"};} };
  const sessionId=randomUUID(),audioInputId=randomUUID(),session=new AudioSession(socket,{stt:stt as never,inference:inference as never,tts:tts as never},sessionId);
  await session.message(JSON.stringify({type:"start",request:{schemaVersion:"1.0.0",requestId:randomUUID(),correlationId:randomUUID(),sessionId,expectedSessionRevision:1,endpointId:randomUUID(),audioInputId,format:frame(0).format}}));
  await session.message(JSON.stringify({type:"frame",audioInputId,frame:frame(0)}));
  await session.message(JSON.stringify({type:"commitTurn",audioInputId,nextSequence:1,sampleCount:4800}));
  assert.ok(deadlines.length>=3);assert.ok(deadlines[1]!>deadlines[0]!);assert.equal(events.at(-1).event.payload.state,"completed");
});

test("duplicate start during voice capability lookup cannot revive a closed session", async () => {
  const events: any[] = [];
  const socket = { readyState: 1, send: (value: string) => events.push(JSON.parse(value)), close: () => undefined };
  let release!: (value: { description: boolean; reference: boolean }) => void;
  const tts = { voiceControls: () => new Promise(resolve => { release = resolve; }) };
  const sessionId = randomUUID();
  const session = new AudioSession(socket, { stt: {} as never, inference: {} as never, tts: tts as never }, sessionId);
  const start = JSON.stringify({ type: "start", request: { schemaVersion: "1.0.0", requestId: randomUUID(), correlationId: randomUUID(), sessionId, expectedSessionRevision: 1, endpointId: randomUUID(), audioInputId: randomUUID(), format: frame(0).format, voiceSettings: { description: "calm" } } });
  const first = session.message(start);
  await session.message(start);
  release({ description: true, reference: true }); await first;
  assert.equal(events.filter(event => event.type === "accepted").length, 0);
});

test("a voice deadline fails visibly and the same session accepts the next turn", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const events: any[] = [];
  const socket = { readyState: 1, send: (value: string) => events.push(JSON.parse(value)), close: () => undefined };
  const stt = { async *transcribe() { yield { kind: "data", payload: { type: "committed", text: "hello" } }; } };
  const inference = { async *generate() { yield { kind: "text", text: "Hello." }; } };
  let requests = 0;
  const tts = { async *synthesize(_request: unknown, signal: AbortSignal) {
    if (++requests === 1) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    yield { kind: "data", segmentId: randomUUID(), frame: frame(1200) };
    yield { kind: "terminal", outcome: "succeeded" };
  } };
  const sessionId = randomUUID(), audioInputId = randomUUID();
  const session = new AudioSession(socket, { stt: stt as never, inference: inference as never, tts: tts as never }, sessionId);
  await session.message(JSON.stringify({ type: "start", request: { schemaVersion: "1.0.0", requestId: randomUUID(), correlationId: randomUUID(), sessionId, expectedSessionRevision: 1, endpointId: randomUUID(), audioInputId, format: frame(0).format } }));
  await session.message(JSON.stringify({ type: "frame", audioInputId, frame: frame(0) }));
  const first = session.message(JSON.stringify({ type: "commitTurn", audioInputId, nextSequence: 1, sampleCount: 4800 }));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  context.mock.timers.tick(VOICE_TURN_DEADLINE_MS); await first;
  assert.equal(events.at(-1).event.payload.error.code, "audio_deadline_exceeded");
  await session.message(JSON.stringify({ type: "frame", audioInputId, frame: frame(0) }));
  await session.message(JSON.stringify({ type: "commitTurn", audioInputId, nextSequence: 1, sampleCount: 4800 }));
  assert.equal(events.at(-1).event.payload.state, "completed");
  assert.equal(requests, 2);
});

test("three TTS barge-ins release queued transcription and disconnect cancels synthesis", async () => {
  const events: any[] = [];
  const signals: AbortSignal[] = [];
  const socket = { readyState: 1, send: (value: string) => events.push(JSON.parse(value)), close: () => { socket.readyState = 3; } };
  let transcripts = 0;
  const stt = { async *transcribe() { transcripts++; yield { kind: "data", payload: { type: "committed", text: "hello" } }; } };
  const inference = { async *generate() { yield { kind: "text", text: "A short reply." }; } };
  const tts = { async *synthesize(_request: unknown, signal: AbortSignal) {
    assert.ok(signal, "the voice turn must pass cancellation to TTS");
    signals.push(signal);
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    yield { kind: "terminal", outcome: "cancelled" };
  } };
  const sessionId = randomUUID(), audioInputId = randomUUID();
  const session = new AudioSession(socket, { stt: stt as never, inference: inference as never, tts: tts as never }, sessionId);
  await session.message(JSON.stringify({ type: "start", request: { schemaVersion: "1.0.0", requestId: randomUUID(), correlationId: randomUUID(), sessionId, expectedSessionRevision: 1, endpointId: randomUUID(), audioInputId, format: frame(0).format } }));
  const running: Promise<void>[] = [];
  for (let turn = 0; turn < 4; turn++) {
    if(turn){const active=events.filter(event=>event.type==="turnStarted").at(-1);await session.message(JSON.stringify({type:"interrupt",interactionTraceId:active.interactionTraceId,reason:"speech qualified by endpoint"}));}
    await session.message(JSON.stringify({ type: "frame", audioInputId, frame: frame(1200) }));
    running.push(session.message(JSON.stringify({ type: "commitTurn", audioInputId, nextSequence: 1, sampleCount: 4800 })));
    for (let attempts = 0; signals.length <= turn && attempts < 50; attempts++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(transcripts, turn + 1, "the next utterance must reach STT");
    assert.equal(signals.length, turn + 1);
  }
  session.close();
  await Promise.all(running);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(events.filter(event => event.type === "transcript").length, 4);
  assert.equal(events.filter(event => event.event?.payload.type === "terminal").length, 3);
});

test("canonical audio interrupt fences downstream work and playback", async () => {
  const events: Record<string, unknown>[] = [];
  const socket = { readyState: 1, send: (value: string) => events.push(JSON.parse(value)), close: () => undefined };
  let release: (() => void) | undefined;
  const stt = { async *transcribe() { yield { kind: "data" as const, sequence: 0, payload: { type: "committed" as const, utteranceId: randomUUID(), text: "hello", startSample: 0, endSample: 4800, speakerRef: null, confidence: 0 } }; } };
  const inference = { async *generate(_request: unknown, context: { signal: AbortSignal }) { yield { kind: "text" as const, text: "answer" }; await new Promise<void>((resolve) => { release = resolve; context.signal.addEventListener("abort", () => { resolve(); }, { once: true }); }); } };
  const tts = { synthesize: async function* () { yield { kind: "terminal" as const, sequence: 0, segmentId: randomUUID(), outcome: "cancelled" as const, outputSamples: 0, frameCount: 0, disposition: "cancelled" as const, degradedDimensions: [], mappingRevision: "test" }; } };
  const sessionId = randomUUID(); const endpointId = randomUUID(); const audioInputId = randomUUID(); const correlationId = randomUUID(); const session = new AudioSession(socket, { stt: stt as never, inference: inference as never, tts: tts as never }, sessionId);
  await session.message(JSON.stringify({ type: "start", request: { schemaVersion: "1.0.0", requestId: randomUUID(), correlationId, sessionId, expectedSessionRevision: 1, endpointId, audioInputId, format: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 } } }));
  await session.message(JSON.stringify({ type: "frame", audioInputId, frame: frame(0) }));
  const turn = session.message(JSON.stringify({ type: "commitTurn", audioInputId, nextSequence: 1, sampleCount: 4800 }));
  for (let attempt = 0; attempt < 20 && !events.some((event) => event.type === "response"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const response = events.find((event) => event.type === "response") as { event?: { interactionTraceId?: string } } | undefined; const traceId = response?.event?.interactionTraceId;
  assert.ok(traceId);
  await session.message(JSON.stringify({ type: "interrupt", interactionTraceId: traceId, reason: "user resumed speaking" }));
  release?.(); await turn;
  assert.ok(events.some((event) => event.type === "stopPlayback")); assert.equal((events.at(-1) as { event: { payload: { state: string } } }).event.payload.state, "interrupted");
});

test("committed speech is rendered as a user transcript before the Assistant response", async () => {
  const events: Record<string, unknown>[] = [];
  const socket = { readyState: 1, send: (value: string) => events.push(JSON.parse(value)), close: () => undefined };
  const stt = { async *transcribe() { yield { kind: "data" as const, sequence: 0, payload: { type: "committed" as const, utteranceId: randomUUID(), text: "what is ready", startSample: 0, endSample: 4800, speakerRef: null, confidence: 1 } }; } };
  const inference = { async *generate() { yield { kind: "text" as const, text: "The Assistant runtime is ready." }; } };
  const tts = { async *synthesize() { yield { kind: "data", segmentId: randomUUID(), frame: frame(1200) }; yield { kind: "terminal" as const, sequence: 1, segmentId: randomUUID(), outcome: "succeeded" as const, outputSamples: 4800, frameCount: 1, disposition: "delivered" as const, degradedDimensions: [], mappingRevision: "test" }; } };
  const sessionId = randomUUID(); const endpointId = randomUUID(); const audioInputId = randomUUID();
  const session = new AudioSession(socket, { stt: stt as never, inference: inference as never, tts: tts as never }, sessionId);
  await session.message(JSON.stringify({ type: "start", request: { schemaVersion: "1.0.0", requestId: randomUUID(), correlationId: randomUUID(), sessionId, expectedSessionRevision: 1, endpointId, audioInputId, format: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 } } }));
  await session.message(JSON.stringify({ type: "frame", audioInputId, frame: frame(0) }));
  await session.message(JSON.stringify({ type: "commitTurn", audioInputId, nextSequence: 1, sampleCount: 4800 }));
  const transcript = events.find((event) => event.type === "transcript") as { text?: string } | undefined;
  const deltas = events.filter((event) => event.type === "response").map((event) => (event.event as { payload?: { type?: string; text?: string } }).payload).filter((payload) => payload?.type === "textDelta");
  assert.equal(transcript?.text, "what is ready"); assert.deepEqual(deltas.map((delta) => delta?.text), ["The Assistant runtime is ready."]); assert.ok(events.some((event) => (event.event as { payload?: { state?: string } })?.payload?.state === "completed"));
});

test('stale input is rejected before start or buffered commit reaches recognition',async()=>{
 for(const staleAt of ['start','frame','commit']){
  const events:any[]=[];let current=staleAt!=='start',recognition=0,closed=0;
  const socket={readyState:1,send:(value:string)=>events.push(JSON.parse(value)),close:()=>{closed++;}};
  const stt={async *transcribe(){recognition++;yield {kind:'data',payload:{type:'committed',text:'Must not be recognized.'}};}};
  const sessionId=randomUUID(),audioInputId=randomUUID(),session=new AudioSession(socket,{stt:stt as never,inference:{} as never,tts:{} as never,inputCurrent:()=>current},sessionId);
  await session.message(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,expectedSessionRevision:1,endpointId:randomUUID(),audioInputId,format:frame(0).format}}));
  if(staleAt==='frame')current=false;
  await session.message(JSON.stringify({type:'frame',audioInputId,frame:frame(0)}));current=false;
  await session.message(JSON.stringify({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:4800}));
  assert.equal(recognition,0,staleAt);assert.equal(closed,1);assert.equal(events.filter(e=>e.type==='error'&&e.problem.code==='audio_input_scope_changed').length,1);assert.equal(events.some(e=>e.type==='turnStarted'),false);
 }
});

test('session revision changes during capability lookup cannot acknowledge a stale microphone start',async()=>{
 const events:any[]=[];let current=true,release!:(value:any)=>void;
 const socket={readyState:1,send:(value:string)=>events.push(JSON.parse(value)),close:()=>undefined},tts={voiceControls:()=>new Promise(r=>{release=r;})};
 const sessionId=randomUUID(),session=new AudioSession(socket,{stt:{} as never,inference:{} as never,tts:tts as never,inputCurrent:()=>current},sessionId);
 const start=session.message(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,expectedSessionRevision:1,endpointId:randomUUID(),audioInputId:randomUUID(),format:frame(0).format,voiceSettings:{description:'calm'}}}));
 current=false;release({description:true,reference:true});await start;assert.equal(events.some(e=>e.type==='accepted'),false);assert.equal(events.at(-1).problem.code,'audio_input_scope_changed');
});

test('recognition cannot publish a late transcript or invoke inference after input scope changes',async()=>{
 const events:any[]=[];let current=true,inferenceCalls=0,entered!:()=>void,release!:()=>void,aborted=false;
 const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 const socket={readyState:1,send:(value:string)=>events.push(JSON.parse(value)),close:()=>undefined};
 const stt={async *transcribe(_context:unknown,_audio:unknown,signal:AbortSignal){entered();await gate;aborted=signal.aborted;yield {kind:'data',payload:{type:'committed',text:'STALE_CAPTURE_TRANSCRIPT'}};yield {kind:'terminal',outcome:'succeeded'};}};
 const inference={async *generate(){inferenceCalls++;yield {kind:'text',text:'Must not run.'};}};
 const sessionId=randomUUID(),audioInputId=randomUUID(),session=new AudioSession(socket,{stt:stt as never,inference:inference as never,tts:{} as never,inputCurrent:()=>current},sessionId);
 await session.message(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,expectedSessionRevision:1,endpointId:randomUUID(),audioInputId,format:frame(0).format}}));
 await session.message(JSON.stringify({type:'frame',audioInputId,frame:frame(0)}));const turn=session.message(JSON.stringify({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:4800}));await started;
 current=false;session.invalidateIfStale();release();await turn;assert.equal(aborted,true);assert.equal(inferenceCalls,0);assert.doesNotMatch(JSON.stringify(events),/STALE_CAPTURE_TRANSCRIPT/);assert.ok(events.some(e=>e.type==='stopPlayback'));
});

test('queued voice input cannot start recognition after the captured session is invalidated',async()=>{
 const events:any[]=[];let current=true,recognition=0,entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 const socket={readyState:1,send:(value:string)=>events.push(JSON.parse(value)),close:()=>undefined};
 const stt={async *transcribe(){recognition++;entered();await gate;yield {kind:'data',payload:{type:'committed',text:'QUEUED_STALE_CAPTURE'}};}};
 const sessionId=randomUUID(),audioInputId=randomUUID(),session=new AudioSession(socket,{stt:stt as never,inference:{} as never,tts:{} as never,inputCurrent:()=>current},sessionId);
 await session.message(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,expectedSessionRevision:1,endpointId:randomUUID(),audioInputId,format:frame(0).format}}));
 const commit=JSON.stringify({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:4800});
 await session.message(JSON.stringify({type:'frame',audioInputId,frame:frame(0)}));const first=session.message(commit);await started;
 await session.message(JSON.stringify({type:'frame',audioInputId,frame:frame(0)}));const second=session.message(commit);current=false;session.invalidateIfStale();release();await Promise.all([first,second]);
 assert.equal(recognition,1);assert.doesNotMatch(JSON.stringify(events),/QUEUED_STALE_CAPTURE/);assert.equal(events.filter(e=>e.type==='turnStarted').length,1);
});
