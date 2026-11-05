import {ConversationRecoveryJournal} from '../admin/conversation-recovery-journal.ts';
import {randomUUID as sourceUUID} from 'node:crypto';
import type {ConversationSourceClosure,ConversationSourceIdentity,ConversationSourceAdmission,ConversationSourceRetention} from '@lifestream/storage-sqlite';
import type {ConversationPort} from './conversation.ts';
import {randomUUID} from 'node:crypto';
import {ConversationHistoryRepository,ConversationHistoryError,type ConversationHistoryScope} from '@lifestream/storage-sqlite';
import {unifiedDesktopContractPin,admitUnifiedDesktopConsumer} from '@lifestream/contracts/unified-desktop-contracts';
import {validateConversationHistoryRecord,type HistoryRequest,type HistoryError} from '@lifestream/contracts/conversation-history';
import type {ConversationLifecycle} from './conversation.ts';
export const conversationCatalogLimitations=[
 'Canonical text/voice lifecycle is recorded only for a bound authorized session conversation. Content retention requires an explicit application-owned current policy; absent policy means unavailable content.',
 'No volatile transcript backfill, raw audio retention or memory admission. Authenticated voice transport does not identify its physical speaker.',
 'Authenticated actor and effective account are recorded separately; administrative text is not attributed to the target speaker.',
 'Retained text is bounded to 32768 characters per entry; overflow is unavailable, never a completed retained prefix.',
 'Timeline pages use an authenticated ordinal snapshot with bounded older/newer navigation; appended entries join an explicit latest refresh. Event streaming and durable submission reconciliation remain unavailable.'
] as const;

/** One producer binding uses the actual Session conversation ID. Lost authority
 * permits retirement of existing metadata only, never a new entry or text. */
export function bindDurableConversation(repository:ConversationHistoryRepository,scope:ConversationHistoryScope,assistantId:string,conversationId:string,current:()=>boolean,now=Date.now):(event:ConversationLifecycle)=>void{
 const entries=new Map<string,{id:string;revision:number;terminal:boolean;retire?:(state:'failed'|'interrupted',at:string)=>void}>(),incomplete=new Set<string>();
 return event=>{
  if(!/^[0-9a-f-]{36}$/.test(event.interactionId)||!['text','voice'].includes(event.modality)||!['user','assistant'].includes(event.role))return;
  const key=event.interactionId+':'+event.role,terminal=['completed','failed','interrupted'].includes(event.state),at=new Date(now()).toISOString();let previous=entries.get(key),allowed=false;try{allowed=current();}catch{/* Scope failure cannot authorize text. */}
  try{
  if(!previous&&allowed){repository.adopt(scope,assistantId,conversationId,at);const saved=repository.entryForTurn(scope,conversationId,event.interactionId,event.role==='user'?'human':'assistant');if(saved){previous={id:saved.entryId,revision:saved.revision,terminal:['completed','failed','interrupted'].includes(saved.state),retire:repository.metadataRetirement(scope,conversationId,saved.entryId,event.interactionId,saved.speaker)};entries.set(key,previous);if(saved.state===event.state&&saved.content.state==='retained'&&saved.content.text===event.text)return;}}
  if(previous?.terminal)return;
  if(previous&&terminal&&!allowed){previous.retire?.('interrupted',at);previous.terminal=true;return;}
  if(previous&&terminal){let saved=repository.entryForTurn(scope,conversationId,event.interactionId,event.role==='user'?'human':'assistant');if(!saved||saved.entryId!==previous.id)return;if(incomplete.has(key))saved=repository.redact(scope,conversationId,saved.entryId,saved.revision,'unavailable');const value=repository.finish(scope,conversationId,previous.id,allowed?event.state as 'completed'|'failed'|'interrupted':'interrupted',at,saved.revision);entries.set(key,{id:previous.id,revision:value.revision,terminal:true});return;}
  if(!allowed)return;
  // Initial entry establishment above adopts the catalog. Every fragment still
  // checks the fresh catalog/account/Assistant in observe, without re-adoption.
  const id=previous?.id??event.entryId??randomUUID();
  const value=repository.observe(scope,{entryId:id,turnId:event.interactionId,conversationId,speaker:event.role==='user'?'human':'assistant',modality:event.modality,state:event.state,occurredAt:at,expectedRevision:previous?.revision??0,...(incomplete.has(key)||event.text===undefined?{}:{text:event.text}),attribution:event.role==='assistant'?'observedAssistantOutput':event.modality==='text'?(scope.actorId===scope.effectiveUserId?'authenticatedTypedOwner':'administrativeTypedActor'):'unknownSpeaker'},assistantId);
  entries.set(key,{id,revision:value.revision,terminal,retire:repository.metadataRetirement(scope,conversationId,id,event.interactionId,event.role==='user'?'human':'assistant')});
  }catch{
   incomplete.add(key);
   // A failed replacement cannot leave a completed retained prefix. Commit a
   // unavailable partial independently; the permanent fence is committed at
   // terminal retirement so optional bookkeeping does not revoke reply delivery.
   try{const saved=repository.entryForTurn(scope,conversationId,event.interactionId,event.role==='user'?'human':'assistant');if(saved&&!['completed','failed','interrupted'].includes(saved.state)){const cleared=repository.observe(scope,{entryId:saved.entryId,turnId:saved.turnId,conversationId,speaker:saved.speaker,modality:saved.modality,state:saved.state,occurredAt:at,expectedRevision:saved.revision});entries.set(key,{id:saved.entryId,revision:cleared.revision,terminal:false,retire:previous?.retire??repository.metadataRetirement(scope,conversationId,saved.entryId,event.interactionId,saved.speaker)});}}catch{/* Ordinary delivery survives; a later terminal retries repair. */}
  }
 };
}

