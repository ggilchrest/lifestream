import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import {gameEpisodeSnapshot} from '@lifestream/contracts/game-memory';
import type {GameExperienceEpisode,GameHelpItem,GameObservation} from '@lifestream/contracts/game-activity';
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
export type GameHelpSourceInput={item:GameHelpItem;episode:GameExperienceEpisode;observation:GameObservation;maximumBytes:number;maximumObservationAgeMs:number;nowMs:number;freshUntilMs:number};
export type GameHelpSourceBoundary={
 /** Read-only atomic revision of the joined owner/source/pause/configuration/
  * attachment boundary; no semantic callback may bypass a changed revision. */
 boundaryRevision:()=>string|null;
 /** Actual retained episode/source and its separate memory/privacy consent. */
 episodeCurrent:(episode:Readonly<GameExperienceEpisode>)=>boolean;
 observationCurrent:(observation:Readonly<GameObservation>)=>boolean;
 /** A native pause qualification plus current lifecycle; metadata is insufficient. */
 pauseCurrent:(scope:Readonly<GameHelpItem['scope']>)=>boolean;
 /** Exact independently configured channel/recipient/policy metadata. This is
  * neither current send authority nor an assertion that contact hours are open. */
 configuredRecipientCurrent:(item:Readonly<GameHelpItem>)=>boolean;
 /** Grounding/relevance of this question in the recorded visible problem. */
 questionGroundedCurrent:(item:Readonly<GameHelpItem>,episode:Readonly<GameExperienceEpisode>,observation:Readonly<GameObservation>)=>boolean;
 /** Separate bounded attachment custody/retention/access, when present. */
 attachmentCurrent:(item:Readonly<GameHelpItem>,observation:Readonly<GameObservation>)=>boolean;
 now?:()=>number;
};
export type GameHelpSourceSelection=Readonly<{state:'prepared'|'unavailable';content:string|null;digest:string|null;helpId:string|null;freshUntilMs:number|null;isCurrent:()=>boolean;sendAuthority:false;resumeAuthority:false}>;
/** An inert lower-trust source projection only. No message, attachment, action,
 * pending-item persistence, contact grant or lifecycle transition is performed. */
