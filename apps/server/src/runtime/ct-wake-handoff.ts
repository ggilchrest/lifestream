import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {ActivityScope,GameObservation} from '@lifestream/contracts/game-activity';

/** A verified engineering prelude is historical evidence. The first actual
 * adapter observation must independently read the same paused handoff pixels
 * before any model planning. It never substitutes either historical image. */
export function captureCtWakeHandoff(scope:ActivityScope,pinsDigest:string,proof:any,observation:GameObservation){
 const digest=createHash('sha256').update(JSON.stringify(scope)).digest('hex'),now=Date.now(),shot=observation.screenshots[0];
 const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
 if(!proof||proof.scopeDigest!==digest||proof.pinsDigest!==pinsDigest||!hash(proof.receiptSha256)||!hash(proof.containerIdDigest)||!/^[a-f0-9]{32}$/.test(proof.invocationNonce)||!Number.isSafeInteger(proof.nativePid)||proof.nativePid<1||!Number.isSafeInteger(proof.nativeStartTicks)||proof.nativeStartTicks<1||proof.engineeringActions!==33||proof.engineeringFrames!==396||proof.handoffFrame!==84569||!shot||observation.screenshots.length!==1||!isDeepStrictEqual(observation.scope,scope)||observation.frameNumber!==84569||shot.frameNumber!==84569||shot.sha256!=='03de85e30f25c5cf7e198b4a1df54c8cf9f3d4d822c5209f3c9fe787f536818d'||shot.sha256!==proof.finalScreenshot?.sha256||shot.byteLength!==proof.finalScreenshot?.byteLength||shot.width!==256||shot.height!==224||!Number.isFinite(Date.parse(shot.capturedAt))||Date.parse(shot.capturedAt)>now||!Number.isFinite(Date.parse(proof.finalScreenshot.capturedAt))||Date.parse(shot.capturedAt)<Date.parse(proof.finalScreenshot.capturedAt)||!Number.isFinite(Date.parse(shot.expiresAt))||Date.parse(shot.expiresAt)<=now)throw Error('ct_fresh_wake_handoff_join_required');
 return Object.freeze({schemaVersion:'ct-engineering-to-model-handoff/1',scopeDigest:digest,pinsDigest,invocationNonce:proof.invocationNonce,receiptSha256:proof.receiptSha256,containerIdDigest:proof.containerIdDigest,nativePid:proof.nativePid,nativeStartTicks:proof.nativeStartTicks,engineeringActions:33,engineeringFrames:396,modelActionsBeforeHandoff:0,modelCallsBeforeHandoff:0,frameNumber:84569,freshObservationId:observation.observationId,freshScreenshotId:shot.screenshotId,pngSha256:shot.sha256,evidenceMeaning:'AUTOMATIC: verified fixed engineering prefix joined to independently read fresh native observation; no model action asserted',controllerAuthority:false});
}
export type CtWakeHandoffEvidence=ReturnType<typeof captureCtWakeHandoff>;