export function bindOrdinarySourceOrigin(input:{base:ConversationPort;repository:ConversationHistoryRepository;journal:ConversationRecoveryJournal;scope:ConversationHistoryScope;assistantId:string;conversationId:string}){
 const ids=new Map<string,string>();let valid=true;
 return {current:()=>valid,port:{...input.base,observe:(event:ConversationLifecycle)=>{
  const key=event.interactionId+':'+event.role;let id=ids.get(key);if(!id){id=input.repository.entryForTurn(input.scope,input.conversationId,event.interactionId,event.role==='assistant'?'assistant':'human')?.entryId??sourceUUID();try{input.journal.markEmpty({actorId:input.scope.actorId,effectiveUserId:input.scope.effectiveUserId,assistantId:input.assistantId,conversationId:input.conversationId,entryId:id,turnId:event.interactionId,speaker:event.role==='assistant'?'assistant':'human',modality:event.modality});ids.set(key,id);}catch{valid=false;return;}}
  if(valid)input.base.observe?.({...event,entryId:id});
 }}};
}

/** Source-bearing replies use the original history owner, with no incremental plaintext. */
export function bindSourceConversation(input:{repository:ConversationHistoryRepository;journal:ConversationRecoveryJournal;scope:ConversationHistoryScope;assistantId:string;conversationId:string;closure:ConversationSourceClosure;base:ConversationPort;current:()=>boolean;context:string}){
 let identity:ConversationSourceIdentity|undefined,admission:ConversationSourceAdmission|undefined,retention:ConversationSourceRetention|undefined,buffer='',overflow=false,terminal=false,retire:((state:'failed'|'interrupted',at:string)=>void)|undefined;
 const begin=(interactionId:string,modality:'text'|'voice')=>{
  if(identity){if(identity.turnId!==interactionId||!input.current())throw Error('Source turn changed');return;}
  if(!input.current())throw Error('Source turn unavailable');const at=new Date().toISOString();identity={actorId:input.scope.actorId,effectiveUserId:input.scope.effectiveUserId,assistantId:input.assistantId,conversationId:input.conversationId,entryId:sourceUUID(),turnId:interactionId,speaker:'assistant',modality};
  retention=input.repository.sourceApproval(identity,at,input.scope)??undefined;if(!retention)throw Error('Source reply retention unavailable');
  admission=input.journal.admitSource(identity,input.closure,retention,input.scope,input.current);input.repository.sourceBegin(input.scope,identity,admission,input.closure,retention,at,input.current);retire=input.repository.metadataRetirement(input.scope,identity.conversationId,identity.entryId,interactionId,'assistant');
 };
 const port:ConversationPort={read:()=>input.context,remember:turn=>{if(turn.role==='user')input.base.remember(turn);},observe:event=>{
  if(event.role==='user'){input.base.observe?.(event);return;}if(!identity||!admission||identity.turnId!==event.interactionId)return;
  if(event.modality!==identity.modality)return;
  if(event.state==='generating'&&event.text===undefined){overflow=true;buffer='';}
  if(event.text!==undefined){if(event.text.length>32768){overflow=true;buffer='';}else if(!overflow)buffer=event.text;}
  if(!['completed','failed','interrupted'].includes(event.state)||terminal)return;terminal=true;const at=new Date().toISOString();
  if(overflow||!input.current()){retire?.('interrupted',at);return;}
  try{input.journal.sealSource(admission,buffer,event.state as 'completed'|'failed'|'interrupted',at,input.scope,input.current);}catch{retire?.('interrupted',at);}
 }};
 return {port,begin};
}

