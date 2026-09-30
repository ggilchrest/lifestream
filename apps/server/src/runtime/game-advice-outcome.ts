import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type * as G from '@lifestream/contracts/game-activity';
import {gameDecisionHasPreparedIdentity,gameDecisionMatchesPreparedContext,gameProposalMatchesPreparedContext,type PreparedGameCampaignContext} from '@lifestream/runtime/activity/game-journal';
import type {PreparedTurnBinding} from '@lifestream/runtime/inference/prompt';
import {gameAdviceMatchesDecision,gameAdviceMatchesResultPins,type GameAdviceSelection} from './game-advice.ts';

type Data={disposition:'used'|'rejected'|'obsolete';reason:string;proposal:G.GameActionProposal|null;admission:G.GameAdmission|null;receipt:G.GameActionReceipt|null;resultObservation:G.GameObservation|null;nowMs:number;freshUntilMs:number;maximumObservationAgeMs:number;maximumBytes:number};
export type GameAdviceOutcomePorts={
 boundaryRevision:()=>string|null;
 /** Recorded decision/reason relevance, not current authority to execute it. */
 dispositionGroundedCurrent:(decision:Readonly<G.GameDecisionInput>,data:Readonly<Data>)=>boolean;
 /** Resolve the actual immutable dispatch/admission/receipt ledger and exact
  * original proposal/input digest. Shape-valid admission data is insufficient. */
 receiptCurrent:(decision:Readonly<G.GameDecisionInput>,proposal:Readonly<G.GameActionProposal>,admission:Readonly<G.GameAdmission>,receipt:Readonly<G.GameActionReceipt>)=>boolean;
 /** Latest resulting visible source and qualified outcome interpretation. */
 outcomeCurrent:(receipt:Readonly<G.GameActionReceipt>,observation:Readonly<G.GameObservation>,reason:string)=>boolean;
 now?:()=>number;
};
export type GameAdviceOutcome=Readonly<{state:'selected'|'unavailable';evidenceState:'planned'|'attemptedOutcomeUnknown'|'observedAttempt'|'rejected'|'obsolete'|null;entry:G.CampaignJournal['entries'][number]|null;content:string|null;isCurrent:()=>boolean;adviceSuccessEstablished:false;playAuthority:false;resumeAuthority:false;sendAuthority:false}>;
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
const freeze=<T>(v:T):T=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;};
/** Source projection only: no controller, lifecycle, pending-help status,
 * journal persistence, memory reinforcement or inferred causal success. */
