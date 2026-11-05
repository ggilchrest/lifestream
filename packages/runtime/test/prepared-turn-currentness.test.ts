import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPreparedTurnBinding,finalizePreparedTurn,requestForFinalizedTurn,type PromptInput} from '../src/inference/prompt.ts';

function fixture(deadline:number,selfExpiry?:number,identity:string=randomUUID()){
 const scope={assistantId:randomUUID(),principalId:randomUUID(),relationshipId:null,conversationId:randomUUID(),sessionId:randomUUID(),endpointId:randomUUID()};
 const binding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),scope,conversation:'[]',sourceRevisions:{runtime:'synthetic:1'}});
 const input:PromptInput={assistantId:scope.assistantId,sessionId:scope.sessionId,endpointId:scope.endpointId,interactionId:identity,conversation:'[]',userInput:'PRIVATE_PROMPT_SENTINEL',preparedTurnBinding:binding,deadlineAt:new Date(deadline).toISOString(),runtimeSelfContext:{sourceRevision:'synthetic:1',runtimeStatus:'ready',inputModalities:{text:'active',microphone:'inactive',visual:'notConfigured'},outputModalities:{text:'active',speechGeneration:'unavailable',speechDelivery:'notObserved',presentation:'notConfigured'},endpointScope:'sessionEndpoint',audienceScope:'authenticatedSession',permissionState:'authenticatedSession',limitations:[],...(selfExpiry===undefined?{}:{expiresAt:new Date(selfExpiry).toISOString()})}};
 return {binding,input};
}
for(const mode of ['wall','monotonic','self','after-source']as const)test('original prepared-turn '+mode+' expiry retains its exact boundary and immutable timestamps',t=>{
 let wall=Date.now(),mono=100,armed=false,calls=0;const began=wall,logs:Record<string,unknown>[]=[];
 t.mock.method(Date,'now',()=>wall);t.mock.method(performance,'now',()=>mono);
 const old=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS='1';t.after(()=>{if(old===undefined)delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;else process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS=old;});
 t.mock.method(console,'info',(value:string)=>logs.push(JSON.parse(value)));
 const f=fixture(began+100,mode==='self'?began+50:undefined),turn=finalizePreparedTurn(f.input,()=>{calls++;if(armed&&mode==='after-source')wall=began+100;return true;});
 const originalCalls=calls;armed=true;if(mode==='wall')wall=began+100;if(mode==='self')wall=began+50;if(mode==='monotonic')mono=200;
 assert.throws(()=>requestForFinalizedTurn(turn,f.binding,()=>assert.fail('expired entry cannot call host')));
 assert.equal(logs.length,1);const value=logs[0]!;assert.equal(value.event,'prepared-turn-currentness-refusal');assert.equal(value.stage,mode==='after-source'?'after-source':'before-source');assert.equal(value.predicate,mode==='monotonic'?'monotonic_deadline':'wall_deadline');
 assert.equal(value.effectiveExpiresAtMs,mode==='self'?began+50:began+100);assert.equal(value.requestExpiresAtMs,began+100);assert.equal(value.selfExpiresAtMs,mode==='self'?began+50:null);
 assert.equal(calls-originalCalls,mode==='after-source'?1:0);assert.doesNotMatch(JSON.stringify(logs),/PRIVATE|synthetic:1|assistantId|principalId/);
 wall=began;mono=100;assert.throws(()=>requestForFinalizedTurn(turn,f.binding,()=>true));assert.equal(logs.length,1,'restoring clocks cannot revive the retired original entry');
});
for(const mode of ['disabled','enabled','throwing','legacy']as const)test('prepared-turn source refusal is unchanged with '+mode+' diagnostics',t=>{
 const old=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;if(mode==='disabled')delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;else process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS='1';t.after(()=>{if(old===undefined)delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;else process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS=old;});
 const logs:Record<string,unknown>[]=[];t.mock.method(console,'info',(value:string)=>{logs.push(JSON.parse(value));if(mode==='throwing')throw Error('PRIVATE_REPORTER');});
 let allowed=true,calls=0;const f=fixture(Date.now()+30000,undefined,mode==='legacy'?'PRIVATE_ID_SENTINEL':randomUUID()),turn=finalizePreparedTurn(f.input,()=>{calls++;return allowed;});
 const initialCalls=calls;allowed=false;assert.throws(()=>requestForFinalizedTurn(turn,f.binding,()=>assert.fail('source denial must precede host')));assert.equal(calls,initialCalls+1);
 assert.equal(logs.length,mode==='disabled'||mode==='legacy'?0:1);if(logs[0])assert.deepEqual([logs[0].stage,logs[0].predicate],['source','source_unavailable']);assert.doesNotMatch(JSON.stringify(logs),/PRIVATE/);
 allowed=true;assert.throws(()=>requestForFinalizedTurn(turn,f.binding,()=>true));assert.equal(calls,initialCalls+1);
});
