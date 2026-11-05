// Actual AudioSession, synthetic providers, no microphone/network/model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AudioSession,VOICE_INPUT_MAX_SAMPLES,VOICE_INPUT_MAX_FRAMES} from '../src/runtime/audio.ts';
import {NemoSpeechProvider} from '@lifestream/providers-nemo-speech';
const format={encoding:'pcm_s16le',sampleRateHz:16000,channels:1};
const held=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function until(check){for(let n=0;n<100&&!check();n++)await new Promise(r=>setImmediate(r));assert.ok(check(),'controlled phase reached');}
function frames(samples,size=1600){const out=[];for(let n=0;n<samples;){const count=Math.min(size,samples-n),b=Buffer.alloc(count*2);b.writeInt16LE(out.length+1,0);b.writeInt16LE(out.length+1,b.length-2);out.push({frameId:randomUUID(),sequence:out.length,format,sampleOffset:n,sampleCount:count,dataBase64:b.toString('base64')});n+=count;}return out;}
async function fixture({stage,recognitionHold,generationHold,ttsHold}={}){
 const sessionId=randomUUID(),audioInputId=randomUUID(),events=[],diagnostics=[],observed={calls:0,samples:0,frames:0,first:null,last:null,inference:0,tts:0},gate=held();let current=true,leaseCurrent=true;
 const socket={readyState:1,send(raw){events.push(JSON.parse(raw));},close(){this.readyState=3;}};
 const host={assistantId:randomUUID(),isCurrent:()=>current,runtimeSelfContext:{sourceRevision:'synthetic-long-input',runtimeStatus:'ready',inputModalities:{text:'active',microphone:'activeForSession',visual:'notConfigured'},outputModalities:{text:'active',speechGeneration:'healthy',speechDelivery:'notObserved',presentation:'notConfigured'},endpointScope:'sessionEndpoint',audienceScope:'authenticatedSession',permissionState:'authenticatedSession',limitations:['Synthetic tests only.']}};
 const secret=()=>Error('PRIVATE_TRANSCRIPT_PROVIDER_SECRET');
 const deps={failureDiagnostic:r=>diagnostics.push(r),inputCurrent:()=>current,
 stt:{async*transcribe(request,audio,signal){observed.calls++;assert.ok(Date.parse(request.deadlineAt)-Date.now()<=30000);for await(const x of audio){if(x.type==='frame'){const b=Buffer.from(x.frame.dataBase64,'base64');observed.first??=b.readInt16LE(0);observed.last=b.readInt16LE(b.length-2);observed.samples+=x.frame.sampleCount;observed.frames++;}else assert.equal(x.sampleCount,observed.samples);}if(recognitionHold)await gate.promise;if(stage==='recognition')throw secret();yield {kind:'data',payload:{type:'committed',text:'Synthetic complete question'}};yield {kind:'terminal',outcome:'succeeded'};}},
 inference:{async*generate(){observed.inference++;if(stage==='inference')throw secret();if(stage==='framing'){yield {kind:'text',text:'invalid voice response'};yield {kind:'done'};return;}yield {kind:'text',text:JSON.stringify({version:'voice-response/1'})+'\n'+JSON.stringify({channel:'speech',text:'A complete synthetic response with enough content to exercise the original speech delivery pipeline.'})+'\n'};if(generationHold)await gate.promise;yield {kind:'done'};}},
 tts:{async*synthesize(request){observed.tts++;if(ttsHold)await gate.promise;if(stage==='synthesis')throw secret();if(stage==='no_audio'){yield {kind:'terminal',outcome:'succeeded'};return;}if(stage==='delivery')leaseCurrent=false;yield {kind:'data',segmentId:request.segmentId,frame:{...frames(480)[0],format:request.format}};yield {kind:'terminal',outcome:'succeeded'};}},
 prepare:request=>{if(request.userInput&&stage==='preparation')throw secret();const value={...host};if(stage==='memory')value.prepareMemory=async()=>{throw secret();};if(stage==='world')value.prepareWorld=async()=>{throw secret();};return value;}
 };
 if(stage==='delivery'||stage==='settlement')deps.outputLease=()=>({current:()=>leaseCurrent,release(){if(stage==='settlement')throw secret();}});
 const session=new AudioSession(socket,deps,sessionId);
 await session.message(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,assistantId:host.assistantId,endpointId:randomUUID(),expectedSessionRevision:1,audioInputId,format}}));assert.ok(events.some(e=>e.type==='accepted'));
 return {session,socket,events,diagnostics,observed,release:gate.resolve,revoke(){current=false;session.invalidateIfStale();gate.resolve();},terminal:()=>events.findLast(e=>e.event?.payload.type==='terminal')?.event.payload,
 async input(samples,size=1600){const input=frames(samples,size);for(const frame of input)await session.message(JSON.stringify({type:'frame',audioInputId,frame}));return input;},
 commit(input){return session.message(JSON.stringify({type:'commitTurn',audioInputId,nextSequence:input.length,sampleCount:input.reduce((n,f)=>n+f.sampleCount,0)}));},
 async interrupt(){await session.message(JSON.stringify({type:'interrupt',interactionTraceId:events.findLast(e=>e.type==='turnStarted').interactionTraceId,reason:'Synthetic Stop'}));gate.resolve();},close(){gate.resolve();session.close();}
 };
}
for(const seconds of [25,31,45,60,90])test(`actual session preserves one complete ${seconds}s utterance, no ASR before commit`,async()=>{
 const f=await fixture();try{const input=await f.input(seconds*16000);assert.equal(f.observed.calls,0);assert.equal(f.events.filter(e=>e.type==='turnStarted').length,0);await f.commit(input);assert.equal(f.observed.calls,1);assert.equal(f.observed.samples,seconds*16000);assert.equal(f.observed.first,1);assert.equal(f.observed.last,input.length);assert.equal(f.events.filter(e=>e.type==='turnStarted').length,1);assert.equal(f.terminal().state,'completed');assert.equal(f.diagnostics.length,0);}finally{f.close();}
});
test('90s plus one sample discards whole uncommitted input; late commit cannot publish',async()=>{
 const f=await fixture();try{const input=await f.input(VOICE_INPUT_MAX_SAMPLES+1);assert.equal(f.observed.calls,0);assert.equal(f.socket.readyState,3);assert.ok(f.events.some(e=>e.problem?.code==='audio_input_limit'));await f.commit(input);assert.equal(f.observed.calls,0);assert.equal(f.session.frames.length,0);assert.equal(f.session.bufferedSamples,0);}finally{f.close();}
});
test('6000 tiny frames accepted, frame 6001 rejects whole input even below sample cap',async()=>{
 const f=await fixture();try{const input=await f.input(VOICE_INPUT_MAX_FRAMES+1,1);assert.equal(f.observed.calls,0);assert.ok(f.events.some(e=>e.problem?.code==='audio_input_limit'));assert.equal(f.session.frames.length,0);await f.commit(input);assert.equal(f.observed.calls,0);}finally{f.close();}
});
test('explicit partial-frame Finish commit and delayed ASR publish exactly once',async()=>{
 const f=await fixture({recognitionHold:true});try{const input=await f.input(31*16000+37);const pending=f.commit(input);await until(()=>f.observed.calls===1);assert.equal(f.observed.samples,496037);assert.equal(f.events.some(e=>e.type==='transcript'),false);await new Promise(r=>setTimeout(r,25));assert.equal(f.observed.inference,0);f.release();await pending;assert.equal(f.events.filter(e=>e.type==='transcript').length,1);assert.equal(f.terminal().state,'completed');}finally{f.close();}
});
for(const stage of ['recognition','preparation','memory','world','inference','framing','synthesis','delivery','no_audio'])test(`actual ${stage} failure retains closed origin through concurrent producer/consumer`,async()=>{
 const f=await fixture({stage});try{await f.commit(await f.input(1600));const want=stage==='no_audio'?'synthesis':stage;assert.equal(f.terminal().state,'failed');assert.equal(f.terminal().error.code,'audio_turn_failed');assert.equal(f.terminal().failureOrigin.stage,want);assert.equal(f.diagnostics.length,1);assert.equal(f.diagnostics[0].stage,want);assert.equal(JSON.stringify(f.diagnostics).includes('PRIVATE'),false);if(stage==='no_audio')assert.equal(f.terminal().failureOrigin.code,'no_audio');}finally{f.close();}
});
for(const mode of ['interrupt','disconnect','scope'])test(`${mode} during pending recognition retires late transcript and model work`,async()=>{
 const f=await fixture({recognitionHold:true});try{const pending=f.commit(await f.input(45*16000));await until(()=>f.observed.calls===1);if(mode==='interrupt')await f.interrupt();else if(mode==='scope')f.revoke();else f.close();await pending;assert.equal(f.observed.inference,0);assert.equal(f.events.some(e=>e.type==='transcript'),false);assert.equal(f.diagnostics.length,1);assert.deepEqual(f.diagnostics[0].stage,mode==='scope'?'admission':'transport');assert.equal(f.diagnostics[0].code,mode==='scope'?'scope_changed':mode==='interrupt'?'cancelled':'disconnected');}finally{f.close();}
});
test('actual Nemo adapter preserves 90s and final residual in ordered 100ms messages',async()=>{
 let socket;const binary=[];const provider=new NemoSpeechProvider({baseUrl:'http://synthetic.invalid',webSocketFactory(){socket={onopen:null,onmessage:null,onerror:null,onclose:null,close(){},send(data){if(typeof data!=='string'){binary.push(Buffer.from(data));return;}if(JSON.parse(data).type==='input_audio_buffer.commit')queueMicrotask(()=>socket.onmessage?.({data:JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:'Synthetic complete recognition'})}));}};queueMicrotask(()=>socket.onopen?.());return socket;}});
 const input=frames(1440000),audioInputId=randomUUID();async function* audio(){for(const frame of input)yield {type:'frame',audioInputId,frame};yield {type:'end',audioInputId,nextSequence:input.length,sampleCount:1440000};}
 const events=[];for await(const e of provider.transcribe({deadlineAt:new Date(Date.now()+5000).toISOString(),now:()=>new Date().toISOString()},audio()))events.push(e);const pcm=Buffer.concat(binary);assert.equal(pcm.length,2880000);assert.equal(binary.length,900);assert.equal(pcm.readInt16LE(0),1);assert.equal(pcm.readInt16LE(pcm.length-2),900);assert.equal(events.at(-1).outcome,'succeeded');
});