export function selectGameAdviceOutcome(input:{advice:GameAdviceSelection;game:PreparedGameCampaignContext;binding:PreparedTurnBinding;decision:G.GameDecisionInput;data:Data},ports:GameAdviceOutcomePorts):GameAdviceOutcome{
 const unavailable=():GameAdviceOutcome=>freeze({state:'unavailable',evidenceState:null,entry:null,content:null,isCurrent:()=>false,adviceSuccessEstablished:false,playAuthority:false,resumeAuthority:false,sendAuthority:false});
 const {advice,game,binding,decision}=input,data=boundedGameDataSnapshot(input.data,65536) as Data|null;
 if(!data||Object.keys(data).sort().join(',')!=='admission,disposition,freshUntilMs,maximumBytes,maximumObservationAgeMs,nowMs,proposal,reason,receipt,resultObservation'||!['used','rejected','obsolete'].includes(data.disposition)||typeof data.reason!=='string'||!data.reason.trim()||data.reason.length>1000||!Number.isSafeInteger(data.nowMs)||data.nowMs<0||!Number.isSafeInteger(data.freshUntilMs)||data.freshUntilMs<=data.nowMs||!Number.isSafeInteger(data.maximumBytes)||data.maximumBytes<1||data.maximumBytes>8192||!Number.isSafeInteger(data.maximumObservationAgeMs)||data.maximumObservationAgeMs<1||data.maximumObservationAgeMs>120000||data.freshUntilMs>data.nowMs+data.maximumObservationAgeMs||!gameDecisionHasPreparedIdentity(game,binding,decision)||!gameAdviceMatchesDecision(advice,decision))return unavailable();
 const p=data.proposal,a=data.admission,r=data.receipt,o=data.resultObservation;
 if(p&&(!validator.validate(schema+'GameActionProposal',p).valid||!isDeepStrictEqual(p.scope,decision.scope)||p.observationId!==decision.observationId||p.observationRevision!==decision.observationRevision||p.preparedViewId!==decision.viewId||p.preparedViewRevision!==decision.viewRevision||p.invalidationKey!==decision.invalidationKey||p.adviceRefs.some(ref=>!decision.adviceRefs.includes(ref))))return unavailable();
 if(data.disposition==='used'&&(!p||!p.adviceRefs.includes(advice.adviceRef!))||data.disposition!=='used'&&(p?.adviceRefs.includes(advice.adviceRef!)||a||r||o)||!!a!==!!r||o&&!r)return unavailable();
 let evidenceState:NonNullable<GameAdviceOutcome['evidenceState']>=data.disposition==='used'?'planned':data.disposition;
 if(r){
  if(!p||!a||!validator.validate(schema+'GameAdmission',a).valid||!validator.validate(schema+'GameActionReceipt',r).valid||!isDeepStrictEqual(r.scope,decision.scope)||r.proposalId!==p.proposalId||r.admissionId!==a.admissionId||r.inputDigest!==a.inputDigest||!['started','completed','failed','cancelled','outcomeUnknown'].includes(r.disposition)||r.startedAt===null||r.beforeFrame===null||Date.parse(r.startedAt)<Date.parse(decision.selectedAt)||Date.parse(r.startedAt)<Date.parse(a.issuedAt)||Date.parse(r.startedAt)>=Date.parse(a.expiresAt)||Date.parse(r.startedAt)>Date.parse(r.recordedAt)||Date.parse(r.recordedAt)>data.nowMs||r.completedAt!==null&&(Date.parse(r.completedAt)<Date.parse(r.startedAt)||Date.parse(r.completedAt)>Date.parse(r.recordedAt)))return unavailable();
  evidenceState='attemptedOutcomeUnknown';
  if(o){
   if(!['completed','failed'].includes(r.disposition)||!r.buttonsNeutralized||r.afterFrame===null||r.framesApplied===null||r.framesApplied>p.durationFrames||r.afterFrame-r.beforeFrame!==r.framesApplied||r.completedAt===null||!validator.validate(schema+'GameObservation',o).valid||!gameAdviceMatchesResultPins(advice,o)||!isDeepStrictEqual(o.scope,decision.scope)||o.previousActionId!==r.actionId||!r.resultingObservationIds.includes(o.observationId)||o.frameNumber<r.afterFrame||Date.parse(o.capturedAt)<Date.parse(r.completedAt)||Date.parse(o.receivedAt)<Date.parse(o.capturedAt)||Date.parse(o.receivedAt)>data.nowMs||o.interpretedAt!==null&&(Date.parse(o.interpretedAt)<Date.parse(o.receivedAt)||Date.parse(o.interpretedAt)>data.nowMs)||data.freshUntilMs>Date.parse(o.capturedAt)+data.maximumObservationAgeMs||new Set(o.screenshots.map(f=>f.screenshotId)).size!==o.screenshots.length||o.screenshots.some(f=>f.frameNumber!==o.frameNumber||f.capturedAt!==o.capturedAt)||o.facts.some(f=>f.sourceScreenshotIds.some(id=>!o.screenshots.some(s=>s.screenshotId===id))))return unavailable();
   evidenceState='observedAttempt';
  }
 }else if(!gameDecisionMatchesPreparedContext(game,binding,decision)||p&&!gameProposalMatchesPreparedContext(game,binding,decision,p))return unavailable();
 freeze(data);const host=Object.freeze({...ports}),clock=host.now??Date.now;let revision:string|null=null;try{revision=host.boundaryRevision();}catch{}if(typeof revision!=='string'||!revision.trim()||Buffer.byteLength(revision)>1024)return unavailable();
 const monoDeadline=performance.now()+data.freshUntilMs-data.nowMs;let last=data.nowMs,retired=false,checking=false;
 const isCurrent=()=>{if(retired||checking)return false;checking=true;try{const now=clock();if(!Number.isSafeInteger(now)||now<last||now>=data.freshUntilMs||performance.now()>=monoDeadline||host.boundaryRevision()!==revision||!gameAdviceMatchesDecision(advice,decision)||host.dispositionGroundedCurrent(decision,data)!==true||r&&(!p||!a||host.receiptCurrent(decision,p,a,r)!==true)||o&&(!r||host.outcomeCurrent(r,o,data.reason)!==true)||!r&&(!gameDecisionMatchesPreparedContext(game,binding,decision)||p&&!gameProposalMatchesPreparedContext(game,binding,decision,p))){retired=true;return false;}const after=clock();if(!gameAdviceMatchesDecision(advice,decision)||host.boundaryRevision()!==revision||!Number.isSafeInteger(after)||after<now||after>=data.freshUntilMs||performance.now()>=monoDeadline){retired=true;return false;}last=after;return true;}catch{retired=true;return false;}finally{checking=false;}};
 if(!isCurrent())return unavailable();
 const h=createHash('sha256').update(JSON.stringify([advice.adviceRef,decision.viewId,p?.proposalId,data.disposition,r?.actionId,o?.observationId])).digest('hex'),entryId=`${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
 const limitations=['Attributed advice disposition is not proof the advice works or caused the visible result.','Proposal without an actually started receipt is planned only; missing result evidence remains unknown.','Historical attribution grants no current controller, resume, contact or memory reinforcement authority.'];
 const entry:G.CampaignJournal['entries'][number]=freeze({entryId,kind:r?'attemptOutcome':data.disposition==='used'?'nextStep':'unresolvedThread',epistemicKind:o?'observation':'inference',content:`Advice ${data.disposition}; evidence ${evidenceState}. ${data.reason}`,sourceRefs:[advice.adviceRef!,`game-decision:${decision.viewId}:${decision.viewRevision}`,`game-observation:${decision.observationId}:${decision.observationRevision}`,...(r?[`game-admission:${r.admissionId}`,`game-action:${r.actionId}:${r.inputDigest}`]:[]),...(o?[`game-observation:${o.observationId}:${o.revision}`]:[])],sourceSessionRef:decision.scope.contextBinding.sessionId,recordedAt:new Date(data.nowMs).toISOString(),limitations});
 const content=JSON.stringify({sourceKind:'simulatedGameAdviceDisposition',untrusted:true,scope:decision.scope,adviceRef:advice.adviceRef,decisionViewId:decision.viewId,disposition:data.disposition,evidenceState,reason:data.reason,actionId:r?.actionId??null,resultingObservationId:o?.observationId??null,limitations});
 if(!validator.validate(schema+'CampaignJournal/properties/entries/items',entry).valid||Buffer.byteLength(content)>data.maximumBytes||!isCurrent())return unavailable();return freeze({state:'selected',evidenceState,entry,content,isCurrent,adviceSuccessEstablished:false,playAuthority:false,resumeAuthority:false,sendAuthority:false});
}
