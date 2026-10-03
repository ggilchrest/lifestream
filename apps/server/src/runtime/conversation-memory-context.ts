import {performance} from 'node:perf_hooks';
import {relationshipControlDefaults,type CompiledRelationshipContext,type SemanticContextReference} from '@lifestream/runtime/context';
import type {AutomaticMemory,MemoryScope} from './automatic-memory.ts';
import type {HostRuntimeInput} from './inference.ts';

/** Trusted composition only. No HTTP turn can activate this experiment. */
export type ConversationMemoryRecallOptions={mode:'idle'|'bounded';waitBudgetMs:number;fallback:'ordinary-context';warmOnMiss:boolean};
export type ConversationMemoryRecallDiagnostics={mode:'idle'|'bounded';waitBudgetMs:number;preparationMs:number;state:'selected'|'empty'|'fallback';coverage:'idleWarm'|'fresh'|'miss';reason:string;selectedReferences:number;providerCalls:number|null;fallback:'ordinary-context'};
export function captureConversationMemoryRecall(options:ConversationMemoryRecallOptions|undefined):Readonly<ConversationMemoryRecallOptions>|undefined{
 if(options===undefined)return undefined;
 if(!options||Object.keys(options).sort().join(',')!=='fallback,mode,waitBudgetMs,warmOnMiss'||!['idle','bounded'].includes(options.mode)||!Number.isSafeInteger(options.waitBudgetMs)||options.waitBudgetMs<0||options.waitBudgetMs>5000||options.mode==='idle'&&options.waitBudgetMs!==0||options.fallback!=='ordinary-context'||typeof options.warmOnMiss!=='boolean')throw Error('Invalid experimental conversation memory recall configuration');
 return Object.freeze({...options});
}
export function attachConversationMemoryRecall(host:HostRuntimeInput,input:{worker:Pick<AutomaticMemory,'conversationRecall'|'precomputeRecall'>;scope:MemoryScope;query:string;options:Readonly<ConversationMemoryRecallOptions>;compile:(references:readonly SemanticContextReference[])=>CompiledRelationshipContext|undefined}):void{
 const options=captureConversationMemoryRecall(input.options)!,scope=Object.freeze({...input.scope}),baseCurrent=host.isCurrent;
 const controls=host.preparedRelationshipContext?.configurationControls;
 const enabled=host.runtimeSelfContext.audienceScope==='authenticatedSession'&&!!host.preparedRelationshipContext&&(controls?.personalizationIntensity??relationshipControlDefaults.personalizationIntensity)!==0&&(controls?.callbackFrequency??relationshipControlDefaults.callbackFrequency)!==0&&(controls?.relevanceThreshold??relationshipControlDefaults.relevanceThreshold)===relationshipControlDefaults.relevanceThreshold;
 if(!enabled)return;
 host.prepareMemory=async signal=>{
  const started=performance.now();
  const outcome=await input.worker.conversationRecall(scope,input.query,options.waitBudgetMs,{signal,current:baseCurrent});
  if(signal.aborted||!baseCurrent())throw Error('Conversation memory scope changed');
  const lease=outcome.lease;
  if(lease){
   if(!lease.isCurrent())throw Error('Conversation memory source changed');
   const context=input.compile(lease.references);if(!context||!lease.isCurrent()||!baseCurrent())throw Error('Conversation memory projection changed');
   context.freshUntil=new Date(Math.min(Date.parse(context.freshUntil),Date.parse(lease.freshUntil))).toISOString();
   host.preparedRelationshipContext=context;
   host.isCurrent=()=>baseCurrent()&&lease.isCurrent()&&Date.parse(context.freshUntil)>Date.now();
  }
  host.memoryRecall={mode:options.mode,waitBudgetMs:options.waitBudgetMs,preparationMs:Math.max(0,performance.now()-started),state:outcome.state,coverage:outcome.coverage,reason:outcome.reason,selectedReferences:lease?.references.length??0,providerCalls:lease?.providerCalls??(options.waitBudgetMs===0?0:null),fallback:options.fallback};
  if(outcome.state==='fallback'&&options.warmOnMiss){const completed=host.onCompleted;host.onCompleted=id=>{completed?.(id);if(baseCurrent())input.worker.precomputeRecall(scope,input.query,baseCurrent);};}
 };
}
