import {EventEmitter} from 'node:events';
import {streamMessage} from '../src/runtime/inference.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateConversationTitle} from '../src/runtime/conversation-title.ts';
const base=provider=>({provider,assistantId:'00000000-0000-4000-8000-000000000001',sessionId:'00000000-0000-4000-8000-000000000002',endpointId:null,userText:'How do I repair a bicycle chain?',assistantText:'Check the master link and chain wear.',current:()=>true,signal:new AbortController().signal});
test('title uses bounded original provider request, no tools or unrelated context',async()=>{
 let captured;const provider={async*generate(request){captured=request;yield{kind:'text',text:'Bicycle chain repair'};yield{kind:'done'};}};
 assert.equal(await generateConversationTitle(base(provider)),'Bicycle chain repair');
 assert.equal(captured.maximumOutputTokens,32);assert.ok(Date.parse(captured.deadlineAt)<=Date.now()+3000);
 assert.equal(captured.scope.assistantId,base(provider).assistantId);assert.equal(captured.sections.filter(s=>s.kind==='input')[0]?.content.includes('bicycle')??captured.sections.some(s=>s.content.includes('bicycle')),true);
 assert.equal(captured.responseFormat,undefined);
});
test('late scope loss, provider failure, tools, malformed output and missing terminal never produce titles',async()=>{
 let current=true;const stale={async*generate(){yield{kind:'text',text:'Bicycle chain repair'};current=false;yield{kind:'done'};}};
 assert.equal(await generateConversationTitle({...base(stale),current:()=>current}),null);
 for(const chunks of [[{kind:'capabilityRequest',capability:{name:'unsafe',input:{},effect:'read-only'}}],[{kind:'error'}],[{kind:'text',text:'New chat'},{kind:'done'}],[{kind:'text',text:'Invented\nsecond line'},{kind:'done'}],[{kind:'text',text:'Title without terminal'}]]){
  assert.equal(await generateConversationTitle(base({async*generate(){yield*chunks;}})),null);
 }
});
test('deadline returns promptly even when optional producer ignores cancellation',async()=>{
 const provider={generate(){return{[Symbol.asyncIterator](){return{next:()=>new Promise(()=>{}),return:()=>Promise.resolve({done:true})};}};}};
 const start=Date.now();assert.equal(await generateConversationTitle({...base(provider),deadlineAt:new Date(start+20).toISOString()}),null);assert.ok(Date.now()-start<1000);
});

class Response extends EventEmitter{destroyed=false;writableEnded=false;output='';writeHead(status){this.status=status;}write(value){this.output+=value;return true;}end(){this.writableEnded=true;}}
test('reply iterator closes before metadata starts; metadata failure preserves completed reply',async()=>{
 let closed=false,called=0;const provider={async*generate(){try{yield{kind:'text',text:'Check the chain.'};yield{kind:'done'};}finally{closed=true;}}};
 const response=new Response();
 const host={assistantId:base(provider).assistantId,runtimeSelfContext:{sourceRevision:'test',runtimeStatus:'ready',inputModalities:{text:'active',microphone:'inactive',visual:'notConfigured'},outputModalities:{text:'active',speechGeneration:'unavailable',speechDelivery:'notObserved',presentation:'notConfigured'},endpointScope:'none',audienceScope:'authenticatedSession',permissionState:'unknown',limitations:[]},isCurrent:()=>true,conversation:{read:()=> '[]',remember:()=>{}},onReplyCompleted:async reply=>{called++;assert.equal(closed,true);assert.equal(reply.assistantText,'Check the chain.');throw Error('Optional metadata unavailable');}};
 await streamMessage(response,provider,{assistantId:host.assistantId,userInput:'Repair a bicycle chain'},base(provider).sessionId,new AbortController().signal,undefined,host.runtimeSelfContext,host);
 assert.equal(called,1);assert.match(response.output,/event: interaction.completed/);assert.doesNotMatch(response.output,/event: interaction.error/);
});
test('completion is published before metadata; later privacy loss emits no new payload',async()=>{
 let current=true;const provider={async*generate(){yield{kind:'text',text:'Check the chain.'};yield{kind:'done'};}},response=new Response();
 const host={assistantId:base(provider).assistantId,isCurrent:()=>current,onReplyCompleted:async()=>{assert.match(response.output,/event: interaction.completed/);current=false;}};
 await streamMessage(response,provider,{assistantId:host.assistantId,userInput:'Repair a bicycle chain'},base(provider).sessionId,new AbortController().signal,undefined,undefined,host);
 assert.match(response.output,/event: interaction.completed/);assert.doesNotMatch(response.output,/runtime_input_stale/);assert.equal(response.output.split('event: interaction.completed').length,2);
});

test('prepared input expiry during optional title leaves original completed reply successful',async()=>{
 let fresh=true;const response=new Response(),provider={async*generate(){yield{kind:'text',text:'Reply done before expiry.'};yield{kind:'done'};}};
 const host={assistantId:base(provider).assistantId,isCurrent:()=>fresh,onReplyCompleted:async()=>{fresh=false;throw Error('Prepared context expired during metadata');}};
 await streamMessage(response,provider,{assistantId:host.assistantId,userInput:'Authorized first turn'},base(provider).sessionId,new AbortController().signal,undefined,undefined,host);
 assert.match(response.output,/event: interaction.completed/);assert.doesNotMatch(response.output,/event: interaction.error/);
});
