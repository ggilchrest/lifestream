import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

test('deployed text guards reject synthetic stale preparation before response generation',async t=>{
 const root=process.env.LIFESTREAM_IOS_CURRENT_BACKEND;
 if(!root){t.skip('Set LIFESTREAM_IOS_CURRENT_BACKEND to an isolated copy of the current release.');return;}
 const {streamMessage}=await import(pathToFileURL(join(root,'apps/server/src/runtime/inference.ts')));
 for(const mode of ['memory-preparation','currentness','finalization']){
  let status=0,body='',calls=0;
  const response={destroyed:false,writableEnded:false,writeHead(code){status=code;},write(value){body+=value;return true;},end(value){body+=value??'';this.writableEnded=true;},once(){}};
  const host={assistantId:randomUUID(),runtimeSelfContext:{audienceScope:'authenticatedSession'},isCurrent:()=>mode!=='currentness'};
  if(mode==='memory-preparation')host.prepareMemory=async()=>{throw Error('synthetic private detail');};
  if(mode==='finalization')host.preparedTurnBinding={invalid:true};
  const provider={async *generate(){calls++;yield {kind:'done'};}};
  await streamMessage(response,provider,{assistantId:host.assistantId,userInput:'Synthetic input'},randomUUID(),new AbortController().signal,undefined,host.runtimeSelfContext,host);
  assert.equal(status,409,mode);const result=JSON.parse(body);assert.equal(result.code,'runtime_context_changed');
  assert.equal(result.message,mode==='memory-preparation'?'Current world context is unavailable.':'Current interaction context is unavailable.');
  assert.equal(calls,0,'response generation has not started');assert.ok(!body.includes('synthetic private detail'));
 }
});
