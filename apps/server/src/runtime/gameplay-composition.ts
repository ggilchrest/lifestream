import type {Database} from '@lifestream/storage-sqlite';
import {createSupervisedGameRuntime,type SupervisedGameNative} from '../../../../scripts/supervised-game-runtime.mjs';
import {createGameCampaignOwner,type GameCampaignOwnerSource} from './game-campaign-owner.ts';
import {createGameplayGrounding,type GameplayGroundingOptions} from './gameplay-grounding.ts';
import {createGameInferenceQualificationBinding,type GameQualificationBindingOptions} from './gameplay-qualification.ts';
import type {GameRuntimeOptions} from './game-host-runtime.ts';
import type {GameHostOptions} from './game-host-port.ts';

type OwnerOptions=Parameters<typeof createGameCampaignOwner>[0];
/** Trusted main/operator composition. Explicit enrollment, actual-save
 * reconciliation and capability admission come from their existing owners. */
export type GameplayCompositionOptions={
 native:SupervisedGameNative;
 nativeEvidence:NonNullable<GameHostOptions['nativeEvidence']>;
 maximumOwnedFrames:number;
 campaign:Omit<OwnerOptions,'source'> & {source:Omit<GameCampaignOwnerSource,'episodeFor'|'retentionFor'>};
 grounding:Omit<GameplayGroundingOptions,'database'|'journal'|'publicationCurrent'>;
 qualification:GameQualificationBindingOptions;
 resolveApproval:GameRuntimeOptions['resolveApproval'];
 maximumSteps:number;maximumRunMs:number;maximumCommandMs:number;
 onStatus?:(status:Readonly<Record<string,unknown>>)=>void;
};

/** Wire the existing authenticated runtime/coordinator, durable campaign owner
 * and governed memory lane. Construction alone has no provider/native effects. */
export function createGameplayComposition(options:GameplayCompositionOptions,database:()=>Database){
 if(typeof options.nativeEvidence?.qualifyUsage!=='function'||typeof options.nativeEvidence?.qualifyShutdown!=='function'||!Number.isSafeInteger(options.maximumOwnedFrames)||options.maximumOwnedFrames<1||options.maximumOwnedFrames>64)throw Error('Missing qualified native evidence composition');
 const qualification=createGameInferenceQualificationBinding(options.qualification);
 const source=options.campaign.source,sourcePins={...source},campaignPins={...source.campaignBoundary},dispatchPins={...source.dispatchBoundary};
 const unchanged=()=>Object.entries(sourcePins).every(([k,v])=>(source as any)[k]===v)&&Object.entries(campaignPins).every(([k,v])=>(source.campaignBoundary as any)[k]===v)&&Object.entries(dispatchPins).every(([k,v])=>(source.dispatchBoundary as any)[k]===v);
 const current=(scope:Parameters<typeof source.current>[0])=>unchanged()&&sourcePins.current(scope);
 const grounding=createGameplayGrounding({...options.grounding,database,journal:options.campaign.journal,publicationCurrent:scope=>current(scope)&&options.native.sourceCurrent(scope)});
 const owner=createGameCampaignOwner({...options.campaign,journal:grounding.journal,source:{...sourcePins,current,episodeFor:grounding.episodeFor,retentionFor:grounding.retentionFor}});
 const supervised=createSupervisedGameRuntime({native:options.native,campaign:owner.campaign,createRepository:owner.createRepository,resolveApproval:options.resolveApproval,memory:{options:grounding.memory,retentionConsentRefFor:owner.retentionConsentRefFor},inferenceQualificationFor:qualification,maximumSteps:options.maximumSteps,maximumRunMs:options.maximumRunMs,maximumCommandMs:options.maximumCommandMs,requireJoinedNativeEvidence:true,...(options.onStatus?{onStatus:options.onStatus}:{})});
 return Object.freeze({...supervised,gameHost:Object.freeze({...supervised.gameHost,ownedFrames:true as const,maximumOwnedFrames:options.maximumOwnedFrames,nativeEvidence:options.nativeEvidence,onAttached:(join:Parameters<NonNullable<typeof supervised.gameHost.onAttached>>[0])=>{supervised.gameHost.onAttached!(join);void supervised.completion().finally(grounding.clearPending);}}),stop:async()=>{try{await supervised.stop();}finally{grounding.clearPending();}}});
}
