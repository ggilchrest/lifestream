import {randomUUID} from 'node:crypto';
import {buildCanonicalPrompt} from '@lifestream/runtime/inference/prompt';
import type {InferenceProvider} from '@lifestream/runtime/inference';
import type {HostRuntimeInput} from '../runtime/inference.ts';
import type {TelegramConversation} from './telegram-runtime.ts';

/** Uses the same canonical prompt and selected inference port as local text.
 * Host preparation is principal-scoped. Only accepted output enters dialogue;
 * generating a reply cannot execute tools or create delivery authority. */
export function telegramConversation(options:{provider:()=>InferenceProvider|undefined;prepare:(...args:Parameters<TelegramConversation>)=>{sessionId:string;input:HostRuntimeInput}|undefined}):TelegramConversation{
 return async(binding,message,signal)=>{
  const provider=options.provider(),prepared=options.prepare(binding,message,signal);if(!provider||!prepared||signal.aborted||!prepared.input.isCurrent())return;
  const {input,sessionId}=prepared,interactionId=randomUUID(),current=()=>{try{return !signal.aborted&&input.isCurrent()&&options.provider()===provider;}catch{return false;}};
  // The channel never accepts remote prompt sections, world context or tools.
  const request=buildCanonicalPrompt({assistantId:binding.assistantId,sessionId,interactionId,endpointId:input.endpointId??null,userInput:message.text,deadlineAt:new Date(Date.now()+30_000).toISOString(),maximumOutputTokens:768,conversation:input.conversation?.read()??'[]',runtimeSelfContext:input.runtimeSelfContext,...(input.profileProjection?{profileProjection:input.profileProjection}:{}),...(input.preparedRelationshipContext?{preparedRelationshipContext:input.preparedRelationshipContext}:{})});
  if(!current())return;input.conversation?.remember({interactionId,role:'user',text:message.text});
  const controller=new AbortController(),generationSignal=AbortSignal.any([signal,controller.signal]);
  const guard=setInterval(()=>{if(!current())controller.abort('Prepared channel context changed');},100);guard.unref();
  let answer='',done=false,cancel=()=>{};
  try{
   const generate=async()=>{for await(const chunk of provider.generate(request,{signal:generationSignal})){
    if(generationSignal.aborted||!current())return;
    if(chunk.kind==='text'){answer+=chunk.text??'';if(answer.length>4096)return;}
    else if(chunk.kind==='done'){done=true;break;}
    else if(chunk.kind==='error'||chunk.kind==='capabilityRequest')return;
   }};
   await Promise.race([generate(),new Promise<void>(resolve=>{cancel=resolve;generationSignal.addEventListener('abort',cancel,{once:true});if(generationSignal.aborted)cancel();})]);
  }finally{clearInterval(guard);generationSignal.removeEventListener('abort',cancel);controller.abort();}

  if(!done||!answer.trim()||!current())return;
  return {text:answer,current,accepted:()=>{if(current()){input.conversation?.remember({interactionId,role:'assistant',text:answer,observation:'emitted'});input.onCompleted?.(interactionId);}}};
 };
}
