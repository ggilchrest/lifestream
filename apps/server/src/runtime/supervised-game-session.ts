import {ORDINARY_GAME_SESSION_LIMITS,ORDINARY_GAMEPLAY} from '@lifestream/contracts/game-host';
import type {GameBounds} from '@lifestream/contracts/game-activity';
import {captureGameSanityTiming,type GameSanityTimingInput} from '@lifestream/providers-bizhawk';

/** Trusted host profiles, never selected by model output or Start wire fields. */
export const supervisedSessionBounds:Readonly<GameBounds>=Object.freeze({
 maxActionFrames:12,maxInputLeaseMs:500,maxActionWallMs:500,maxScreenshotBytes:2097152,maxScreenshotLongEdge:1024,
 wallBudgetMs:90000,frameBudget:108,actionBudget:8,startBudget:1,equivalentFailureBudget:1,screenshotQueueByteBudget:4194304,
 modelCallBudget:8,inputTokenBudget:65536,outputTokenBudget:8192,retryBudget:0,checkpointByteBudget:294912,memoryEpisodeBudget:0,
 decisionDeadlineMs:3000,renderedSpeedFactor:1,fastForwardEnabled:false,rewindEnabled:false,
 planningClockPolicy:'pausesBetweenActions',maxPlanningAgeMs:10000,maxPlanningFrameDelta:12
});
export function finiteSupervisedGameConfiguration(value:{ordinarySessionLifetime?:string;sessionProfile?:string;inferenceMode?:string;goalMode?:string;gameFrameVision?:unknown;maximumRunMs:number;maximumPlanningSteps:number;campaign?:{bounds?:GameBounds};planningBounds?:{deadlineMs:number;maximumInputTokens:number;maximumOutputTokens:number};sanityTiming?:GameSanityTimingInput}):boolean{
 const b=value.campaign?.bounds;
 if(value.ordinarySessionLifetime!==undefined&&!['authorityBound','finiteDiagnostic','sessionScoped'].includes(value.ordinarySessionLifetime))return false;
 if(['authorityBound','sessionScoped'].includes(value.ordinarySessionLifetime??'')&&(value.sessionProfile!=='supervised8'||value.inferenceMode!=='supervisedForeground'||value.goalMode!=='observedGameplay'||value.gameFrameVision===undefined))return false;
 if(!b||!Number.isSafeInteger(value.maximumRunMs)||value.maximumRunMs<1||value.maximumRunMs>120000||b.startBudget!==1||b.memoryEpisodeBudget!==0||b.retryBudget!==0||b.maxActionFrames>12||b.maxActionWallMs>500||b.wallBudgetMs>120000)return false;
 if(value.sessionProfile===undefined||value.sessionProfile==='qualification')return value.maximumPlanningSteps===1&&b.actionBudget===1&&b.modelCallBudget===1&&b.planningClockPolicy==='continuesNormally';
 // The observed-gameplay host may select the existing finite 120-second
 // ceiling before a new run. Both reviewed clocks must agree; this never
 // renews an in-flight run or changes independent grant/input/source limits.
 const observedWindow=value.maximumRunMs===120000&&b.wallBudgetMs===120000&&value.maximumPlanningSteps===1&&value.goalMode==='observedGameplay'&&value.gameFrameVision!==undefined&&value.planningBounds?.maximumInputTokens===6080&&value.planningBounds.maximumOutputTokens===2048;
 if(value.sessionProfile!=='supervised8'||value.inferenceMode!=='supervisedForeground'||value.maximumRunMs!==90000&&!observedWindow||value.maximumPlanningSteps!==1&&value.maximumPlanningSteps!==8)return false;
 let timing;try{timing=captureGameSanityTiming(value.sanityTiming);}catch{return false;}
 // Accept preserved configuration encodings as well as the explicit sanity
 // policy. Only timing fields may differ; every effect/resource limit stays exact.
 return Object.entries(supervisedSessionBounds).every(([key,limit])=>{
  const actual=(b as unknown as Record<string,unknown>)[key];
  return actual===limit||observedWindow&&key==='wallBudgetMs'&&actual===120000||key==='decisionDeadlineMs'&&actual===timing.planningTimeoutMs||key==='maxPlanningAgeMs'&&actual===timing.observationFreshnessMs;
 })&&
 !!value.planningBounds&&(value.planningBounds.deadlineMs===3000||value.planningBounds.deadlineMs===timing.planningTimeoutMs)&&(value.planningBounds.maximumInputTokens===8192&&value.planningBounds.maximumOutputTokens===1024||
  value.planningBounds.maximumInputTokens===6080&&value.planningBounds.maximumOutputTokens===2048&&value.maximumPlanningSteps===1&&value.goalMode==='observedGameplay'&&value.gameFrameVision!==undefined);
}
/** Compatibility decoding never keeps the old implementation watchdogs live.
 * This changes read/model sanity limits only, not consent, expiry or effects. */
export function applySupervisedGameSanityTiming(configuration:any){
 const sanityTiming=captureGameSanityTiming(configuration.sanityTiming);
 if(configuration.sessionProfile!=='supervised8')return {...configuration,sanityTiming,maximumCommandMs:sanityTiming.commandRoundTripTimeoutMs,maximumObservationAgeMs:sanityTiming.observationFreshnessMs,
  ...(configuration.planningBounds?{planningBounds:{...configuration.planningBounds,deadlineMs:sanityTiming.planningTimeoutMs}}:{})};
 return {...configuration,sanityTiming,maximumCommandMs:sanityTiming.commandRoundTripTimeoutMs,maximumObservationAgeMs:sanityTiming.observationFreshnessMs,
  planningBounds:{...configuration.planningBounds,deadlineMs:sanityTiming.planningTimeoutMs},
  campaign:{...configuration.campaign,bounds:{...configuration.campaign.bounds,decisionDeadlineMs:sanityTiming.planningTimeoutMs,maxPlanningAgeMs:sanityTiming.observationFreshnessMs}}};
}

/** Create terms only for a NEW ordinary Play. No old grant or run is renewed. */
export function ordinaryGameSessionConfiguration(configuration:any){
 if(configuration.ordinarySessionLifetime!=='sessionScoped')return configuration;
 const p=ORDINARY_GAME_SESSION_LIMITS;
 return {...configuration,ordinaryGameplay:'continuous',planningBounds:{...configuration.planningBounds,maximumOutputTokens:512},maximumRunMs:p.maximumMs,maximumPlanningSteps:p.decisions,maximumControllerGrantMs:p.maximumMs,
  nativePreparation:{...configuration.nativePreparation,maximumNativeLifetimeMs:p.maximumMs,sessionLifetime:'sessionScoped'},
  metadataRetentionMs:Math.max(configuration.metadataRetentionMs,p.maximumMs+3600000),
  campaign:{...configuration.campaign,bounds:{...configuration.campaign.bounds,maxActionFrames:ORDINARY_GAMEPLAY.maximumHoldFrames,maxActionWallMs:ORDINARY_GAMEPLAY.maximumHoldMs,maxInputLeaseMs:ORDINARY_GAMEPLAY.maximumHoldMs,planningClockPolicy:'continuesNormally',wallBudgetMs:p.maximumMs,actionBudget:p.actions,modelCallBudget:p.modelCalls,frameBudget:p.frames,inputTokenBudget:p.inputTokens,outputTokenBudget:p.outputTokens,checkpointByteBudget:p.checkpointBytes}}};
}