test('exact 6000-frame bound commits once without dropping input',async()=>{
 const f=await fixture();try{const input=await f.input(6000,1);assert.equal(f.observed.calls,0);await f.commit(input);assert.equal(f.observed.frames,6000);assert.equal(f.observed.samples,6000);assert.equal(f.terminal().state,'completed');}finally{f.close();}
});
test('settlement callback failure is content-free and cannot strand controller ownership',async()=>{
 const f=await fixture({stage:'settlement'});try{await f.commit(await f.input(1600));const trace=f.events.find(e=>e.type==='turnStarted').interactionTraceId;const receivedSamples=f.events.filter(e=>e.type==='audio').reduce((n,e)=>n+e.chunk.frame.sampleCount,0);await f.session.message(JSON.stringify({type:'playbackSettled',interactionTraceId:trace,outcome:'completed',receivedSamples}));await until(()=>f.diagnostics.length===1);assert.equal(f.diagnostics[0].stage,'settlement');assert.equal(JSON.stringify(f.diagnostics).includes('PRIVATE'),false);assert.equal(f.session.controller,undefined);assert.equal(f.events.filter(e=>e.event?.payload.type==='terminal').length,1);}finally{f.close();}
});
for(const kind of ['generation','synthesis'])test(`Stop during concurrent ${kind} preserves cancellation and clears output`,async()=>{
 const f=await fixture({generationHold:kind==='generation',ttsHold:kind==='synthesis'});try{const pending=f.commit(await f.input(31*16000));await until(()=>f.observed.tts===1);await f.interrupt();await pending;assert.equal(f.terminal().state,'interrupted');assert.deepEqual(f.terminal().failureOrigin,{stage:'transport',code:'cancelled'});assert.equal(f.diagnostics.length,1);}finally{f.close();}
});
