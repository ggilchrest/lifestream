import {createHash} from 'node:crypto';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type {GameBounds} from '@lifestream/contracts/game-activity';
import type {CanonicalCtConfigurationPin} from './canonical-ct-configuration.ts';
import {resolve,basename,join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {C72_STATE,C72_CONTINUATION} from '@lifestream/providers-bizhawk/c72-native-configuration';
import {captureGameSanityTiming} from '@lifestream/providers-bizhawk';

const fail=():never=>{throw Error('Pinned native-observation configuration unavailable');};
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const fields=['schemaVersion','sessionProfile','template','profile','maximumRunMs','maximumObservations','maximumCommandMs','pinsDigest','providerRef','nativeInstallation','nativePreparation','nativeLaunch'];
/** Existing native wire requires positive protocol ceilings. These do NOT
 * grant effects/planning: the separate owner exposes observe only and installs
 * no controller, broker, campaign, model, memory or frame-approval owner. */
export const nativeObservationWireBounds:Readonly<GameBounds>=Object.freeze({maxActionFrames:1,maxInputLeaseMs:1,maxActionWallMs:1,maxScreenshotBytes:2097152,maxScreenshotLongEdge:1024,wallBudgetMs:90000,frameBudget:1,actionBudget:1,startBudget:1,equivalentFailureBudget:1,screenshotQueueByteBudget:4194304,modelCallBudget:1,inputTokenBudget:1,outputTokenBudget:1,retryBudget:0,checkpointByteBudget:1,memoryEpisodeBudget:0,decisionDeadlineMs:3000,renderedSpeedFactor:1,fastForwardEnabled:false,rewindEnabled:false,planningClockPolicy:'pausesBetweenActions',maxPlanningAgeMs:10000,maxPlanningFrameDelta:1});
export function captureNativeObservationConfiguration(raw:unknown):any{
 const v=boundedGameDataSnapshot(raw,65536) as any;
 if(!v||Array.isArray(v)||Object.keys(v).filter(key=>key!=='sanityTiming').sort().join(',')!==[...fields].sort().join(',')||v.schemaVersion!=='ct-native-observation/1'||v.sessionProfile!=='nativeObservationOnly'||!Number.isSafeInteger(v.maximumRunMs)||v.maximumRunMs<1000||v.maximumRunMs>90000||!Number.isSafeInteger(v.maximumObservations)||v.maximumObservations<1||v.maximumObservations>8||!Number.isSafeInteger(v.maximumCommandMs)||v.maximumCommandMs<1||v.maximumCommandMs>120000||!/^[a-f0-9]{64}$/.test(v.pinsDigest)||typeof v.providerRef!=='string'||!v.providerRef||v.providerRef.length>500||v.nativeInstallation?.kind!=='c72-container'||v.nativeLaunch?.host!=='127.0.0.1'||v.nativeLaunch?.port!==43187)fail();
 try{captureGameSanityTiming(v.sanityTiming);}catch{fail();}
 if(!v.template||!['principalId','assistantId','relationshipId','environmentId','activityId','runId','timelineId','campaignId'].every(k=>uuid(v.template[k]))||!uuid(v.profile?.profileId)||!Number.isSafeInteger(v.profile?.revision)||v.profile.revision<1)fail();
 if(Object.keys(v.template).sort().join(',')!=='activityEpoch,activityId,assistantId,campaignId,environmentId,observationDomain,ownerPermissionRef,principalId,relationshipId,runId,timelineId,timelineRevision'||!['activityEpoch','timelineRevision'].every(k=>Number.isSafeInteger(v.template[k])&&v.template[k]>=1)||v.template.observationDomain!=='simulatedGame'||typeof v.template.ownerPermissionRef!=='string'||!v.template.ownerPermissionRef.trim()||v.template.ownerPermissionRef.length>1024)fail();
 if(Object.keys(v.nativeLaunch).sort().join(',')!=='continuation,host,port'||!isDeepStrictEqual(v.nativeLaunch.continuation,{path:C72_STATE,...C72_CONTINUATION}))fail();
 if(Object.keys(v.nativeInstallation).sort().join(',')!=='configurationFile,kind'||Object.keys(v.nativePreparation??{}).sort().join(',')!=='stateRoot,templateFile,templateSha256'||Object.keys(v.profile).sort().join(',')!=='profileId,revision')fail();
 const p=v.nativePreparation;
 if(typeof p.stateRoot!=='string'||resolve(p.stateRoot)!==p.stateRoot||!/^ct-native-observation-[A-Za-z0-9-]+$/.test(basename(p.stateRoot))||typeof p.templateFile!=='string'||resolve(p.templateFile)!==p.templateFile||!/^[a-f0-9]{64}$/.test(p.templateSha256)||v.nativeInstallation.configurationFile!==join(p.stateRoot,'observation-facts',v.template.runId+'.json'))fail();
 return freeze(v);
}
export function captureCanonicalNativeObservationOptions(bytes:Uint8Array,pin:CanonicalCtConfigurationPin):Readonly<{ubuntuNativeObservation:unknown}>{
 if(!(bytes instanceof Uint8Array)||bytes.byteLength<2||bytes.byteLength>65536||!pin||!/^[a-f0-9]{64}$/.test(pin.configurationSha256)||createHash('sha256').update(bytes).digest('hex')!==pin.configurationSha256)fail();
 let v:any;try{v=captureNativeObservationConfiguration(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}catch{fail();}
 for(const k of ['principalId','assistantId','relationshipId','environmentId'] as const)if(!uuid(pin[k])||v.template[k]!==pin[k])fail();
 if(v.profile.profileId!==pin.profileId||v.profile.revision!==pin.profileRevision)fail();
 return freeze({ubuntuNativeObservation:v});
}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;}
