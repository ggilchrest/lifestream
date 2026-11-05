type ConversationAnySourceRef=import('@lifestream/storage-sqlite').ConversationSourceClosure['sourceRefs'][number];
import {randomUUID,createHash} from 'node:crypto';
import {types as utilTypes} from 'node:util';
import {calendarConversationAttachment} from '@lifestream/contracts/mobile-context-calendar-conversation';
import {conversationSourceCanonical,type ConversationSourceClosure,type ConversationHistoryScope,type ConversationHistoryRepository,type MobileAccess} from '@lifestream/storage-sqlite';
import {createPreparedTurnBinding} from '@lifestream/runtime/inference/prompt';
import {bindOrdinarySourceOrigin,bindSourceConversation} from './conversation-history.ts';
import {MobileContextService} from './mobile-context.ts';
import type {HostRuntimeInput} from './inference.ts';
import type {ConversationRecoveryJournal} from '../admin/conversation-recovery-journal.ts';
export type CalendarNoticeScope=Readonly<{principalId:string;sessionId:string;assistantId:string;endpointId:string;endpointRevision:number;sessionRevision:number;contextRef:string;contextGeneration:number;modality:'text'|'voice'}>;
export type CalendarConversationOptions={mode:'selectedCalendarWindow';historyInitialization:'requireCurrentSourceFormat'|'upgradeVerifiedV1';noticeSupport?:(scope:CalendarNoticeScope)=>{scope:CalendarNoticeScope;surfaceRevision:'daily-calendar-source-context/1';current:()=>boolean}|null};
export function attachCalendarConversation(p:{result:HostRuntimeInput;body:Record<string,unknown>;scope:ConversationHistoryScope;repository:ConversationHistoryRepository;journal:ConversationRecoveryJournal;conversationId:string;mobile:MobileContextService;access:MobileAccess;configuration:CalendarConversationOptions;noticeScope:CalendarNoticeScope;proof:(refs:readonly ConversationAnySourceRef[])=>{valid:boolean;pure:()=>boolean};firstImport:(key:string)=>string|undefined;healthEnabled:boolean;configurationCurrent:()=>boolean}){
 const fail=()=>{throw Error('calendar_conversation_unavailable');};
 const {result,scope,journal,repository}=p,base=result.conversation;if(!base||!journal.sourceEnabled()||!p.configuration.noticeSupport)return fail();
 const raw=p.body.calendarContextIntent,value=raw===undefined?undefined:calendarConversationAttachment(raw);if(raw!==undefined&&(!value||value.intent.assistantId!==result.assistantId||value.intent.conversationId!==p.conversationId))return fail();
 const support=p.configuration.noticeSupport(Object.freeze({...p.noticeScope}));
 if(!support||utilTypes.isProxy(support))return fail();
 const fields=Object.getOwnPropertyDescriptors(support),currentProperty=fields.current,scopeProperty=fields.scope,versionProperty=fields.surfaceRevision;
 const data=(d:PropertyDescriptor|undefined):d is PropertyDescriptor&{value:unknown}=>!!d&&Object.hasOwn(d,'value');
 const sameDescriptor=(a:PropertyDescriptor|undefined,b:PropertyDescriptor|undefined)=>data(a)&&data(b)&&a.value===b.value&&a.writable===b.writable&&a.enumerable===b.enumerable&&a.configurable===b.configurable;
 const readScopeFields=(value:unknown)=>{if(!value||typeof value!=='object'||utilTypes.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return null;const own=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(own),expected=Object.keys(p.noticeScope);if(keys.length!==expected.length||expected.some(key=>!data(own[key])||own[key]!.value!==p.noticeScope[key as keyof CalendarNoticeScope]))return null;return own;};
 if(Reflect.ownKeys(fields).length!==3||!data(currentProperty)||typeof currentProperty.value!=='function'||!data(scopeProperty)||!data(versionProperty)||versionProperty.value!=='daily-calendar-source-context/1')return fail();
 const scopeFields=readScopeFields(scopeProperty.value);if(!scopeFields)return fail();
 const noticeCurrent=currentProperty.value as ()=>boolean,noticeBindingCurrent=()=>{if(utilTypes.isProxy(support))return false;const now=Object.getOwnPropertyDescriptors(support);if(Reflect.ownKeys(now).length!==3||!sameDescriptor(now.current,currentProperty)||!sameDescriptor(now.scope,scopeProperty)||!sameDescriptor(now.surfaceRevision,versionProperty))return false;const currentScope=readScopeFields(scopeProperty.value);return !!currentScope&&Object.keys(scopeFields).every(key=>sameDescriptor(currentScope[key],scopeFields[key]))&&p.configurationCurrent();},notice=()=>noticeBindingCurrent()&&noticeCurrent.call(support)===true&&noticeBindingCurrent();
 if(!notice())return fail();
 const selected=value?p.mobile.prepareCalendarConversation(p.access,value):undefined;
 const health=MobileContextService.isSleepQuestion(typeof p.body.userInput==='string'?p.body.userInput:'')?(p.healthEnabled?p.mobile.prepareConversationAnswer(p.access,result.assistantId,new Date().toISOString(),p.firstImport):fail()):undefined;
 const ordinary=bindOrdinarySourceOrigin({base,repository,journal,scope,assistantId:result.assistantId,conversationId:p.conversationId}),parents=repository.sourceContext(scope,p.conversationId,result.assistantId);
 const unique=<T>(items:T[])=>[...new Map(items.map(item=>[conversationSourceCanonical(item),item])).values()].sort((a,b)=>conversationSourceCanonical(a).localeCompare(conversationSourceCanonical(b)));
 const refs=unique<ConversationAnySourceRef>([...(selected?.refs??[]),...(health?.refs??[]),...parents.flatMap(x=>x.binding.closure.sourceRefs as ConversationAnySourceRef[])]);
 const closure:ConversationSourceClosure={schemaVersion:'2.0.0',sourceRefs:refs,ancestorCommits:unique(parents.flatMap(x=>[x.binding.parent,...x.binding.closure.ancestorCommits])),directParents:parents.map(x=>x.binding.commit.contentCommitId)};
 if(!refs.some(r=>r.kind==='calendarQueryScope')||refs.length>128||closure.ancestorCommits.length>32||Buffer.byteLength(conversationSourceCanonical(closure))>131072||result.preparedVisualContext||p.body.inspect===true||p.body.fullPromptPreview===true)return fail();
 const prior=result.isCurrent,current=()=>{try{if(!prior()||!ordinary.current()||!notice()||!journal.sourceEnabled()||!journal.parentsCurrent(closure,scope)||!p.access.current())return false;const proof=p.proof(refs);return proof.valid&&noticeBindingCurrent()&&proof.pure();}catch{return false;}};
 const source=bindSourceConversation({base:ordinary.port,repository,journal,scope,assistantId:result.assistantId,conversationId:p.conversationId,closure,current,context:JSON.stringify(parents.map(x=>({interactionId:x.interactionId,role:x.role,text:x.text})))});
 if(result.preparedTurnBinding){const old=result.preparedTurnBinding;result.preparedTurnBinding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:createHash('sha256').update(old.invalidationKey+conversationSourceCanonical(closure)).digest('hex'),scope:old.scope,conversation:source.port.read(),sourceRevisions:old.sourceRevisions});}
 result.conversation=source.port;result.sourceBegin=source.begin;result.sourceNotice='source-linked-calendar/1';result.isCurrent=current;
 delete result.onCompleted;delete result.onReplyCompleted;delete result.prepareMemory;delete result.admitMemory;delete result.experienceSelection;delete result.visualTurnEvidence;delete result.inspection;
 const additions=[selected?.context,health?.context].filter(Boolean);if(additions.length){const before=result.prepareWorld;result.prepareWorld=async signal=>{const previous=before?await before(signal):undefined;if(signal.aborted||!current())return fail();const content=[...additions.map(x=>x!.content),previous?.context.content].filter(Boolean).join('\n');if(Buffer.byteLength(content)>8192)return fail();return {context:{content,sourceRef:'calendar:source-linked-context',sourceRevision:createHash('sha256').update(conversationSourceCanonical(refs)).digest('hex')},isCurrent:()=>!previous||previous.isCurrent(),isSnapshotCurrent:()=>!previous||previous.isSnapshotCurrent()};};}
 if(!current())return fail();
}
