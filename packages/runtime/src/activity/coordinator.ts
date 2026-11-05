import {createHash} from 'node:crypto';
import type {GameActionIntent} from '../inference/game-intent-format.ts';
import type * as G from '@lifestream/contracts/game-activity';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import {admitGamePlanningContext,bindGameActionIntent,gameDecisionInput,gameProposalMatchesPreparedContext,gameCampaignConversationContent,type PreparedGameCampaignContext} from './game-journal.ts';
import {requestForFinalizedTurn,finalizedTurnDeadlineCurrent,finalizedTurnSourcesCurrent,type FinalizedTurn,type PreparedTurnBinding} from '../inference/prompt.ts';
import type {InferenceProvider} from '../inference/port.ts';
import type {BackgroundWork,BackgroundResult} from '../understanding/coordinator.ts';
export type GamePlanningBounds=Readonly<{maximumInputTokens:number;maximumOutputTokens:number;maximumOutputBytes:number;maximumChunks:number;deadlineMs:number}>;
export type GamePlanningResult=Readonly<{decisionInput:G.GameDecisionInput;proposal:G.GameActionProposal|null;inputTokens:number;outputTokens:number;tokenizerIdentity:string;intentEvidence:Readonly<{format:'game-action-intent:1.0.0';interactionId:string;rawTextSha256:string;intent:GameActionIntent|null;proposalSha256:string}>}>;
export type GamePlanningHost={
 /** The existing runtime's single optional-work coordinator, not a new lane. */
 run:<T>(work:BackgroundWork<T>)=>Promise<BackgroundResult>;
 current:()=>boolean;
 /** Required durable once-only reservation for this exact view, provider and
  * finite worst-case token/call budget. Cancellation does not refund effects. */
 admitOnce:(binding:PreparedTurnBinding,bounds:GamePlanningBounds,providerRevision:string)=>boolean;
 /** Owner must persist/CAS only the current inert result. Never dispatch here. */
 publish:(result:GamePlanningResult)=>boolean;
 providerRevision:string;tokenizerIdentity:string;
 providerPreemptionBoundMs?:number;providerSlotReleaseBoundMs?:number;
 now?:()=>number;
};
const fail=()=>new Error('Game planning input or provider result is unavailable');
const bounded=(n:number,max:number)=>Number.isSafeInteger(n)&&n>=1&&n<=max;
/** One meaningful decision through existing cognition and P2 admission. This
 * enrolls no run, controls no game, schedules nothing and sends no contact. */
