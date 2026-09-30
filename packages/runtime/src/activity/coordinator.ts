import type * as G from '@lifestream/contracts/game-activity';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import {gameDecisionInput,gameProposalMatchesPreparedContext,gameCampaignConversationContent,type PreparedGameCampaignContext} from './game-journal.ts';
import {requestForFinalizedTurn,type FinalizedTurn,type PreparedTurnBinding} from '../inference/prompt.ts';
import type {InferenceProvider} from '../inference/port.ts';
import type {BackgroundWork,BackgroundResult} from '../understanding/coordinator.ts';
export type GamePlanningBounds=Readonly<{maximumInputTokens:number;maximumOutputTokens:number;maximumOutputBytes:number;maximumChunks:number;deadlineMs:number}>;
export type GamePlanningResult=Readonly<{decisionInput:G.GameDecisionInput;proposal:G.GameActionProposal|null;inputTokens:number;outputTokens:number;tokenizerIdentity:string}>;
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
 if(!raw||Object.keys(raw).sort().join(',')!=='deadlineMs,maximumChunks,maximumInputTokens,maximumOutputBytes,maximumOutputTokens'||!bounded(raw.maximumInputTokens,32768)||!bounded(raw.maximumOutputTokens,4096)||!bounded(raw.maximumOutputBytes,32768)||!bounded(raw.maximumChunks,4096)||!bounded(raw.deadlineMs,30000)||typeof host.providerRevision!=='string'||!host.providerRevision.trim()||Buffer.byteLength(host.providerRevision)>1024||typeof host.tokenizerIdentity!=='string'||!host.tokenizerIdentity.trim()||Buffer.byteLength(host.tokenizerIdentity)>256)throw fail();
 const bounds=Object.freeze(raw),providerRevision=host.providerRevision,tokenizerIdentity=host.tokenizerIdentity,clock=host.now??Date.now,started=clock(),monoDeadline=performance.now()+bounds.deadlineMs;
 if(!Number.isSafeInteger(started)||started<0)throw fail();let lastNow=started,retired=false;
 const current=()=>{if(retired)return false;try{const now=clock();if(!Number.isSafeInteger(now)||now<lastNow||now>=started+bounds.deadlineMs||performance.now()>=monoDeadline||host.providerRevision!==providerRevision||host.tokenizerIdentity!==tokenizerIdentity||host.current()!==true){retired=true;return false;}lastNow=now;requestForFinalizedTurn(turn,binding,host.current);if(host.providerRevision!==providerRevision||host.tokenizerIdentity!==tokenizerIdentity){retired=true;return false;}return true;}catch{retired=true;return false;}};
 const request=requestForFinalizedTurn(turn,binding,current),view=turn.preparedContext;
 if(request.maximumOutputTokens!==bounds.maximumOutputTokens||!view||request.sections[3]?.content.includes('origin=activityStep;')!==true||request.sections[8]?.content!==''||game.viewId!==view.viewId||game.revision!==view.revision||game.invalidationKey!==view.invalidationKey||request.sections[7]?.contentDigest!==game.conversationSectionDigest)throw fail();
 const deadlineAt=Math.min(started+bounds.deadlineMs,Date.parse(view.freshUntil));
 return host.run<GamePlanningResult>({key:'game-decision:'+binding.viewId+':'+binding.revision,deadlineAt,current,admitOnce:()=>current()&&host.admitOnce(binding,bounds,providerRevision),sharedInference:true,priority:'P2',...(host.providerPreemptionBoundMs===undefined?{}:{providerPreemptionBoundMs:host.providerPreemptionBoundMs}),...(host.providerSlotReleaseBoundMs===undefined?{}:{providerSlotReleaseBoundMs:host.providerSlotReleaseBoundMs}),steps:[async signal=>{
  const fresh=()=>{if(signal.aborted||!current())throw fail();return requestForFinalizedTurn(turn,binding,current);};
  const tokenize=async(value:Parameters<NonNullable<InferenceProvider['tokenize']>>[0])=>{fresh();if(!provider.tokenize)throw fail();const result=boundedGameDataSnapshot(await provider.tokenize(value,{signal})) as {count:number;identity:string}|null;fresh();if(!result||Object.keys(result).sort().join(',')!=='count,identity'||!bounded(result.count,2147483647)||result.identity!==tokenizerIdentity)throw fail();return result.count;};
  const inputTokens=await tokenize(request);if(inputTokens>bounds.maximumInputTokens)throw fail();
  const decisionInput=gameDecisionInput(game,binding,fresh(),inputTokens,clock(),deadlineAt);
  let text='',chunks=0,done=false;const admittedRequest=fresh();
  for await(const rawChunk of provider.generate(admittedRequest,{signal})){fresh();const chunk=boundedGameDataSnapshot(rawChunk) as {kind:string;text?:string}|null;if(++chunks>bounds.maximumChunks||!chunk)throw fail();if(chunk.kind==='text'){if(typeof chunk.text!=='string'||Buffer.byteLength(text)+Buffer.byteLength(chunk.text)>bounds.maximumOutputBytes)throw fail();text+=chunk.text;}else if(chunk.kind==='done'){done=true;break;}else throw fail();}
  fresh();if(!done||!text.trim())throw fail();const outputTokens=await tokenize(text);if(outputTokens>bounds.maximumOutputTokens)throw fail();
  let proposal:G.GameActionProposal|null;try{proposal=boundedGameDataSnapshot(JSON.parse(text)) as G.GameActionProposal|null;}catch{throw fail();}
  // JSON null is an explicit no-action decision. Invalid data is not no-action.
  if(proposal===null&&text.trim()!=='null'||proposal!==null&&!gameProposalMatchesPreparedContext(game,binding,decisionInput,proposal))throw fail();
  fresh();const result={decisionInput,proposal,inputTokens,outputTokens,tokenizerIdentity};return freeze(result);
 }],publish:result=>current()&&host.publish(result)});
}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
