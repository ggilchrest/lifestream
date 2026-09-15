import assert from 'node:assert/strict';
import test from 'node:test';
import {VoiceFrames,ConversationCapture} from '../conversation-capture.js';

test('voice framing requires sustained speech, keeps pre-roll, and commits bounded PCM once silence closes a turn',()=>{
 const messages=[];let begins=0,commits=0;const frames=new VoiceFrames({inputId:'synthetic-input',send:value=>messages.push(value),playing:()=>false,onBegin:()=>begins++,onCommit:()=>commits++});
 for(let i=0;i<30;i++)frames.push(new Float32Array(512).fill(.01),.1);frames.push(new Float32Array(512),.9);frames.push(new Float32Array(512),.1);assert.equal(messages.length,0);assert.equal(begins,0);
 for(let i=0;i<7;i++)frames.push(new Float32Array(512).fill(.1),.9);assert.equal(begins,1);for(let i=0;i<25;i++)frames.push(new Float32Array(512),.1);
 assert.equal(commits,1);const audio=messages.filter(m=>m.type==='frame'),end=messages.at(-1);assert.equal(end.type,'commitTurn');assert.equal(end.nextSequence,audio.length);assert.equal(end.sampleCount,audio.reduce((sum,m)=>sum+m.frame.sampleCount,0));assert.ok(audio[0].frame.sampleCount>512);assert.equal(audio.every(m=>m.frame.sampleCount<=4800&&Buffer.from(m.frame.dataBase64,'base64').length===m.frame.sampleCount*2),true);assert.equal(frames.speaking,false);
});

test('qualified barge-in interrupts before any PCM is transmitted and capture never buffers an unlimited utterance',()=>{
 const order=[];const frames=new VoiceFrames({inputId:'synthetic-input',send:value=>order.push(value),playing:()=>true,onBegin:()=>order.push('interrupt'),onCommit:()=>order.push('commit')});
 for(let i=0;i<4;i++)frames.push(new Float32Array(512),.9);assert.equal(order.length,0);frames.push(new Float32Array(512),.9);assert.equal(order[0],'interrupt');
 for(let i=0;i<620;i++)frames.push(new Float32Array(512),.9);assert.equal(order.filter(x=>x==='commit').length,1);assert.ok(order.find(x=>x.type==='commitTurn').sampleCount<=320512);assert.ok(frames.pending.length<4800);
});

test('late microphone permission after Stop releases the acquired track and cannot start a transport',async t=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'navigator',descriptor);else delete globalThis.navigator;});
 let resolve,stopped=0;Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>new Promise(r=>{resolve=r;})}}});
 const capture=new ConversationCapture({output:{connected:true,close:()=>assert.fail('No transport should start')},current:()=>true,onBegin:()=>{},onState:()=>{},onError:()=>{}});
 const start=capture.start({});capture.stop(false);resolve({getTracks:()=>[{stop:()=>stopped++}]});await assert.rejects(start,/cancelled/);assert.ok(stopped>=1);assert.equal(capture.active,false);
});
