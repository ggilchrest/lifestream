import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AudioSession, hasAudioEnergy, VOICE_TURN_DEADLINE_MS } from "../src/runtime/audio.ts";

const frame = (value: number) => { const bytes = Buffer.alloc(4800 * 2); for (let offset = 0; offset < bytes.length; offset += 2) bytes.writeInt16LE(value, offset); return { frameId: randomUUID(), sequence: 0, format: { encoding: "pcm_s16le" as const, sampleRateHz: 16000 as const, channels: 1 as const }, sampleOffset: 0, sampleCount: 4800, dataBase64: bytes.toString("base64") }; };

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
