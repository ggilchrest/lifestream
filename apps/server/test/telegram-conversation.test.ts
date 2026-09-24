import test from 'node:test';
import assert from 'node:assert/strict';
import {FixtureInferenceProvider} from '@lifestream/runtime/inference/fixture';
import type {InferenceProvider,InferenceRequest} from '@lifestream/runtime/inference';
import type {TelegramBinding} from '@lifestream/storage-sqlite';
import type {HostRuntimeInput} from '../src/runtime/inference.ts';
import {telegramConversation} from '../src/channels/telegram-conversation.ts';
const binding:TelegramBinding={subscriptionId:'destination',assistantId:'assistant',principalId:'person',botId:'9999',chatId:'1234',userId:'1234',revision:1,subscriptionRevision:1,activatedAt:Date.now(),conversationsEnabled:true,alertsEnabled:false};
const message={updateId:1,messageId:2,chatId:'1234',userId:'1234',sentAt:Date.now(),text:'Synthetic question'};
const input=():HostRuntimeInput=>({assistantId:'assistant',isCurrent:()=>true,runtimeSelfContext:{sourceRevision:'synthetic',runtimeStatus:'ready',inputModalities:{text:'active',microphone:'unavailable',visual:'notConfigured'},outputModalities:{text:'active',speechGeneration:'unavailable',speechDelivery:'unavailable',presentation:'notConfigured'},endpointScope:'sessionEndpoint',audienceScope:'unknown',permissionState:'authenticatedSession',limitations:['Chat identity is not physical audience evidence.']}});
test('canonical channel inference preserves prepared principal context and only accepted replies enter history',async()=>{
 const provider=new FixtureInferenceProvider(),turns:{role:string;text:string}[]=[],prepared=input();prepared.conversation={read:()=>JSON.stringify(turns),remember:t=>turns.push(t)};let request!:InferenceRequest;
 const tracing:InferenceProvider={tokenize:provider.tokenize.bind(provider),generate:(r,c)=>{request=r;return provider.generate(r,c);}};
 const converse=telegramConversation({provider:()=>tracing,prepare:()=>({sessionId:'synthetic',input:prepared})}),reply=await converse(binding,message,new AbortController().signal);
 assert.match(reply!.text,/Fixture response: Synthetic question/);assert.equal(request.scope.assistantId,binding.assistantId);assert.equal(request.sections.find(s=>s.kind==='preparedMemory')?.content.includes('another person'),false);assert.equal(turns.length,1);reply!.accepted!();assert.equal(turns.length,2);assert.equal(turns[1]!.role,'assistant');
});
test('context revocation, missing terminal, overflow and tool requests never emit a chat reply',async()=>{
 for(const mode of ['revoke','unterminated','overflow','tool']){let current=true;const prepared=input();prepared.isCurrent=()=>current;const provider:InferenceProvider={tokenize:async()=>({count:1,identity:'synthetic'}),async *generate(){if(mode==='revoke')current=false;if(mode==='tool'){yield {kind:'capabilityRequest' as const,capability:{name:'synthetic',input:{}}};return;}yield {kind:'text' as const,text:mode==='overflow'?'x'.repeat(4097):'synthetic'};if(mode!=='unterminated')yield {kind:'done' as const};}};const converse=telegramConversation({provider:()=>provider,prepare:()=>({sessionId:'synthetic',input:prepared})});assert.equal(await converse(binding,message,new AbortController().signal),undefined,mode);}
});
