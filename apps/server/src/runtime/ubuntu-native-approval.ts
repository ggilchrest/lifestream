import {ORDINARY_GAME_SESSION_LIMITS} from '@lifestream/contracts/game-host';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {canonicalJson} from '@lifestream/runtime/capabilities/schema-validation';
import {readC72NativeConfiguration,c72NativePlan,scopeDigest} from '@lifestream/providers-bizhawk/c72-native-configuration';
import {createRunScopedNativePairing} from '@lifestream/providers-bizhawk/native-pairing-custody';
import {GameHostError} from './game-host-port.ts';

const digest=(value:any)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Same authenticated backend's dormant native approval/custody owner. Review
 * and approval hold nonsecret metadata only. Entropy is deferred to the exact
 * native launch after current Start consent and controller authority checks. */
export function createUbuntuNativeApproval(options:any,testBoundary?:any){
 if(options.purpose!==undefined&&options.purpose!=='nativeObservationOnly')throw Error('Unknown native approval purpose');
 const observationOnly=options.purpose==='nativeObservationOnly';
 if(options.sessionLifetime!==undefined&&(options.sessionLifetime!=='sessionScoped'||observationOnly))throw Error('Ordinary native session scope required');
 const maximumNativeLifetimeMs=options.maximumNativeLifetimeMs??120000;
 if(!Number.isSafeInteger(maximumNativeLifetimeMs)||maximumNativeLifetimeMs<1||maximumNativeLifetimeMs>(options.sessionLifetime==='sessionScoped'?ORDINARY_GAME_SESSION_LIMITS.maximumMs:300000))throw Error('Finite reviewed native lifetime required');
 if(observationOnly&&(!Number.isSafeInteger(options.maximumRunMs)||options.maximumRunMs<1000||options.maximumRunMs>90000||!Number.isSafeInteger(options.maximumObservations)||options.maximumObservations<1||options.maximumObservations>8))throw Error('Finite native-observation approval required');
 const scope=structuredClone(options.scope),pins=options.pinsDigest;
 let pending:any,approved=false,everApproved=false,consumed=false,closed=false,custodian:any,lastWall=Date.now();
 const fail=(code='game_native_approval_required'):never=>{throw new GameHostError(409,code);};
 const actorCurrent=(actor:any)=>!!actor&&actor.principalId===scope.principalId&&(actor.actorId??actor.principalId)===scope.principalId&&actor.sessionId===scope.contextBinding.sessionId&&actor.isCurrent(scope)===true;
 const facts=(activeNonce?:string)=>{try{const value=readC72NativeConfiguration(options.configurationFile,scope,pins,activeNonce);if(value.sessionLifetime!==options.sessionLifetime||Date.parse(value.expiresAt)>Date.now()+maximumNativeLifetimeMs)throw Error('Unreviewed native lifetime');return value;}catch{return fail('game_native_facts_required');}};
 const clockCurrent=()=>{const now=Date.now();if(now<lastWall){approved=false;custodian?.close();return false;}lastWall=now;return true;};
 const exact=(activeNonce?:string)=>{try{return !!pending&&clockCurrent()&&Date.now()<Date.parse(pending.expiresAt)&&digest(facts(activeNonce))===pending.factsDigest;}catch{return false;}};
 const assertActor=(actor:any,context?:any)=>{if(closed||!actorCurrent(actor))throw new GameHostError(403,'game_session_scope_denied');context?.assertCurrent({assistantId:scope.assistantId,endpointId:scope.contextBinding.endpointId,environmentId:scope.environmentId,sessionId:scope.contextBinding.sessionId});};
 const state=(actor:any)=>{assertActor(actor);return {required:true,state:consumed?'consumed':approved&&exact()?'approved':pending&&exact()?'pending':'required',expiresAt:pending?.expiresAt??null};};
 const invalidate=()=>{approved=false;pending=undefined;custodian?.close();custodian=undefined;};
 return Object.freeze({
  status:state,
  current(actor:any){try{return !consumed&&state(actor).state==='approved';}catch{return false;}},
  preparationIntent(actor:any,context:any){
   assertActor(actor,context);
   if(observationOnly||everApproved||consumed||!clockCurrent()||typeof options.inspectTemplate!=='function')fail('game_native_unused_preparation_required');
   // Inspect the exact original sources before facts, expiry, entropy or a
   // native process exists. This descriptor is not native approval/custody.
   const template=options.inspectTemplate();
   return Object.freeze({scopeDigest:scopeDigest(scope),pinsDigest:pins,templateDigest:digest(template),purpose:'gameplay',maximumNativeLifetimeMs,requiresActualApproval:true});
  },
  review(actor:any,context:any){
   assertActor(actor,context);if(consumed)fail('game_native_approval_consumed');
   if(pending&&exact())return structuredClone(pending);
   invalidate();try{options.prepareFacts?.();}catch{return fail('game_native_facts_required');}const value=facts(),plan=c72NativePlan(value,'0'.repeat(32));
   const display={requestId:randomUUID(),revision:1,state:'pending',scope:structuredClone(scope),scopeDigest:scopeDigest(scope),pinsDigest:pins,factsDigest:digest(value),expiresAt:value.expiresAt,nativeApprovalRef:value.approvalRef,pairingApprovalRef:value.pairing.approvalRef,effectSummary:'Launch one owned private Chrono Trigger instance from the exact saved continuation, create one 32-byte in-memory native pairing buffer, and create fresh ephemeral Xauthority/Pulse display credentials inside that container. Native-only mounts; no account, authentication or history copies. Controller permission is reviewed separately.',image:value.image,continuation:value.continuation,sourcePins:value.sources,imagePins:value.imagePins,mounts:plan.mounts,network:'host; native listener 127.0.0.1 only',pairingCustody:'one in-memory 32-byte buffer; native child pipe; no pairing-key file/argv/stdout',displayCredentialCustody:{xauthorityCookieBytes:16,pulseCookieBytes:256,location:'/tmp/lifestream-ct-native in owned container tmpfs only',lifetime:'ends at reviewed expiry or earlier owned cleanup; exact container removal deletes ephemeral files',copiesFromExistingDisplays:false}};
   const reviewed=observationOnly?{...display,purpose:'nativeObservationOnly',constraints:{maximumRunMs:options.maximumRunMs,maximumObservations:options.maximumObservations,controllerActions:0,planningSteps:0,modelCalls:0,automaticFrameApprovals:0},effectSummary:'Launch one exact owned continuation instance, acquire the first and at most '+options.maximumObservations+' paused game images within '+options.maximumRunMs+' milliseconds, then close only that owned instance. No controller input, gameplay, planning, model calls, save/load/reset or automatic frame approval. The existing source pins and in-memory native pairing remain mandatory.'}:display;
   pending=Object.freeze({...reviewed,confirmationDigest:digest(reviewed)});return structuredClone(pending);
  },
  approve(actor:any,body:any,context:any){
   assertActor(actor,context);
   if(!body||Object.keys(body).sort().join(',')!==(observationOnly?'confirmationDigest,expectedRevision,launchOwnedNative,memoryOnlyPairing,observationsOnly,requestId':'confirmationDigest,expectedRevision,launchOwnedNative,memoryOnlyPairing,requestId')||observationOnly&&body.observationsOnly!==true||body.launchOwnedNative!==true||body.memoryOnlyPairing!==true||!pending||body.requestId!==pending.requestId||body.expectedRevision!==pending.revision||body.confirmationDigest!==pending.confirmationDigest||consumed||!exact())fail('game_native_approval_confirmation_required');
   everApproved=true;approved=true;return state(actor);
  },
  async take(request:any){
   if(closed||consumed||!approved||!/^[a-f0-9]{32}$/.test(request.invocationNonce??'')||!exact(request.invocationNonce)||request.signal?.aborted||!isDeepStrictEqual(request.scope,scope)||request.pinsDigest!==pins)fail();
   const value=facts(request.invocationNonce);if(request.approvalRef!==value.pairing.approvalRef||request.expiresAt!==value.pairing.expiresAt||options.startCurrent()!==true)fail();
   // Mark consumed BEFORE entropy/transfer, with no retry after uncertain setup.
   consumed=true;
   let buffer:any;
   try{buffer=(testBoundary?.entropy??randomBytes)(32);if(!(buffer instanceof Uint8Array)||buffer.length!==32)throw Error('Native entropy unavailable');
    if(!exact(request.invocationNonce)||request.signal?.aborted||options.startCurrent()!==true)fail();
    custodian=createRunScopedNativePairing({...(options.sessionLifetime==='sessionScoped'?{sessionLifetime:'sessionScoped'}:{}),secret:buffer,scope,pinsDigest:pins,approvalRef:value.pairing.approvalRef,expiresAt:value.expiresAt,isCurrent:options.startCurrent});
    return await custodian.take(request);
   }finally{buffer?.fill(0);}
  },
  invalidate,
  close(){closed=true;invalidate();}
 });
}
