import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type {ActivityScope,CampaignJournal,GameObservation} from '@lifestream/contracts/game-activity';
import type {ActivityOwner,GameHelpRepository,MemoryRepository,MemoryRecord} from '@lifestream/storage-sqlite';
/** Host-owned authenticated input receipt. Its existence is not qualification;
 * the channel/authentication owner must independently verify its exact refs. */
export type GameAdviceReply={helpId:string;helpRevision:number;principalId:string;assistantId:string;relationshipId:string;channelRef:string;recipientRef:string;sourceTurnRef:string;sourceSessionRef:string;memoryId:string;memoryRevision:number;quotedAdvice:string;questionDeliveryEvidenceRef:string;authenticatedReplyEvidenceRef:string;receivedAt:string};
export type GameAdvicePorts={
 memories:Pick<MemoryRepository,'contextRecords'>;help:Pick<GameHelpRepository,'get'|'getForHistory'>;
 boundaryRevision:()=>string|null;
 /** Current owner administration/privacy/retention; not a play grant. */
 scopeCurrent:(scope:Readonly<ActivityScope>)=>boolean;
 /** Actual delivery of this question and authenticated attribution of this
  * exact answer by the independently governed channel owner. */
 replyCurrent:(reply:Readonly<GameAdviceReply>)=>boolean;
 /** The latest fresh post-answer player-visible observation, separately
  * qualified against the current run/timeline/provider. */
 observationCurrent:(observation:Readonly<GameObservation>)=>boolean;
 adviceRelevantCurrent:(reply:Readonly<GameAdviceReply>,observation:Readonly<GameObservation>)=>boolean;
 now?:()=>number;
};
const adviceSources=new WeakMap<GameAdviceSelection,{scope:ActivityScope;observationId:string;observationRevision:number;pinsDigest:string;historicalSourceCurrent:()=>boolean;reply:GameAdviceReply}>();
/** Exact minted source identity, not a model's copied attribution wrapper. */
/** Historical custody only, never current context, planning or resume authority. */
export function gameAdviceHistoricalSourceCurrent(advice:GameAdviceSelection):boolean{try{return adviceSources.get(advice)?.historicalSourceCurrent()===true;}catch{return false;}}
export function gameAdviceMatchesResultPins(advice:GameAdviceSelection,observation:GameObservation):boolean{const source=adviceSources.get(advice);return !!source&&source.pinsDigest===observation.pinsDigest&&isDeepStrictEqual(source.scope,observation.scope);}
export function gameAdviceMatchesDecision(advice:GameAdviceSelection,decision:import('@lifestream/contracts/game-activity').GameDecisionInput):boolean{try{const source=adviceSources.get(advice);return !!source&&gameAdviceHistoricalSourceCurrent(advice)&&isDeepStrictEqual(source.scope,decision.scope)&&source.observationId===decision.observationId&&source.observationRevision===decision.observationRevision&&!!advice.adviceRef&&decision.adviceRefs.includes(advice.adviceRef);}catch{return false;}}
/** Only a genuinely selected authenticated source can expose its retention
 * bindings. The returned data is not authority; custody must be requalified. */
