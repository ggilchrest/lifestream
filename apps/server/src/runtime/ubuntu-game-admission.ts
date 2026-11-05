import {createContractValidator} from '@lifestream/contracts';
import type {ActivityScope} from '@lifestream/contracts/game-activity';
import {GameHostError,type GameHostActor} from './game-host-port.ts';

export type UbuntuGameScopeTemplate=Omit<ActivityScope,'contextBinding'>&{ownerPermissionRef:string};
export type UbuntuGameSessionMetadata={sessionId:string;conversationId:string;endpointId:string;environmentId:string};
const freeze=<T>(value:T):Readonly<T>=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const uuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const deny=(status:number,code:string):never=>{throw new GameHostError(status,code);};

/** One authenticated, same-origin bootstrap. Only the server supplies session
 * metadata. This creates no login, authority grant, game run or native child. */
export function createUbuntuGameAdmission(input:UbuntuGameScopeTemplate,{timeoutMs=900000}: {timeoutMs?:number}={}){
 const template=freeze(structuredClone(input));
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>900000||!template||Object.keys(template).sort().join(',')!=='activityEpoch,activityId,assistantId,campaignId,environmentId,observationDomain,ownerPermissionRef,principalId,relationshipId,runId,timelineId,timelineRevision'||!['activityId','assistantId','campaignId','environmentId','principalId','relationshipId','runId','timelineId'].every(key=>uuid((template as any)[key]))||!['activityEpoch','timelineRevision'].every(key=>Number.isSafeInteger((template as any)[key])&&(template as any)[key]>=1)||template.observationDomain!=='simulatedGame'||typeof template.ownerPermissionRef!=='string'||!template.ownerPermissionRef.trim()||template.ownerPermissionRef.length>1024)throw Error('Explicit bounded CT scope template required');
 const validator=createContractValidator();
 let cancelledReason:string|null=null;
 let state:'awaitingSession'|'binding'|'bound'|'cancelled'='awaitingSession',scope:Readonly<ActivityScope>|undefined,resolveBinding!:(scope:Readonly<ActivityScope>)=>void,rejectBinding!:(error:Error)=>void;
 const binding=new Promise<Readonly<ActivityScope>>((resolve,reject)=>{resolveBinding=resolve;rejectBinding=reject;});
 // The owner may not start awaiting until its server has finished startup.
 void binding.catch(()=>{});
 const cancel=(reason='game_session_admission_cancelled')=>{if(state==='bound'||state==='cancelled')return;state='cancelled';cancelledReason=reason;clearTimeout(timer);rejectBinding(new GameHostError(410,reason));};
 const timer=setTimeout(()=>cancel('game_session_admission_expired'),timeoutMs);timer.unref();
 const authorized=(actor:GameHostActor)=>{if(!actor||actor.principalId!==template.principalId||!uuid(actor.sessionId))deny(403,'game_session_scope_denied');};
 return Object.freeze({template,waitForBinding:()=>binding,cancel,
  expiredUnbound(actor:GameHostActor){authorized(actor);return state==='cancelled'&&cancelledReason==='game_session_admission_expired'&&scope===undefined;},
  status(actor:GameHostActor){authorized(actor);if(state==='cancelled')deny(410,'game_session_admission_expired');return Object.freeze({phase:'bootstrap',state,started:false,current:false,restartAvailable:false,pauseConfirmation:'unconfirmed'});},
  bind(actor:GameHostActor,metadata:UbuntuGameSessionMetadata){
   authorized(actor);if(state!=='awaitingSession')deny(409,'game_session_already_bound');
   if(!metadata||Object.keys(metadata).sort().join(',')!=='conversationId,endpointId,environmentId,sessionId'||!Object.values(metadata).every(uuid)||metadata.sessionId!==actor.sessionId||metadata.environmentId!==template.environmentId)deny(403,'game_session_scope_denied');
   const {ownerPermissionRef,...base}=template;
   const candidate={...base,contextBinding:{sessionId:metadata.sessionId,conversationId:metadata.conversationId,endpointId:metadata.endpointId,participationKind:'logicalActivity' as const,humanSpeakerRef:null,audioOwnerEndpointId:null,ownerPermissionRef}};
   if(!validator.validate('https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/ActivityScope',candidate).valid||actor.isCurrent(candidate)!==true)deny(403,'game_session_scope_denied');
   scope=freeze(candidate);state='binding';return this.status(actor);
  },
  publishBinding(){if(state!=='binding'||!scope)return false;state='bound';clearTimeout(timer);resolveBinding(scope);return true;}
 });
}
