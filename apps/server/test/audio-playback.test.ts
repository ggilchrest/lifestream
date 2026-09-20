import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {AudioSession,VOICE_TURN_DEADLINE_MS} from '../src/runtime/audio.ts';
import {SessionHandoffService} from '@lifestream/runtime/endpoints/handoff';

async function fixture(){
 const sessionId=randomUUID(),endpointId=randomUUID(),audioInputId=randomUUID(),events:any[]=[],owners=new SessionHandoffService();let calls=0;
 const socket={readyState:1,send:(raw:string)=>events.push(JSON.parse(raw)),close(){this.readyState=3;}};
 const deps:any={stt:{async *transcribe(){calls++;yield {kind:'data',payload:{type:'committed',text:'Synthetic input.'}};yield {kind:'terminal',outcome:'succeeded'};}},inference:{async *generate(){yield {kind:'text',text:'Synthetic response.'};}},tts:{async *synthesize(request:any){yield {kind:'data',segmentId:request.segmentId,frame:{frameId:randomUUID(),sequence:0,format:request.format,sampleOffset:0,sampleCount:4800,dataBase64:Buffer.alloc(9600).toString('base64')}};yield {kind:'terminal',outcome:'succeeded'};}},outputLease:(endpoint:string,deadline:string)=>{const lease=owners.acquire(sessionId,endpoint,randomUUID(),deadline);return {current:()=>owners.owns(lease),release:()=>owners.release(lease)};}};
 const session=new AudioSession(socket,deps,sessionId),send=(value:unknown)=>session.message(JSON.stringify(value));
 await send({type:'start',request:{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),sessionId,endpointId,audioInputId,expectedSessionRevision:1,format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1}}});
 const turn=async()=>{await send({type:'frame',audioInputId,frame:{frameId:randomUUID(),sequence:0,format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1},sampleOffset:0,sampleCount:10,dataBase64:Buffer.alloc(20).toString('base64')}});await send({type:'commitTurn',audioInputId,nextSequence:1,sampleCount:10});};
 return {session,sessionId,endpointId,events,owners,send,turn,socket,deps,calls:()=>calls,trace:()=>events.findLast(e=>e.type==='turnStarted').interactionTraceId};
}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('ordinary synthesis completion retains audio ownership until its endpoint playback settles',async()=>{
 const f=await fixture();await f.turn();assert.equal(f.events.at(-1).event.payload.state,'completed');
 assert.ok(f.owners.currentLease(f.sessionId),'queued endpoint PCM must keep the lease');assert.equal(f.session.outputAvailable,false);
 await f.send({type:'playbackSettled',interactionTraceId:f.trace(),outcome:'completed',receivedSamples:4800});await tick();assert.equal(f.owners.currentLease(f.sessionId),undefined);assert.equal(f.session.outputAvailable,true);f.session.close();
});

test('foreign, malformed, early, wrong-count and duplicate reports cannot release a successor',async()=>{
 const f=await fixture();let complete:()=>void=()=>{},entered:()=>void=()=>{};const started=new Promise<void>(r=>{entered=r;});
 f.deps.tts.synthesize=async function*(request:any){yield {kind:'data',segmentId:request.segmentId,frame:{frameId:randomUUID(),sequence:0,format:request.format,sampleOffset:0,sampleCount:4800,dataBase64:Buffer.alloc(9600).toString('base64')}};entered();await new Promise<void>(r=>{complete=r;});yield {kind:'terminal',outcome:'succeeded'};};
 const running=f.turn();await started;await tick();const trace=f.trace();
 await f.send({type:'playbackSettled',interactionTraceId:trace,outcome:'completed',receivedSamples:4800});assert.ok(f.owners.currentLease(f.sessionId));complete();await running;
 for(const mutation of [{interactionTraceId:randomUUID()},{receivedSamples:4799},{receivedSamples:4801},{receivedSamples:'4800'},{receivedSamples:-1},{outcome:['completed']},{extra:'untrusted'}]){await f.send({type:'playbackSettled',interactionTraceId:trace,outcome:'completed',receivedSamples:4800,...mutation});await tick();assert.ok(f.owners.currentLease(f.sessionId));}
 await f.send({type:'playbackSettled',interactionTraceId:trace,outcome:'completed',receivedSamples:4800});await tick();const next=f.owners.acquire(f.sessionId,f.endpointId,randomUUID(),new Date(Date.now()+30000).toISOString());
 await f.send({type:'playbackSettled',interactionTraceId:trace,outcome:'completed',receivedSamples:4800});assert.equal(f.owners.owns(next),true);f.owners.release(next);f.session.close();
});

test('interrupt requests and queued commits wait for local stop confirmation before successor recognition',async()=>{
 const f=await fixture();await f.turn();const trace=f.trace();
 await f.send({type:'interrupt',interactionTraceId:trace,reason:'Human stop'});await tick();assert.ok(f.owners.currentLease(f.sessionId));
 await f.send({type:'playbackSettled',interactionTraceId:trace,outcome:'completed',receivedSamples:4800});assert.ok(f.owners.currentLease(f.sessionId),'completion after cancellation is not a stop acknowledgment');
 const next=f.turn();await tick();assert.equal(f.calls(),1);assert.equal(f.session.outputAvailable,false);
 await f.send({type:'playbackSettled',interactionTraceId:trace,outcome:'stopped',receivedSamples:4800});await next;assert.equal(f.calls(),2);assert.notEqual(f.trace(),trace);assert.ok(f.owners.currentLease(f.sessionId));
 await f.send({type:'playbackSettled',interactionTraceId:trace,outcome:'stopped',receivedSamples:4800});assert.ok(f.owners.currentLease(f.sessionId));
 await f.send({type:'playbackSettled',interactionTraceId:f.trace(),outcome:'completed',receivedSamples:4800});await tick();assert.equal(f.session.outputAvailable,true);f.session.close();
});

test('missing reports and disconnect keep the lease until its bounded expiry',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const disconnect of [false,true]){const f=await fixture();await f.turn();if(disconnect)f.session.close();assert.ok(f.owners.currentLease(f.sessionId));t.mock.timers.tick(VOICE_TURN_DEADLINE_MS);await tick();assert.equal(f.owners.currentLease(f.sessionId),undefined);assert.equal(f.session.outputAvailable,!disconnect);f.session.close();}
});

test('confirmed local stop still waits for an in-flight provider to settle',async()=>{
 const f=await fixture();let complete:()=>void=()=>{},entered:()=>void=()=>{};const started=new Promise<void>(r=>{entered=r;});
 f.deps.tts.synthesize=async function*(request:any){yield {kind:'data',segmentId:request.segmentId,frame:{frameId:randomUUID(),sequence:0,format:request.format,sampleOffset:0,sampleCount:4800,dataBase64:Buffer.alloc(9600).toString('base64')}};entered();await new Promise<void>(r=>{complete=r;});yield {kind:'terminal',outcome:'succeeded'};};
 const running=f.turn();await started;await tick();await f.send({type:'interrupt',interactionTraceId:f.trace(),reason:'Stop'});await f.send({type:'playbackSettled',interactionTraceId:f.trace(),outcome:'stopped',receivedSamples:4800});await running;
 assert.ok(f.owners.currentLease(f.sessionId));assert.equal(f.session.outputAvailable,false);complete();await tick();assert.equal(f.owners.currentLease(f.sessionId),undefined);assert.equal(f.session.outputAvailable,true);f.session.close();
});