export function gameAdviceEpisodeSource(advice:GameAdviceSelection):import('@lifestream/storage-sqlite').GameEpisodeAdviceSource|null{
 try{const source=adviceSources.get(advice);if(!source||!advice.adviceRef||!gameAdviceHistoricalSourceCurrent(advice))return null;const r=source.reply;
  return Object.freeze({adviceRef:advice.adviceRef,helpId:r.helpId,helpRevision:r.helpRevision,memoryId:r.memoryId,memoryRevision:r.memoryRevision,sourceTurnRef:r.sourceTurnRef,sourceSessionRef:r.sourceSessionRef,receivedAt:r.receivedAt,questionDeliveryEvidenceRef:r.questionDeliveryEvidenceRef,authenticatedReplyEvidenceRef:r.authenticatedReplyEvidenceRef});
 }catch{return null;}
}
export type GameAdviceSelection=Readonly<{state:'selected'|'unavailable';adviceRef:string|null;entry:CampaignJournal['entries'][number]|null;content:string|null;digest:string|null;isCurrent:()=>boolean;playAuthority:false;resumeAuthority:false;sendAuthority:false}>;
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const freeze=<T>(v:T):T=>{if(v&&typeof v==='object'){for(const c of Object.values(v))freeze(c);Object.freeze(v);}return v;};
const positive=(n:unknown,max:number):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=1&&n<=max;
const opaque=(v:unknown)=>typeof v==='string'&&v.trim().length>0&&Buffer.byteLength(v)<=2048;
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(v);
export type GameHelpAdviceInput=Omit<GameAdviceReply,'memoryId'|'memoryRevision'> & {
 transformationConfidence:{value:number;basis:string;policyRef:string};
};
export type GameHelpHumanInput=Readonly<Pick<GameHelpAdviceInput,'principalId'|'assistantId'|'relationshipId'|'sourceTurnRef'|'sourceSessionRef'|'receivedAt'> & {text:string}>;
type GameHelpAdviceOwner=Readonly<Pick<GameHelpAdviceInput,'principalId'|'assistantId'|'relationshipId'>>;
export type GameHelpAdviceIntakeOptions={
 /** Read the actual retained authenticated Human input, not a model-authored
  * source wrapper. A missing/deleted/expired source returns null. */
 inputFor:(reply:Readonly<GameHelpAdviceInput>)=>GameHelpHumanInput|null;
 /** Independent question-delivery and authenticated-answer owner. */
 replyCurrent:(reply:Readonly<GameHelpAdviceInput>)=>boolean;
 /** Explicit bounded reasoning selection of this whole answer as advice.
  * This synchronous check reads an already selected result; it must not run
  * inference. No lexical/pronoun/generalization/semantic-worth rule applies here. */
 adviceSelectedCurrent:(reply:Readonly<GameHelpAdviceInput>)=>boolean;
 boundaryRevision:()=>string|null;
};
export type GameHelpAdviceIntakePorts=GameHelpAdviceIntakeOptions & {
 memories:Pick<MemoryRepository,'admitAutomatic'|'get'>;
 help:Pick<GameHelpRepository,'get'>;
 memoryPolicy:(owner:GameHelpAdviceOwner)=>{enabled:boolean;revision:number};
 scopeCurrent:(owner:GameHelpAdviceOwner,content:string)=>boolean;
 now?:()=>number;
};
/** One explicitly selected authenticated help answer enters the existing
 * relationship memory owner. This creates no generic capture rule, message,
 * observation, campaign entry, action, resume or tested-outcome claim. */