export async function runGamePlanningTurn(input:{turn:FinalizedTurn;binding:PreparedTurnBinding;game:PreparedGameCampaignContext;provider:InferenceProvider;bounds:GamePlanningBounds},host:GamePlanningHost):Promise<BackgroundResult>{
 const {turn,binding,game,provider}=input;
 gameCampaignConversationContent(game,binding);
 const raw=boundedGameDataSnapshot(input.bounds) as GamePlanningBounds|null;
 if(!raw||Object.keys(raw).sort().join(',')!=='deadlineMs,maximumChunks,maximumInputTokens,maximumOutputBytes,maximumOutputTokens'||!bounded(raw.maximumInputTokens,32768)||!bounded(raw.maximumOutputTokens,4096)||!bounded(raw.maximumOutputBytes,32768)||!bounded(raw.maximumChunks,4096)||!bounded(raw.deadlineMs,120000)||typeof host.providerRevision!=='string'||!host.providerRevision.trim()||Buffer.byteLength(host.providerRevision)>1024||typeof host.tokenizerIdentity!=='string'||!host.tokenizerIdentity.trim()||Buffer.byteLength(host.tokenizerIdentity)>256)throw fail();
 const bounds=Object.freeze(raw),providerRevision=host.providerRevision,tokenizerIdentity=host.tokenizerIdentity,clock=host.now??Date.now,started=clock(),monoDeadline=performance.now()+bounds.deadlineMs;
 if(!Number.isSafeInteger(started)||started<0)throw fail();let lastNow=started,retired=false,publicationComplete=false;
 // Revalidate once at each boundary. Passing the finalized-turn validator back
 // into itself multiplies the underlying authority checks without adding a
 // boundary. No authority result is retained between these calls.
 const clockCurrent=(pending:boolean)=>{if(retired)return false;try{const now=clock();if(!Number.isSafeInteger(now)||now<lastNow||pending&&(now>=started+bounds.deadlineMs||performance.now()>=monoDeadline)||host.providerRevision!==providerRevision||host.tokenizerIdentity!==tokenizerIdentity)return false;lastNow=now;return true;}catch{return false;}};
 const timingCurrent=()=>clockCurrent(true);
 const checkedRequest=()=>{if(retired)throw fail();try{
  if(!timingCurrent())throw fail();
  // requestForFinalizedTurn checks the original entry before and after this
  // callback. Clock/provider checks also bracket callbacks that can mutate them.
  const request=requestForFinalizedTurn(turn,binding,()=>timingCurrent()&&host.current()===true&&timingCurrent());
  if(!timingCurrent())throw fail();
  return request;
 }catch(error){retired=true;throw error;}};
 const current=()=>{try{if(publicationComplete){const valid=clockCurrent(false)&&finalizedTurnSourcesCurrent(turn,binding,()=>clockCurrent(false)&&host.current()===true&&clockCurrent(false));if(!valid)retired=true;return valid;}checkedRequest();return true;}catch{retired=true;return false;}};
 // Prepared-source selection can follow other synchronous owner checks. Let
 // pending native inspection/cancellation I/O run before this admission phase.
 // The original deadline is already fixed; no authority result crosses the yield.
 await new Promise<void>(resolve=>setImmediate(resolve));
 const request=checkedRequest(),view=turn.preparedContext;
 if(request.maximumOutputTokens!==bounds.maximumOutputTokens||!view||request.sections[3]?.content.includes('origin=activityStep;')!==true||request.sections[8]?.content!==''||game.viewId!==view.viewId||game.revision!==view.revision||game.invalidationKey!==view.invalidationKey||request.sections[7]?.contentDigest!==game.conversationSectionDigest)throw fail();
 const deadlineAt=Math.min(started+bounds.deadlineMs,Date.parse(view.freshUntil));
 return host.run<GamePlanningResult>({key:'game-decision:'+binding.viewId+':'+binding.revision,deadlineAt,current,admitOnce:()=>current()&&host.admitOnce(binding,bounds,providerRevision),sharedInference:true,priority:'P2',...(host.providerPreemptionBoundMs===undefined?{}:{providerPreemptionBoundMs:host.providerPreemptionBoundMs}),...(host.providerSlotReleaseBoundMs===undefined?{}:{providerSlotReleaseBoundMs:host.providerSlotReleaseBoundMs}),steps:[async signal=>{
  // Closed, opt-in metadata at the original boundary, before the coordinator
  // fences output and the native owner retires. Never retain model/error text.
  const interactionId=request.scope.interactionId;
  const diagnostics=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1'&&typeof interactionId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(interactionId);
  let phase='input-tokenize',reason='operation_threw',chunks=0,text='';
  const phaseTiming=(stage:string)=>{if(diagnostics)try{console.info(JSON.stringify({event:'game-planning-phase',interactionId,phase:stage,observedAtMs:Date.now()}));}catch{}};
  phaseTiming('input-tokenize-entered');
  const refused=(cause:string)=>{reason=cause;return fail();};
  const fresh=()=>{if(signal.aborted)throw refused('cancelled');try{return checkedRequest();}catch(error){reason='currentness_unavailable';throw error;}};
  // Immediately resolved provider promises still need an I/O turn so native
  // custody refresh and cancellation can progress. Every yield is followed by
  // the same fresh authority checks before an effect or result is accepted.
  const yieldForIo=()=>new Promise<void>(resolve=>setImmediate(resolve));
  const tokenize=async(value:Parameters<NonNullable<InferenceProvider['tokenize']>>[0])=>{await yieldForIo();fresh();if(!provider.tokenize)throw refused('tokenizer_missing');const result=boundedGameDataSnapshot(await provider.tokenize(value,{signal})) as {count:number;identity:string}|null;fresh();if(!result||Object.keys(result).sort().join(',')!=='count,identity'||!bounded(result.count,2147483647)||result.identity!==tokenizerIdentity)throw refused('tokenizer_result_invalid');return result.count;};
  try{
  const inputTokens=await tokenize(request);phaseTiming('input-tokenize-completed');if(inputTokens>bounds.maximumInputTokens)throw refused('input_token_limit');
  phase='decision-input';
  const decisionInput=gameDecisionInput(game,binding,fresh(),inputTokens,clock(),deadlineAt);
  phase='provider-stream';let done=false;await yieldForIo();const admittedRequest=fresh();if(!admitGamePlanningContext(game,binding))throw refused('context_admission_refused');phaseTiming('provider-stream-admitted');
  for await(const rawChunk of provider.generate(admittedRequest,{signal})){await yieldForIo();fresh();const chunk=boundedGameDataSnapshot(rawChunk) as {kind:string;text?:string;sourceChunkCount?:number;error?:{code?:unknown}}|null;const counted=!!chunk&&Object.hasOwn(chunk,'sourceChunkCount');if(counted&&(chunk.kind!=='text'||!Number.isSafeInteger(chunk.sourceChunkCount)||chunk.sourceChunkCount!<1||chunk.sourceChunkCount!>4096))throw refused('chunk_invalid');chunks+=counted?chunk!.sourceChunkCount!:1;if(chunks>bounds.maximumChunks)throw refused('chunk_limit');if(!chunk)throw refused('chunk_invalid');if(chunk.kind==='text'){if(typeof chunk.text!=='string')throw refused('chunk_invalid');if(Buffer.byteLength(text)+Buffer.byteLength(chunk.text)>bounds.maximumOutputBytes)throw refused('output_byte_limit');text+=chunk.text;}else if(chunk.kind==='done'){done=true;break;}else{const code=chunk.kind==='error'?chunk.error?.code:undefined;throw refused(typeof code==='string'&&['response_limit','deadline_exceeded','cancelled','malformed_provider_event','inference_unavailable'].includes(code)?'provider_'+code:'chunk_invalid');}}
  fresh();if(!done)throw refused('terminal_missing');if(!text.trim())throw refused('output_empty');phase='output-tokenize';const outputTokens=await tokenize(text);if(outputTokens>bounds.maximumOutputTokens)throw refused('output_token_limit');
  phase='json-parse';let intent:unknown;try{intent=JSON.parse(text);}catch{throw refused('json_invalid');}
  // JSON null is an explicit no-action decision. Invalid data is not no-action.
  phase='proposal-validation';let proposal:G.GameActionProposal|null;try{proposal=bindGameActionIntent(game,binding,decisionInput,intent);}catch{fresh();throw refused('proposal_invalid');}
  if(proposal!==null&&!gameProposalMatchesPreparedContext(game,binding,decisionInput,proposal))throw refused('proposal_invalid');
  phase='result-current';
  // Drain ready native inspection callbacks before publication starts its
  // synchronous metadata transactions. Requalify the original turn afterward.
  await new Promise<void>(resolve=>setImmediate(()=>setImmediate(resolve)));fresh();const result={decisionInput,proposal,inputTokens,outputTokens,tokenizerIdentity,intentEvidence:{format:'game-action-intent:1.0.0' as const,interactionId,rawTextSha256:createHash('sha256').update(text).digest('hex'),intent:boundedGameDataSnapshot(intent) as GameActionIntent|null,proposalSha256:createHash('sha256').update(JSON.stringify(proposal)).digest('hex')}};
  if(diagnostics)try{console.info(JSON.stringify({event:'game-planning-intent-bound',interactionId,format:result.intentEvidence.format,rawTextSha256:result.intentEvidence.rawTextSha256,proposalSha256:result.intentEvidence.proposalSha256,proposalId:proposal?.proposalId??null}));}catch{}
  return freeze(result);
  }catch(error){
   if(diagnostics)try{console.info(JSON.stringify({event:'game-planning-first-failure',interactionId,phase,reason,chunks,outputBytes:Buffer.byteLength(text)}));}catch{}
   throw error;
  }
 }],publish:result=>{if(!current()||!host.publish(result)||!timingCurrent()||!finalizedTurnDeadlineCurrent(turn,binding))return false;publicationComplete=true;return true;}});
}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
