import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {AudioSession} from "../src/runtime/audio.ts";
const line=(value:unknown)=>JSON.stringify(value)+"\n";
const header=line({version:"voice-response/1"});
const speech=(text:string)=>line({channel:"speech",text});
const display=(text:string)=>line({channel:"display",text});
function harness(generate:any){
 const events:any[]=[],spoken:string[]=[],history:any[]=[],remembered:any[]=[];
 const sessionId=randomUUID(),endpointId=randomUUID(),audioInputId=randomUUID();
 let started!:()=>void;const firstSpeech=new Promise<void>(resolve=>started=resolve);
 const frame={frameId:randomUUID(),sequence:0,format:{encoding:"pcm_s16le",sampleRateHz:16000,channels:1},sampleOffset:0,sampleCount:4800,dataBase64:Buffer.alloc(9600,1).toString('base64')};
 const deps:any={stt:{async *transcribe(){yield {kind:'data',payload:{type:'committed',text:'Show a table.'}};yield {kind:'terminal',outcome:'succeeded'};}},inference:{generate:(...args:any[])=>generate(firstSpeech,...args)},tts:{async *synthesize(request:any){spoken.push(request.text);started();yield {kind:'data',segmentId:request.segmentId,frame:{...frame,format:request.format,sampleCount:2,dataBase64:'AAABAA=='}};yield {kind:'terminal',outcome:'succeeded'};}},prepare:()=>({assistantId:randomUUID(),endpointId,isCurrent:()=>true,conversation:{read:()=>'',remember:(v:any)=>remembered.push(v),observe:(v:any)=>history.push(v)},runtimeSelfContext:{sourceRevision:'fixture',runtimeStatus:'ready',inputModalities:{text:'active',microphone:'activeForSession',visual:'notConfigured'},outputModalities:{text:'active',speechGeneration:'healthy',speechDelivery:'notObserved',presentation:'notConfigured'},endpointScope:'sessionEndpoint',audienceScope:'authenticatedSession',permissionState:'authenticatedSession',limitations:['Synthetic test.']}})};
 const session=new AudioSession({readyState:1,send:raw=>events.push(JSON.parse(raw)),close(){}},deps,sessionId);
 const run=async()=>{await session.message(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,expectedSessionRevision:0,endpointId,audioInputId,format:frame.format}}));await session.message(JSON.stringify({type:'frame',audioInputId,frame}));await session.message(JSON.stringify({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:4800}));};
 return {session,events,spoken,history,remembered,run,firstSpeech};
}
test('speech starts before display generation completes; transcript contains shared prose and table once',async t=>{
 const table='| Year | High |\n|---|---|\n| 2025 | -12.50 °C |';
 const f=harness(async function*(first:Promise<void>,request:any){assert.equal(request.sections[0].sourceRef,'policy:spoken-v1');assert.match(request.sections[0].content,/voice-response\/1/);yield {kind:'text',text:header+speech('The estimate is ~5 degrees.')};await first;yield {kind:'text',text:display(table)};yield {kind:'done'};});t.after(()=>f.session.close());
 await f.run();assert.deepEqual(f.spoken,['The estimate is approximately 5 degrees.']);
 const text=f.events.filter(e=>e.event?.payload.type==='textDelta').map(e=>e.event.payload.text).join('');assert.equal(text,'The estimate is ~5 degrees.\n\n'+table);assert.doesNotMatch(text,/voice-response|"channel"/);
 assert.equal(f.remembered.filter(e=>e.role==='assistant').at(-1).text,text);assert.equal(f.history.filter(e=>e.role==='assistant').at(-1).state,'completed');
});
test('malformed EOF and speech after display fail without table or protocol audio',async t=>{
 for(const tail of ['{"channel":"display","text":"unfinished',display('| A | B |')+speech('Forbidden late speech.')]){
  const f=harness(async function*(){yield {kind:'text',text:header+speech('Opening.')};yield {kind:'text',text:tail};yield {kind:'done'};});t.after(()=>f.session.close());await f.run();
  assert.ok(f.spoken.every(s=>s==='Opening.'));assert.equal(f.events.at(-1).event.payload.state,'failed');assert.equal(f.history.filter(e=>e.role==='assistant').at(-1).state,'failed');
 }
});
test('unframed provider response never becomes speech or canonical text',async t=>{
 const f=harness(async function*(){yield {kind:'text',text:'Raw unframed answer.'};yield {kind:'done'};});t.after(()=>f.session.close());await f.run();assert.deepEqual(f.spoken,[]);assert.equal(f.events.some(e=>e.event?.payload.type==='textDelta'),false);assert.equal(f.events.at(-1).event.payload.state,'failed');
});
test('Stop fences late display and clears the pending speech path',async t=>{
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>entered=r);
 const f=harness(async function*(first:Promise<void>){yield {kind:'text',text:header+speech('Opening.')};await first;entered();await gate;yield {kind:'text',text:display('PRIVATE_LATE_TABLE')};yield {kind:'done'};});t.after(()=>{release();f.session.close();});
 const running=f.run();await waiting;const trace=f.events.find(e=>e.type==='turnStarted').interactionTraceId;
 await f.session.message(JSON.stringify({type:'interrupt',interactionTraceId:trace,reason:'stop'}));release();await running;
 assert.doesNotMatch(JSON.stringify(f.events),/PRIVATE_LATE_TABLE/);assert.equal(f.events.at(-1).event.payload.state,'interrupted');assert.equal(f.history.filter(e=>e.role==='assistant').at(-1).state,'interrupted');
});