export function retainGameHelpAdvice(raw:GameHelpAdviceInput,ports:GameHelpAdviceIntakePorts){
 const unavailable=()=>Object.freeze({state:'unavailable' as const,reply:null,playAuthority:false as const,resumeAuthority:false as const,sendAuthority:false as const});
 try{
  const r=boundedGameDataSnapshot(raw,8192) as GameHelpAdviceInput|null;
  if(!r||Object.keys(r).sort().join(',')!=='assistantId,authenticatedReplyEvidenceRef,channelRef,helpId,helpRevision,principalId,questionDeliveryEvidenceRef,quotedAdvice,receivedAt,recipientRef,relationshipId,sourceSessionRef,sourceTurnRef,transformationConfidence'||![r.helpId,r.principalId,r.assistantId,r.relationshipId].every(uuid)||!positive(r.helpRevision,2147483647)||![r.channelRef,r.recipientRef,r.sourceTurnRef,r.sourceSessionRef,r.questionDeliveryEvidenceRef,r.authenticatedReplyEvidenceRef].every(opaque)||typeof r.quotedAdvice!=='string'||!r.quotedAdvice.trim()||r.quotedAdvice.length>1000||!validator.validate('https://lifestream.dev/contracts/protocol-common/1.0.0#/$defs/Time',r.receivedAt).valid)return unavailable();
  const estimate=r.transformationConfidence;
  if(!estimate||Object.keys(estimate).sort().join(',')!=='basis,policyRef,value'||!Number.isFinite(estimate.value)||estimate.value<0||estimate.value>1||typeof estimate.basis!=='string'||!estimate.basis.trim()||Buffer.byteLength(estimate.basis)>1024||!opaque(estimate.policyRef))return unavailable();
  freeze(r);const host=Object.freeze({...ports}),owner=freeze({principalId:r.principalId,assistantId:r.assistantId,relationshipId:r.relationshipId}),clock=host.now??Date.now;
  const readInput=host.inputFor,readHelp=host.help.get.bind(host.help),readPolicy=host.memoryPolicy,received=Date.parse(r.receivedAt),start=clock();
  if(!Number.isSafeInteger(start)||received>start)return unavailable();
  const source=()=>{const input=boundedGameDataSnapshot(readInput(r),8192) as GameHelpHumanInput|null;return input&&Object.keys(input).sort().join(',')==='assistantId,principalId,receivedAt,relationshipId,sourceSessionRef,sourceTurnRef,text'&&input.principalId===r.principalId&&input.assistantId===r.assistantId&&input.relationshipId===r.relationshipId&&input.sourceTurnRef===r.sourceTurnRef&&input.sourceSessionRef===r.sourceSessionRef&&input.receivedAt===r.receivedAt&&input.text===r.quotedAdvice?input:null;};
  const input=source(),help=readHelp(owner,r.helpId),policy=readPolicy(owner),revision=host.boundaryRevision();
  if(!input||!help||help.revision!==r.helpRevision||help.item.channelRef!==r.channelRef||help.item.recipientRef!==r.recipientRef||help.item.scope.principalId!==r.principalId||help.item.scope.assistantId!==r.assistantId||help.item.scope.relationshipId!==r.relationshipId||received<Date.parse(help.item.queuedAt)||!policy.enabled||!positive(policy.revision,2147483647)||typeof revision!=='string'||!revision.trim()||Buffer.byteLength(revision)>1024||start>=help.expiresAt)return unavailable();
  const inputDigest=digest(input),helpDigest=digest(help),deadline=performance.now()+help.expiresAt-start;let last=start,checking=false,retired=false;
  const current=()=>{if(checking||retired)return false;checking=true;try{const now=clock();if(!Number.isSafeInteger(now)||now<last||now>=help.expiresAt||performance.now()>=deadline||host.boundaryRevision()!==revision||host.scopeCurrent(owner,r.quotedAdvice)!==true||host.replyCurrent(r)!==true||host.adviceSelectedCurrent(r)!==true){retired=true;return false;}const latestInput=source(),latestHelp=readHelp(owner,r.helpId),latestPolicy=readPolicy(owner),end=clock();if(!latestInput||digest(latestInput)!==inputDigest||!latestHelp||digest(latestHelp)!==helpDigest||!isDeepStrictEqual(latestPolicy,policy)||host.boundaryRevision()!==revision||host.scopeCurrent(owner,r.quotedAdvice)!==true||host.replyCurrent(r)!==true||!Number.isSafeInteger(end)||end<now||end>=help.expiresAt||performance.now()>=deadline){retired=true;return false;}const finalInput=source(),finalHelp=readHelp(owner,r.helpId),finalPolicy=readPolicy(owner),finalTime=clock();if(!finalInput||digest(finalInput)!==inputDigest||!finalHelp||digest(finalHelp)!==helpDigest||!isDeepStrictEqual(finalPolicy,policy)||!Number.isSafeInteger(finalTime)||finalTime<end||finalTime>=help.expiresAt||performance.now()>=deadline){retired=true;return false;}last=finalTime;return true;}catch{retired=true;return false;}finally{checking=false;}};
  if(!current())return unavailable();
  // Exact source identity only: another help/game cannot create reinforcement,
  // and a forgotten original row cannot be recreated by replaying its answer.
  const h=digest(['lifestream.game-help-human-input-v1',owner,r.sourceTurnRef]),id=`${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
  const record:MemoryRecord={id,assistantId:r.assistantId,content:`User stated: ${r.quotedAdvice}`,createdAt:new Date(start).toISOString(),provenance:{actor:r.principalId,relationshipId:r.relationshipId,sourceTurnRef:r.sourceTurnRef,sourceSessionRef:r.sourceSessionRef,sourceFamily:`turn:${r.sourceTurnRef}`,epistemicStatus:'userStatement',transformation:'exact-attributed-quote-v1',automaticMemoryKey:h,gameHelpAdviceSelection:true,transformationConfidence:estimate,limitations:['Attributed Human guidance; applicability and truth are unverified.','Game/run application and observed outcomes remain separate.']},lifecycle:{kind:'proceduralHint',factuality:'unverified',sensitivity:'private',confidence:estimate.value,status:'candidate',revision:1,lastReinforcedAt:null,contradictedBy:[]}};
  if(host.memories.admitAutomatic([record],owner.principalId,false,current)[0]!==id)return unavailable();
  const retained=host.memories.get(owner.assistantId,id);
  if(!retained||retained.content!==record.content||retained.provenance.relationshipId!==owner.relationshipId||retained.provenance.sourceTurnRef!==r.sourceTurnRef||retained.lifecycle.status!=='active'||!positive(retained.lifecycle.revision,2147483647))return unavailable();
  const {transformationConfidence:_,...reply}=r;void _;
  return freeze({state:'retained' as const,reply:{...reply,memoryId:id,memoryRevision:retained.lifecycle.revision as number},playAuthority:false as const,resumeAuthority:false as const,sendAuthority:false as const});
 }catch{return unavailable();}
}
/** An inert attributed advice source and campaign entry. No receipt/status,
 * journal, memory, plan, controller action or lifecycle mutation is performed. */
export function selectGameAdvice(raw:{scope:ActivityScope;reply:GameAdviceReply;observation:GameObservation;maximumBytes:number;maximumObservationAgeMs:number;nowMs:number;freshUntilMs:number},ports:GameAdvicePorts):GameAdviceSelection{
 const unavailable=():GameAdviceSelection=>freeze({state:'unavailable',adviceRef:null,entry:null,content:null,digest:null,isCurrent:()=>false,playAuthority:false,resumeAuthority:false,sendAuthority:false});
 const v=boundedGameDataSnapshot(raw,32768) as typeof raw|null;if(!v||Object.keys(v).sort().join(',')!=='freshUntilMs,maximumBytes,maximumObservationAgeMs,nowMs,observation,reply,scope'||!positive(v.maximumBytes,8192)||!positive(v.maximumObservationAgeMs,120000)||!Number.isSafeInteger(v.nowMs)||v.nowMs<0||!Number.isSafeInteger(v.freshUntilMs)||v.freshUntilMs<=v.nowMs||!validator.validate(schema+'ActivityScope',v.scope).valid||!validator.validate(schema+'GameObservation',v.observation).valid)return unavailable();
 const r=v.reply,o=v.observation,s=v.scope;
 if(!r||Object.keys(r).sort().join(',')!=='assistantId,authenticatedReplyEvidenceRef,channelRef,helpId,helpRevision,memoryId,memoryRevision,principalId,questionDeliveryEvidenceRef,quotedAdvice,receivedAt,recipientRef,relationshipId,sourceSessionRef,sourceTurnRef'||![r.helpId,r.memoryId,r.principalId,r.assistantId,r.relationshipId].every(uuid)||!positive(r.helpRevision,2147483647)||!positive(r.memoryRevision,2147483647)||![r.channelRef,r.recipientRef,r.sourceTurnRef,r.sourceSessionRef,r.questionDeliveryEvidenceRef,r.authenticatedReplyEvidenceRef].every(opaque)||!validator.validate('https://lifestream.dev/contracts/protocol-common/1.0.0#/$defs/Time',r.receivedAt).valid||typeof r.quotedAdvice!=='string'||!r.quotedAdvice.trim()||r.quotedAdvice.length>1800||!isDeepStrictEqual(o.scope,s)||r.principalId!==s.principalId||r.assistantId!==s.assistantId||r.relationshipId!==s.relationshipId)return unavailable();
 const received=Date.parse(r.receivedAt),captured=Date.parse(o.capturedAt),arrived=Date.parse(o.receivedAt);
 if(!Number.isFinite(received)||received>captured||captured>arrived||arrived>v.nowMs||o.interpretedAt!==null&&(Date.parse(o.interpretedAt)<arrived||Date.parse(o.interpretedAt)>v.nowMs)||v.freshUntilMs>captured+v.maximumObservationAgeMs)return unavailable();
 freeze(v);const host=Object.freeze({...ports}),readMemories=ports.memories.contextRecords.bind(ports.memories),readHelp=ports.help.get.bind(ports.help),readHistory=ports.help.getForHistory.bind(ports.help),owner:ActivityOwner=freeze({principalId:s.principalId,assistantId:s.assistantId,relationshipId:s.relationshipId}),clock=host.now??Date.now;
 const humanMemory=()=>{const rows=readMemories(s.assistantId,s.principalId);if(rows.length>257)return null;const found=rows.find(m=>m.id===r.memoryId),m=boundedGameDataSnapshot(found,16384) as MemoryRecord|null;return m&&m.assistantId===s.assistantId&&m.provenance.actor===s.principalId&&m.provenance.relationshipId===s.relationshipId&&m.provenance.sourceTurnRef===r.sourceTurnRef&&m.provenance.sourceFamily===`turn:${r.sourceTurnRef}`&&m.provenance.epistemicStatus==='userStatement'&&m.provenance.transformation==='exact-attributed-quote-v1'&&!m.provenance.gameEpisodeId&&!m.provenance.visualEpisodeId&&m.lifecycle.status==='active'&&m.lifecycle.revision===r.memoryRevision&&m.content===`User stated: ${r.quotedAdvice}`&&Date.parse(m.createdAt)>=received&&Date.parse(m.createdAt)<=clock()?freeze(m):null;};
 let memory:MemoryRecord|null,help:ReturnType<GameHelpRepository['get']>,revision:string|null;try{memory=humanMemory();help=readHelp(owner,r.helpId);revision=host.boundaryRevision();}catch{return unavailable();}
 if(!memory||!help||help.revision!==r.helpRevision||!isDeepStrictEqual(help.item.scope,s)||help.pinsDigest!==o.pinsDigest||help.item.channelRef!==r.channelRef||help.item.recipientRef!==r.recipientRef||received<Date.parse(help.item.queuedAt)||typeof revision!=='string'||!revision.trim()||Buffer.byteLength(revision)>1024||v.freshUntilMs>help.expiresAt)return unavailable();
 const memoryDigest=digest(memory),helpDigest=digest(help);let historySnapshot:ReturnType<GameHelpRepository['getForHistory']>;try{historySnapshot=readHistory(owner,r.helpId);}catch{return unavailable();}if(!historySnapshot)return unavailable();const historyDigest=digest(historySnapshot);let historyRetired=false,historyChecking=false,historyLast=v.nowMs;const historyMonoDeadline=performance.now()+historySnapshot.expiresAt-v.nowMs;
 const historicalSourceCurrent=()=>{if(historyRetired||historyChecking)return false;historyChecking=true;try{const now=clock();if(!Number.isSafeInteger(now)||now<historyLast||now>=historySnapshot.expiresAt||performance.now()>=historyMonoDeadline||host.scopeCurrent(s)!==true||host.replyCurrent(r)!==true){historyRetired=true;return false;}const m=humanMemory(),original=readHistory(owner,r.helpId),after=clock();if(!m||digest(m)!==memoryDigest||!original||digest(original)!==historyDigest||host.scopeCurrent(s)!==true||host.replyCurrent(r)!==true||!Number.isSafeInteger(after)||after<now||after>=historySnapshot.expiresAt||performance.now()>=historyMonoDeadline){historyRetired=true;return false;}const finalHistory=readHistory(owner,r.helpId),finalMemory=humanMemory(),end=clock();if(!finalHistory||digest(finalHistory)!==historyDigest||!finalMemory||digest(finalMemory)!==memoryDigest||!Number.isSafeInteger(end)||end<after||end>=historySnapshot.expiresAt||performance.now()>=historyMonoDeadline){historyRetired=true;return false;}historyLast=end;return true;}catch{historyRetired=true;return false;}finally{historyChecking=false;}};
 const monoDeadline=performance.now()+v.freshUntilMs-v.nowMs;let last=v.nowMs,retired=false,checking=false;
 const isCurrent=()=>{if(retired||checking)return false;checking=true;try{const now=clock();if(!Number.isSafeInteger(now)||now<last||now>=v.freshUntilMs||performance.now()>=monoDeadline||host.boundaryRevision()!==revision||host.scopeCurrent(s)!==true||host.replyCurrent(r)!==true||host.observationCurrent(o)!==true||host.adviceRelevantCurrent(r,o)!==true){retired=true;return false;}const currentMemory=humanMemory(),currentHelp=readHelp(owner,r.helpId),after=clock();if(!currentMemory||digest(currentMemory)!==memoryDigest||!currentHelp||digest(currentHelp)!==helpDigest||host.scopeCurrent(s)!==true||host.boundaryRevision()!==revision||!Number.isSafeInteger(after)||after<now||after>=v.freshUntilMs||performance.now()>=monoDeadline){retired=true;return false;}last=after;return true;}catch{retired=true;return false;}finally{checking=false;}};
 if(!isCurrent())return unavailable();
 const h=digest([owner,r.helpId,r.memoryId,r.sourceTurnRef]),id=`${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`,adviceRef=`game-advice:${id}`;
 const entry:CampaignJournal['entries'][number]=freeze({entryId:id,kind:'humanAdvice',epistemicKind:'humanAdvice',content:memory.content,sourceRefs:[`game-help:${r.helpId}:${r.helpRevision}`,`memory:${memory.id}:${r.memoryRevision}:${memoryDigest}`,r.authenticatedReplyEvidenceRef],sourceSessionRef:r.sourceSessionRef,recordedAt:r.receivedAt,limitations:['Attributed authenticated input, not an observed game outcome or proof the advice works.','Advice cannot execute code, widen tools or grant play/resume/contact authority.']});
 const content=JSON.stringify({sourceKind:'attributedGameHumanAdvice',untrusted:true,sourceType:'participantStatement',adviceRef,helpId:r.helpId,scope:s,originalSourceTurnRef:r.sourceTurnRef,originalHumanSessionRef:r.sourceSessionRef,memoryId:r.memoryId,memoryRevision:r.memoryRevision,quotedAdvice:r.quotedAdvice,receivedAt:r.receivedAt,freshObservationId:o.observationId,freshObservationRevision:o.revision,observationCapturedAt:o.capturedAt,epistemicKind:'humanAdvice',limitations:entry.limitations});
 if(!validator.validate(schema+'CampaignJournal/properties/entries/items',entry).valid||Buffer.byteLength(content)>v.maximumBytes||!isCurrent())return unavailable();const selection:GameAdviceSelection=freeze({state:'selected',adviceRef,entry,content,digest:createHash('sha256').update(content).digest('hex'),isCurrent,playAuthority:false,resumeAuthority:false,sendAuthority:false});adviceSources.set(selection,{scope:s,observationId:o.observationId,observationRevision:o.revision,pinsDigest:o.pinsDigest,historicalSourceCurrent,reply:r});return selection;
}
