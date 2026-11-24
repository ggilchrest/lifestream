import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {AudioSession, VOICE_TURN_DEADLINE_MS} from '../src/runtime/audio.ts';

function fixture() {
 const events:any[]=[];let enter!:()=>void,release!:()=>void,firstSignal:AbortSignal|undefined,recognitions=0,inferences=0,onCurrent=()=>{};
 const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve);
 const sessionId=randomUUID(),audioInputId=randomUUID();
 const inputFrame=()=>({frameId:randomUUID(),sequence:0,format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1},sampleOffset:0,sampleCount:4800,dataBase64:Buffer.alloc(9600).toString('base64')});
 const session=new AudioSession({readyState:1,send:raw=>events.push(JSON.parse(String(raw))),close(){}},{
  inputCurrent:()=>{onCurrent();return true;},
  stt:{async *transcribe(_request:any,_audio:any,signal:AbortSignal){
   if(++recognitions===1){firstSignal=signal;enter();await gate;yield {kind:'data',payload:{type:'committed',text:'CANCELED_LATE_TRANSCRIPT'}};}
   else yield {kind:'data',payload:{type:'committed',text:'Accepted successor.'}};
   yield {kind:'terminal',outcome:'succeeded'};
  }} as never,
  inference:{async *generate(){inferences++;yield {kind:'text',text:'Synthetic answer.'};yield {kind:'done'};}} as never,
  tts:{async *synthesize(request:any){yield {kind:'data',segmentId:request.segmentId,frame:{frameId:randomUUID(),sequence:0,format:request.format,sampleOffset:0,sampleCount:2,dataBase64:'AAAAAA=='}};yield {kind:'terminal',outcome:'succeeded'};}} as never
 },sessionId);
 const turn=async()=>{await session.message(JSON.stringify({type:'frame',audioInputId,frame:inputFrame()}));await session.message(JSON.stringify({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:4800}));};
 return {session,events,entered,release,turn,signal:()=>firstSignal,inferences:()=>inferences,onCurrent:(callback:()=>void)=>{onCurrent=callback;},
  start:()=>session.message(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,expectedSessionRevision:1,endpointId:randomUUID(),audioInputId,format:inputFrame().format}}))};
}

for(const cause of ['interrupt','successor','deadline'] as const)test(`late recognition after ${cause} cannot publish a canceled transcript; the next turn still works`,async t=>{
 const f=fixture();let pending:Promise<void>|undefined,next:Promise<void>|undefined;
 try{
  await f.start();if(cause==='deadline')t.mock.timers.enable({apis:['setTimeout']});pending=f.turn();await f.entered;
  const trace=f.events.find(e=>e.type==='turnStarted').interactionTraceId;
  if(cause==='interrupt')await f.session.message(JSON.stringify({type:'interrupt',interactionTraceId:trace,reason:'Synthetic Stop response'}));
  else if(cause==='successor'){next=f.turn();await new Promise<void>(resolve=>queueMicrotask(resolve));}
  else{t.mock.timers.tick(VOICE_TURN_DEADLINE_MS+1);t.mock.timers.reset();}
  assert.equal(f.signal()?.aborted,true);
  f.release();await pending;
  assert.equal(f.events.some(e=>e.type==='transcript'&&e.interactionTraceId===trace),false);
  assert.equal(f.events.some(e=>e.type==='audio'&&e.interactionTraceId===trace),false);
  const terminal=f.events.find(e=>e.event?.interactionTraceId===trace&&e.event.payload.type==='terminal').event.payload;
  assert.equal(terminal.state,cause==='deadline'?'failed':'interrupted');
  if(cause==='deadline')assert.equal(terminal.error.code,'audio_deadline_exceeded');
  if(next)await next;else await f.turn();
  assert.deepEqual(f.events.filter(e=>e.type==='transcript').map(e=>e.text),['Accepted successor.']);
  assert.equal(f.inferences(),1);
  assert.equal(f.events.findLast(e=>e.event?.payload.type==='terminal').event.payload.state,'completed');
 }finally{f.release();f.session.close();await pending;await next;}
});

test('recognition currentness callback cannot cancel the turn and then publish its caption',async()=>{
 const f=fixture();let pending:Promise<void>|undefined;
 try{
  await f.start();pending=f.turn();await f.entered;
  const trace=f.events.find(e=>e.type==='turnStarted').interactionTraceId;
  f.onCurrent(()=>{
   f.onCurrent(()=>{});
   assert.equal(f.signal()?.aborted,false);
   void f.session.message(JSON.stringify({type:'interrupt',interactionTraceId:trace,reason:'Synthetic callback Stop'}));
   assert.equal(f.signal()?.aborted,true);
  });
  f.release();await pending;
  assert.equal(f.events.some(e=>e.type==='transcript'&&e.interactionTraceId===trace),false);
  assert.equal(f.inferences(),0);
  assert.equal(f.events.find(e=>e.event?.interactionTraceId===trace&&e.event.payload.type==='terminal').event.payload.state,'interrupted');
  await f.turn();assert.deepEqual(f.events.filter(e=>e.type==='transcript').map(e=>e.text),['Accepted successor.']);
  assert.equal(f.inferences(),1);
 }finally{f.release();f.session.close();await pending;}
});
