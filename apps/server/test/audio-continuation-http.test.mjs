// Actual HTTP/WS/Auth/private-session/currentness and host conversation preparation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,wait,settle,auditFixtureRoot,isolatedAudit} from './fixtures/personal-phone-host.mjs';
const held=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const captureWire=c=>{const packets=[];c.socket.on('message',raw=>{const value=JSON.parse(raw);if(['turnStarted','transcript','inputSettled'].includes(value.type))packets.push(raw.toString('utf8'));});return packets;};
const exportWire=(name,packets)=>{if(!process.env.ORDERED_WIRE_EXPORT_DIR)return;mkdirSync(process.env.ORDERED_WIRE_EXPORT_DIR,{recursive:true,mode:0o700});writeFileSync(join(process.env.ORDERED_WIRE_EXPORT_DIR,name),packets.join('\n')+'\n',{mode:0o600});};
const prefix='Earlier I was researching the Voynich Manuscript.';
const tail='What do you think?';
test('real personal-phone HTTP/WS owners preserve pending ASR across continuation and actual host context preparation',async()=>{
 const f=await fixture({endpointClass:'personalCompanion'}),gate=held(),requests=[];let c,calls=0;
 try{
  const retention=await f.request('/api/runtime/v1/conversation-retention',{assistantId:f.assistantId,schemaVersion:'1.0.0',operation:'set',expectedRevision:0,enabled:true,retention:'untilDeletion',bodyScope:'textAndTranscripts'});assert.equal(retention.status,200,await retention.clone().text());
  f.app.providers.stt={async*transcribe(_request,audio){const index=calls++;for await(const _ of audio){}if(index===0)await gate.promise;yield {kind:'data',payload:{type:'committed',text:index===0?prefix:tail}};yield {kind:'terminal',outcome:'succeeded'};}};
  f.app.providers.inference={async*generate(request){requests.push(request);yield {kind:'text',text:JSON.stringify({version:'voice-response/1'})+'\n'+JSON.stringify({channel:'speech',text:'A synthetic combined-context reply.'})+'\n'};yield {kind:'done'};}};
  c=await f.connect(f.owner.contextRef,{continuationMode:'ordered-v1'});await c.start();const wire=captureWire(c);const inputId=c.events.find(e=>e.type==='accepted').audioInputId;assert.equal(c.events.find(e=>e.type==='accepted').inputCapacity,3);
  c.turn();await wait(()=>calls===1);c.socket.send(JSON.stringify({type:'continueInput',audioInputId:inputId,afterCommitSequence:1}));c.turn();await wait(()=>c.events.filter(e=>e.type==='inputQueued').length===2);gate.resolve();await wait(()=>c.events.filter(e=>e.type==='inputSettled').length===2);
  const finals=c.events.filter(e=>e.type==='transcript');assert.deepEqual(finals.map(e=>[e.inputSequence,e.text]),[[1,prefix],[2,tail]]);
  assert.ok(requests.some(request=>JSON.stringify(request).includes('Voynich')&&JSON.stringify(request).includes(tail)),'Actual prepared inference context contains earlier prefix and current tail');
  const users=(await f.page()).filter(e=>e.speaker==='human');assert.deepEqual(users.map(e=>e.content.text),[prefix,tail]);const terminal=c.events.findLast(e=>e.event?.payload.type==='terminal');assert.equal(terminal.event.payload.state,'completed');
  c.socket.send(JSON.stringify({type:'playbackSettled',interactionTraceId:terminal.event.interactionTraceId,outcome:'completed',receivedSamples:c.events.filter(e=>e.type==='audio'&&e.interactionTraceId===terminal.event.interactionTraceId).reduce((n,e)=>n+e.chunk.frame.sampleCount,0)}));await settle();exportWire('candidate-server-success.jsonl',wire);
 }finally{gate.resolve();await f.close();}
});
test('real sign-out during pending ordered recognition prevents transcript/context admission',async()=>{
 const f=await fixture({endpointClass:'personalCompanion'}),gate=held();let called=false,c;
 try{f.app.providers.stt={async*transcribe(){called=true;await gate.promise;yield {kind:'data',payload:{type:'committed',text:prefix}};yield {kind:'terminal',outcome:'succeeded'};}};
 c=await f.connect(f.owner.contextRef,{continuationMode:'ordered-v1'});await c.start();c.turn();await wait(()=>called);const signedOut=await f.request('/api/auth/v1/sign-out',{});assert.equal(signedOut.status,200);gate.resolve();await settle();assert.equal(c.events.some(e=>e.type==='transcript'),false);assert.equal(f.calls.inference,0);assert.equal(f.rows().length,0);
 }finally{gate.resolve();await f.close();}
});
test('actual queued empty first ASR settles false before successful second transcript',async()=>{
 const f=await fixture({endpointClass:'personalCompanion'}),gate=held();let calls=0,c;
 try{f.app.providers.stt={async*transcribe(_request,audio){const index=calls++;for await(const _ of audio){}if(index===0)await gate.promise;yield {kind:'data',payload:{type:'committed',text:index===0?'':tail}};yield {kind:'terminal',outcome:'succeeded'};}};
 c=await f.connect(f.owner.contextRef,{continuationMode:'ordered-v1'});await c.start();const wire=captureWire(c);c.turn();await wait(()=>calls===1);c.turn();await wait(()=>c.events.filter(e=>e.type==='inputQueued').length===2);gate.resolve();await wait(()=>c.events.filter(e=>e.type==='inputSettled').length===2);const settled=c.events.filter(e=>e.type==='inputSettled');assert.deepEqual(settled.map(e=>[e.inputSequence,e.transcriptCommitted]),[[1,false],[2,true]]);const final=c.events.find(e=>e.type==='transcript');assert.equal(final.inputSequence,2);assert.equal(final.state,'committed');assert.ok(c.events.indexOf(settled[0])<c.events.indexOf(final));const terminal=c.events.findLast(e=>e.event?.payload.type==='terminal');c.socket.send(JSON.stringify({type:'playbackSettled',interactionTraceId:terminal.event.interactionTraceId,outcome:'completed',receivedSamples:c.events.filter(e=>e.type==='audio'&&e.interactionTraceId===terminal.event.interactionTraceId).reduce((n,e)=>n+e.chunk.frame.sampleCount,0)}));await settle();exportWire('candidate-server-gap.jsonl',wire);
 }finally{gate.resolve();await f.close();}
});
test.after(()=>{isolatedAudit.close();rmSync(auditFixtureRoot,{recursive:true,force:true});});
