import {createHash} from 'node:crypto';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import {finiteSupervisedGameConfiguration} from './supervised-game-session.ts';
import {captureReviewedGameScene} from './reviewed-game-scene.ts';
import {captureReviewedDialogueProfile} from './reviewed-dialogue-profile.ts';
import {captureCtVisibleGoalPolicy} from './ct-visible-goal-policy.ts';
import {captureGameSanityTiming} from '@lifestream/providers-bizhawk';

export type CanonicalCtConfigurationPin=Readonly<{
 configurationSha256:string;principalId:string;assistantId:string;relationshipId:string;
 environmentId:string;profileId:string;profileRevision:number;
}>;
const keys=['attach','campaign','inferenceMode','inferenceQualificationFile','initialDialogue','maximumCommandMs','maximumContextBytes','maximumObservationAgeMs','maximumPlanningSteps','maximumRunMs','metadataRetentionMs','nativeInstallation','nativeLaunch','nativePreparation','planningBounds','profile','sessionProfile','startLimits','template'];
const fail=():never=>{throw Error('Pinned canonical CT configuration unavailable');};
/** Pure optional launcher seam. The canonical launcher owns bounded owner-only
 * file reading and selection of the exact reviewed pin. This function opens no
 * state, authenticates nobody, creates no native request or controller grant,
 * and returns only the CT option. Existing Daily/provider/memory options stay
 * with Main. A missing scene corpus remains unavailable in the backend. */
export function captureCanonicalCtOptions(bytes:Uint8Array,pin:CanonicalCtConfigurationPin):Readonly<{ubuntuGame:unknown}>{
 if(!(bytes instanceof Uint8Array)||bytes.byteLength<2||bytes.byteLength>262144||!pin||!/^[a-f0-9]{64}$/.test(pin.configurationSha256)||createHash('sha256').update(bytes).digest('hex')!==pin.configurationSha256)fail();
 let value:any;try{value=boundedGameDataSnapshot(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),262144);}catch{fail();}
 if(!value||Array.isArray(value)||keys.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!keys.includes(k)&&k!=='reviewedSceneProfile'&&k!=='reviewedDialogueProfile'&&k!=='goalMode'&&k!=='gameFrameVision'&&k!=='sanityTiming'&&k!=='maximumControllerGrantMs'&&k!=='ordinarySessionLifetime'))fail();
 if(value.sessionProfile!=='supervised8'||value.inferenceMode!=='supervisedForeground'||!finiteSupervisedGameConfiguration(value))fail();
 try{captureCtVisibleGoalPolicy(value);captureGameSanityTiming(value.sanityTiming);}catch{fail();}
 if(value.maximumControllerGrantMs!==undefined&&(!Number.isSafeInteger(value.maximumControllerGrantMs)||value.maximumControllerGrantMs<1||value.maximumControllerGrantMs>300000))fail();
 if(value.gameFrameVision!==undefined&&(value.goalMode!=='observedGameplay'||value.reviewedSceneProfile!==undefined))fail();
 if(value.goalMode==='observedGameplay'&&value.gameFrameVision===undefined)fail();
 if(value.reviewedDialogueProfile!==undefined){
  if(value.goalMode!=='observedGameplay'||value.gameFrameVision===undefined||value.reviewedSceneProfile!==undefined)fail();
  captureReviewedDialogueProfile(value.reviewedDialogueProfile);
 }
 for(const key of ['principalId','assistantId','relationshipId','environmentId'] as const)if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(pin[key])||value.template?.[key]!==pin[key])fail();
 if(value.profile?.profileId!==pin.profileId||value.profile?.revision!==pin.profileRevision||!Number.isSafeInteger(pin.profileRevision)||pin.profileRevision<1||value.nativeInstallation?.kind!=='c72-container'||value.nativeLaunch?.host!=='127.0.0.1')fail();
 if(value.reviewedSceneProfile!==undefined)captureReviewedGameScene(value.reviewedSceneProfile);
 return freeze({ubuntuGame:value});
}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
