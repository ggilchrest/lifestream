import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {isGameFrameVisionWitness,gameFrameRefusalReasons,gameFrameInterpreterRefusalReasons} from '../src/game-frame-diagnostics.ts';
const base=()=>({kind:'provider',reason:'response_finish',observationId:randomUUID(),screenshotSha256:'a'.repeat(64),httpStatus:200,finishReason:'length',inputTokens:8192,outputTokens:192,requestSha256:'b'.repeat(64),responseSha256:'c'.repeat(64)});
test('standalone closed witness contract accepts only bounded refusal metadata for each producer stage',()=>{
 for(const reason of gameFrameRefusalReasons)assert(isGameFrameVisionWitness({...base(),reason}));
 for(const reason of gameFrameInterpreterRefusalReasons)assert(isGameFrameVisionWitness({kind:'interpreter',reason,observationId:randomUUID(),screenshotSha256:'a'.repeat(64)}));
 assert(isGameFrameVisionWitness({kind:'interpreter',reason:'scheduler_not_published',schedulerState:'cancelled',observationId:randomUUID(),screenshotSha256:'a'.repeat(64)}));
 assert(Buffer.byteLength(JSON.stringify({schemaVersion:'ct-runtime-first-cause/1',source:'game-vision',phase:'interpretation',reason:'interpretation_refused',visionWitness:base()}))<1024);
});
test('standalone witness validator rejects private text, unknown keys, hostile objects and malformed primitives without invoking getters',()=>{
 for(const patch of [{text:'PRIVATE'},{reason:'PRIVATE'.repeat(100)},{finishReason:'PRIVATE'},{kind:'PRIVATE'},{observationId:'PRIVATE'},{screenshotSha256:'A'.repeat(64)},{requestSha256:'bad'},{responseSha256:'bad'},{inputTokens:1.5},{outputTokens:-1},{outputTokens:1000000001},{httpStatus:600},{httpStatus:99},{schedulerState:'failed'},{finishReason:undefined}])assert.equal(isGameFrameVisionWitness({...base(),...patch}),false);
 const getter=base();Object.defineProperty(getter,'reason',{enumerable:true,get(){assert.fail('Getter invoked');}});assert.equal(isGameFrameVisionWitness(getter),false);
 const proxy=new Proxy(base(),{ownKeys(){assert.fail('Proxy invoked');}});assert.equal(isGameFrameVisionWitness(proxy),false);
 assert.equal(isGameFrameVisionWitness(Object.assign(Object.create({}),base())),false);
 assert.equal(isGameFrameVisionWitness({...base(),[Symbol('PRIVATE')]:true}),false);
 assert.equal(isGameFrameVisionWitness({kind:'interpreter',reason:'decoder_output',schedulerState:'failed',observationId:randomUUID(),screenshotSha256:'a'.repeat(64)}),false);
});
