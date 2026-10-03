import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import {SglangInferenceProvider,type OwnedGameVisionRequest} from '../src/provider.ts';
import {buildCanonicalPrompt} from '../../runtime/src/inference/prompt.ts';

function png(){const chunk=(type:string,data:Buffer)=>{const head=Buffer.alloc(8),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);head.write(type,4);tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4),data])));return Buffer.concat([head,data,tail]);},head=Buffer.alloc(13);head.writeUInt32BE(1,0);head.writeUInt32BE(1,4);head[8]=8;head[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0]))),chunk('IEND',Buffer.alloc(0))]);}
function request():OwnedGameVisionRequest{const bytes=png();return {purpose:'simulatedGame/gameFramebuffer',png:bytes,sha256:createHash('sha256').update(bytes).digest('hex'),width:1,height:1,deadlineAt:new Date(Date.now()+3000).toISOString(),maximumOutputTokens:128,current:()=>true};}
const provider=()=>new SglangInferenceProvider({endpoint:'http://127.0.0.1:1',model:'fixture',protocol:'llama.cpp'});
const event=(text:string)=>'data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n';

test('game pixels use an explicit game-only schema and cannot enter canonical text inference',async t=>{
 let received:RequestInit|undefined;t.mock.method(globalThis,'fetch',async(_url,init)=>{received=init as RequestInit;return new Response('data: [DONE]\n\n');});
 const p=provider();for await(const _chunk of p.generateGameFrame(request(),{signal:new AbortController().signal})){}
 const body=JSON.parse(received!.body as string);assert.equal(received!.redirect,'error');assert.equal(body.response_format.json_schema.name,'game_frame_v1');assert.equal(body.response_format.json_schema.schema.additionalProperties,false);assert.equal(body.messages[1].content.length,1);assert.ok(body.messages[1].content[0].image_url.url.startsWith('data:image/png;base64,'));assert.equal(body.messages[0].content.includes('human count'),false);
 received=undefined;const canonical=buildCanonicalPrompt({assistantId:'fixture',sessionId:'fixture',interactionId:'fixture',userInput:'Synthetic text fixture.'});for await(const _chunk of p.generate(canonical,{signal:new AbortController().signal})){}
 assert.equal(typeof JSON.parse(received!.body as string).messages[1].content,'string');
});
test('missing frame, unsupported purpose, stale deadline, mismatched pixels and configured remote endpoint refuse without fetch',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('data: [DONE]\n\n');});
 for(const mode of ['missing','purpose','stale','digest','width','withdrawn','remote']){
  const original=request(),input={...original};if(mode==='missing')input.png=Buffer.alloc(0);if(mode==='purpose')(input as {purpose:string}).purpose='camera';if(mode==='stale')input.deadlineAt=new Date(0).toISOString();if(mode==='digest')input.sha256='a'.repeat(64);if(mode==='width')input.width=2;if(mode==='withdrawn')input.current=()=>false;
  const p=mode==='remote'?new SglangInferenceProvider({endpoint:'https://example.com',model:'fixture',protocol:'llama.cpp'}):provider();const chunks=[];for await(const chunk of p.generateGameFrame(input,{signal:new AbortController().signal}))chunks.push(chunk);assert.equal(chunks[0]?.error?.code,'invalid_game_frame',mode);
 }assert.equal(calls,0);
});
test('image cancellation fences buffered data and keeps slow cleanup owned by the same provider pool',async t=>{
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(event('first')+event('must be fenced')+'data: [DONE]\n\n'));},cancel(){return held;}});
 t.mock.method(globalThis,'fetch',async()=>new Response(stream));const p=provider(),abort=new AbortController(),iterator=p.generateGameFrame(request(),{signal:abort.signal})[Symbol.asyncIterator]();assert.equal((await iterator.next()).value?.kind,'text');
 abort.abort('foreground');assert.equal((await iterator.next()).value?.error?.code,'cancelled');assert.equal((await iterator.next()).done,true);assert.equal(p.pendingTransportCleanupCount,1);
 release();await p.drainTransportCleanups();assert.equal(p.pendingTransportCleanupCount,0);
});