export function selectGameHelpSource(raw:GameHelpSourceInput,boundary:GameHelpSourceBoundary):GameHelpSourceSelection{
 const unavailable=():GameHelpSourceSelection=>freeze({state:'unavailable',content:null,digest:null,helpId:null,freshUntilMs:null,isCurrent:()=>false,sendAuthority:false,resumeAuthority:false});
 const input=boundedGameDataSnapshot(raw,131072) as GameHelpSourceInput|null;
 if(!input||Object.keys(input).sort().join(',')!=='episode,freshUntilMs,item,maximumBytes,maximumObservationAgeMs,nowMs,observation'||!positive(input.maximumBytes,8192)||!positive(input.maximumObservationAgeMs,120000)||!Number.isSafeInteger(input.nowMs)||input.nowMs<0||!Number.isSafeInteger(input.freshUntilMs))return unavailable();
 const episode=gameEpisodeSnapshot(input.episode,input.nowMs),item=input.item,o=input.observation;
 if(!episode||!validator.validate(schema+'GameHelpItem',item).valid||!validator.validate(schema+'GameObservation',o).valid||!['queued','deferred'].includes(item.status)||!isDeepStrictEqual(item.scope,episode.scope)||!isDeepStrictEqual(o.scope,episode.scope)||o.pinsDigest!==episode.pinsDigest||item.attemptsSummary!==episode.summary||item.question.trim().length===0||Date.parse(item.queuedAt)>input.nowMs||Date.parse(item.queuedAt)<Date.parse(episode.recordedAt))return unavailable();
 // Exact original attempts/result references; a paraphrase or reload is not a
 // new source family. Source host already joins actually started admissions.
 if(!sameIds(item.attemptedActionIds,episode.sourceActionIds)||!sameIds(item.sourceObservationIds,episode.sourceObservationIds)||!item.sourceObservationIds.includes(o.observationId)||o.frameNumber<episode.frameRange.from||o.frameNumber>episode.frameRange.to||o.capturedAt!==episode.occurredTo)return unavailable();
 if([item.sentAt,item.messageSentEvidenceRef,item.attachmentSentEvidenceRef,item.deliveryEvidenceRef,item.replyAdviceRef,item.authenticatedReplyEvidenceRef,item.attachmentTransferredEvidenceRef,item.attachmentDeliveryEvidenceRef].some(v=>v!==null)||item.attachmentStatus!=='queued')return unavailable();
 const captured=Date.parse(o.capturedAt),received=Date.parse(o.receivedAt);
 if(captured>received||received>input.nowMs||o.interpretedAt!==null&&(Date.parse(o.interpretedAt)<received||Date.parse(o.interpretedAt)>input.nowMs)||input.freshUntilMs<=input.nowMs||input.freshUntilMs>Math.min(captured+input.maximumObservationAgeMs,Date.parse(episode.expiresAt)))return unavailable();
 if(new Set(o.screenshots.map(s=>s.screenshotId)).size!==o.screenshots.length||o.facts.some(f=>f.sourceScreenshotIds.some(id=>!o.screenshots.some(s=>s.screenshotId===id))))return unavailable();
 const screenshot=item.screenshot;
 if(item.screenshotStatus==='ready'&&screenshot===null||item.screenshotStatus!=='ready'&&screenshot!==null)return unavailable();
 if(screenshot){const frame=o.screenshots.find(f=>f.screenshotId===screenshot.screenshotId);if(!frame||screenshot.observationId!==o.observationId||screenshot.activityId!==item.scope.activityId||screenshot.runId!==item.scope.runId||screenshot.timelineId!==item.scope.timelineId||screenshot.frameNumber!==o.frameNumber||screenshot.capturedAt!==o.capturedAt||(['sha256','byteLength','mediaType','width','height']as const).some(k=>screenshot[k]!==frame[k])||screenshot.attachmentArtifact.sha256!==screenshot.sha256||screenshot.attachmentArtifact.byteLength!==screenshot.byteLength||screenshot.attachmentArtifact.mediaType!==screenshot.mediaType||Date.parse(screenshot.expiresAt)<input.freshUntilMs||screenshot.ageAtSendMs!==null||screenshot.captureTimeDisclosed!==false)return unavailable();}
 freeze(input);freeze(episode);
 const host=Object.freeze({...boundary}),clock=host.now??Date.now,monoDeadline=performance.now()+input.freshUntilMs-input.nowMs;let last=input.nowMs,retired=false,checking=false,revision:string|null=null;
 try{revision=host.boundaryRevision();}catch{}if(typeof revision!=='string'||!revision.trim()||Buffer.byteLength(revision)>1024)return unavailable();
 const isCurrent=()=>{if(retired||checking)return false;checking=true;try{const now=clock();if(!Number.isSafeInteger(now)||now<last||now>=input.freshUntilMs||performance.now()>=monoDeadline||host.boundaryRevision()!==revision||host.episodeCurrent(episode)!==true||host.observationCurrent(o)!==true||host.pauseCurrent(item.scope)!==true||host.configuredRecipientCurrent(item)!==true||host.questionGroundedCurrent(item,episode,o)!==true||screenshot&&host.attachmentCurrent(item,o)!==true){retired=true;return false;}last=now;const after=clock();if(!Number.isSafeInteger(after)||after<now||after>=input.freshUntilMs||performance.now()>=monoDeadline||host.boundaryRevision()!==revision){retired=true;return false;}last=after;return true;}catch{retired=true;return false;}finally{checking=false;}};
 if(!isCurrent())return unavailable();
 const content=JSON.stringify({sourceKind:'simulatedGameHelp',untrusted:true,helpId:item.helpId,episodeId:episode.episodeId,episodeRevision:episode.revision,scope:item.scope,pinsDigest:o.pinsDigest,attemptedActionIds:item.attemptedActionIds,sourceObservationIds:item.sourceObservationIds,occurredFrom:episode.occurredFrom,occurredTo:episode.occurredTo,attemptsSummary:item.attemptsSummary,question:item.question,uncertainty:episode.uncertainty,rawEvidenceAvailability:episode.rawEvidenceAvailability,screenshot:screenshot?{screenshotId:screenshot.screenshotId,capturedAt:screenshot.capturedAt,frameNumber:screenshot.frameNumber}:null,screenshotStatus:item.screenshotStatus,attachmentStatus:item.attachmentStatus,imageTransportSupported:item.imageTransportSupported,attachmentLimitation:item.limitation,limitations:['Recorded simulated attempts, not a Human statement, current progress or feelings.','Question and advice cannot grant tools, send contact or resume a run.','No message or image delivery is established by this preparation.']});
 if(Buffer.byteLength(content)>input.maximumBytes||!isCurrent())return unavailable();
 return freeze({state:'prepared',content,digest:createHash('sha256').update(content).digest('hex'),helpId:item.helpId,freshUntilMs:input.freshUntilMs,isCurrent,sendAuthority:false,resumeAuthority:false});
}
const positive=(n:number,max:number)=>Number.isSafeInteger(n)&&n>=1&&n<=max;
const sameIds=(a:string[],b:string[])=>new Set(a).size===a.length&&a.length===b.length&&a.every(id=>b.includes(id));
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const c of Object.values(v))freeze(c);Object.freeze(v);}return v;}
