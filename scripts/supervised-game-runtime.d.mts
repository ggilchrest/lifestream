import type {ActivityCheckpointRepository} from '@lifestream/storage-sqlite';
import type {GameExperienceEpisode} from '@lifestream/contracts/game-activity';
import type {GameCampaignContextSelection} from '@lifestream/runtime/activity/game-journal';
import type {GamePlanningBounds} from '@lifestream/runtime/activity/coordinator';
import type {BackgroundResult} from '@lifestream/runtime/understanding/coordinator';
import type {GameHostOptions,GameHostJoin} from '../apps/server/src/runtime/game-host-port.ts';
import type {GameRuntimeOptions,PreparedHostGameStep,HostGamePlanningPublication} from '../apps/server/src/runtime/game-host-runtime.ts';
import type {CheckpointedGameControllerPorts} from '../apps/server/src/runtime/game-activity.ts';

export type SupervisedGameNative={
 resolveAttachment:GameHostOptions['resolveAttachment'];
 bindingCurrent:GameHostOptions['bindingCurrent'];
 waitForObservationChange?:(join:GameHostJoin,step:PreparedHostGameStep,repository:ActivityCheckpointRepository,signal:AbortSignal)=>Promise<boolean>;
 controllerCurrent:GameHostOptions['controllerCurrent'];
 sourceCurrent:GameRuntimeOptions['sourceCurrent'];
 sourceAvailable:GameHostOptions['boundary']['sourceAvailable'];
 acceptObservation:NonNullable<GameHostOptions['boundary']['acceptObservation']>;
 acceptAction:NonNullable<GameHostOptions['boundary']['acceptAction']>;
 reconcileEffect:NonNullable<GameHostOptions['boundary']['reconcileEffect']>;
 admitRelease:NonNullable<GameHostOptions['boundary']['admitRelease']>;
 usageFor:CheckpointedGameControllerPorts['usageFor'];
 shutdownExactOldLease:(join:GameHostJoin)=>Promise<boolean>;
};
export type SupervisedGameCampaign={
 resourceExhausted?:()=>boolean;
 selectPlanning:(join:GameHostJoin,repository:ActivityCheckpointRepository,signal:AbortSignal)=>Promise<{selection:GameCampaignContextSelection;bounds:GamePlanningBounds}|null>;
 planningCurrent:HostGamePlanningPublication['current'];
 terminalRef:(result:Parameters<HostGamePlanningPublication['terminalRef']>[0],step?:PreparedHostGameStep)=>string|null;
 publishDecision:(result:Parameters<HostGamePlanningPublication['publishDecision']>[0],step?:PreparedHostGameStep)=>boolean;
 prepareController:(join:GameHostJoin,step:PreparedHostGameStep,outcome:BackgroundResult,repository:ActivityCheckpointRepository,signal:AbortSignal)=>Promise<Parameters<GameHostJoin['runController']>[0]|Readonly<{kind:'reobserve'}>|null>;
 controllerCurrent:GameHostOptions['controllerCurrent'];
 recordSettledStep:(join:GameHostJoin,controller:Parameters<GameHostJoin['runController']>[0],result:Awaited<ReturnType<GameHostJoin['runController']>>,repository:ActivityCheckpointRepository,signal?:AbortSignal)=>Promise<{journalCommitted:true;goalReached?:true;episode?:GameExperienceEpisode}|null>;
};
export type SupervisedGameCompletion=Readonly<{orderly:boolean;nativeShutdownConfirmed:boolean}>;
/** Checks a genuine settled receipt; this does not authorize further execution. */
export function isOrderlySupervisedGameCompletion(value:unknown):value is SupervisedGameCompletion;
export function createSupervisedGameRuntime(options:{
 native:SupervisedGameNative;campaign:SupervisedGameCampaign;
 createRepository:GameHostOptions['createRepository'];resolveApproval:GameRuntimeOptions['resolveApproval'];
 memory?:GameRuntimeOptions['memory'];inferenceQualificationFor?:GameRuntimeOptions['inferenceQualificationFor'];
 inferenceMode?:GameRuntimeOptions['inferenceMode'];sessionLifetime?:GameRuntimeOptions['sessionLifetime'];
 maximumSteps:number;maximumRunMs:number;maximumCommandMs:number;
 onStatus?:(status:Readonly<Record<string,unknown>>)=>void;
 /** Fixed synchronous owner callback, once before orderly/explicit shutdown. */
 onRetire?:()=>void;
}):Readonly<{gameHost:GameHostOptions;gameRuntime:GameRuntimeOptions;current:()=>boolean;stop:()=>Promise<void>;completion:()=>Promise<SupervisedGameCompletion>}>;