/** One canonical catalog owner. Existing runtime/endpoint sessions are untouched. */
export function executeConversationHistory(repository:ConversationHistoryRepository,scope:ConversationHistoryScope,envelope:unknown,authorize:(assistantId:string)=>boolean):{status:number;body:Record<string,unknown>}{
 const producerPin=unifiedDesktopContractPin('conversation-history');
 const fail=(code:HistoryError['code'],message:string,status:number)=>({status,body:{producerPin,error:{schemaVersion:'1.0.0',code,message,retryable:['revisionConflict','restartPage','unavailable'].includes(code),correlationId:randomUUID()} satisfies HistoryError,limitations:conversationCatalogLimitations}});
 if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||Object.keys(envelope).sort().join()!=='producerPin,request')return fail('invalidRequest','A closed producer-pin/request envelope is required.',422);
 const input=envelope as {producerPin:unknown;request:unknown};if(!admitUnifiedDesktopConsumer('conversation-history',input.producerPin).valid)return fail('unsupportedVersion','Current producing-owner version and digest required.',409);
 if(!validateConversationHistoryRecord('HistoryRequest',input.request,producerPin).valid)return fail('invalidRequest','Invalid producing-owner history request.',422);
 const request=input.request as HistoryRequest;
 try{
  const assistant='assistantId' in request.payload?request.payload.assistantId:request.operation==='getOperation'?repository.assistantForOperation(scope,request.payload.targetOperationId):repository.assistantForConversation(scope,request.payload.conversationId);
  if(assistant&&!authorize(assistant))return fail('forbidden','Current account is not authorized for this Assistant.',403);
  let result:unknown;
  switch(request.operation){
   case 'create':case 'rename':case 'pin':case 'unpin':case 'archive':case 'restore':result=repository.mutate(scope,request);break;
   case 'list':result=repository.list(scope,request.payload.assistantId,request.payload.filter,request.payload.pageSize,request.payload.cursor);break;
   case 'read':result=repository.read(scope,request.payload.conversationId);break;
   case 'page':result=repository.page(scope,request.payload.conversationId,request.payload.direction,request.payload.pageSize,request.payload.cursor);break;
   case 'search':result=repository.search(scope,request.payload.assistantId,request.payload.query,request.payload.pageSize,request.payload.cursor);break;
   case 'getOperation':result=repository.operation(scope,request.payload.targetOperationId);break;
  }
  const kind=['create','rename','pin','unpin','archive','restore','getOperation'].includes(request.operation)?'HistoryOperationResult':request.operation==='list'?'ConversationPage':request.operation==='read'?'ConversationSummary':request.operation==='page'?'TimelinePage':'SearchPage';
  if(!validateConversationHistoryRecord(kind,result,producerPin).valid)return fail('unavailable','Owner result could not be admitted against its published contract.',503);
  return {status:200,body:{producerPin,result,limitations:conversationCatalogLimitations}};
 }catch(error){if(error instanceof ConversationHistoryError)return fail(error.code,error.message,error.code==='notFound'?404:error.code==='forbidden'?403:['revisionConflict','idempotencyConflict','restartPage'].includes(error.code)?409:error.code==='backpressure'?429:422);throw error;}
}
