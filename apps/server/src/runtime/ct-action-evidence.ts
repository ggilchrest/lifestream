import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {GameActionRequest,GameActionResult} from '@lifestream/contracts/game-activity';
/** Metadata from the original accepted native action result, with all free
 * text, owner leases, dispatch predicates and raw scope deliberately omitted. */
export function captureCtActionEvidence(request:GameActionRequest,result:GameActionResult){
 const receipt=result.outcome.payload;
 if(!receipt||result.requestId!==request.requestId||result.correlationId!==request.correlationId||!isDeepStrictEqual(receipt.scope,request.scope)||receipt.actionId!==request.payload.actionId||receipt.proposalId!==request.payload.proposal.proposalId||receipt.admissionId!==request.payload.admission.admissionId||receipt.idempotencyKey!==request.idempotencyKey)throw Error('ct_native_action_identity_required');
 return Object.freeze({schemaVersion:'ct-accepted-native-action/1',scopeDigest:createHash('sha256').update(JSON.stringify(request.scope)).digest('hex'),requestId:request.requestId,actionId:receipt.actionId,proposalId:receipt.proposalId,admissionId:receipt.admissionId,inputDigest:receipt.inputDigest,planningObservationId:request.payload.proposal.observationId,dispatchObservationId:request.payload.dispatchValidation.dispatchObservationId,buttons:Object.freeze(Object.keys(request.payload.buttonVector).filter(key=>request.payload.buttonVector[key as keyof typeof request.payload.buttonVector])),durationFrames:request.payload.proposal.durationFrames,resultStatus:result.outcome.status,disposition:receipt.disposition,beforeFrame:receipt.beforeFrame,afterFrame:receipt.afterFrame,framesApplied:receipt.framesApplied,buttonsNeutralized:receipt.buttonsNeutralized,startedAt:receipt.startedAt,completedAt:receipt.completedAt,resultingObservationIds:Object.freeze([...receipt.resultingObservationIds]),evidenceMeaning:'AUTOMATIC: original native action result accepted by existing evidence owner; compare proposalId to actual validated model decision and actionId to resulting PNG observation',controllerAuthority:false});
}
export type CtActionEvidence=ReturnType<typeof captureCtActionEvidence>;
