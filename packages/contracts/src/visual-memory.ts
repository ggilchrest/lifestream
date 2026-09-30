import {createContractValidator,type ValidationResult} from './validator.ts';

export const conversationalVisionSchemaId='https://lifestream.dev/contracts/conversational-vision/1.0.0';
export type VisualMemoryOwner={principalId:string;assistantId:string;relationshipId:string};
export type VisualMemoryScope=VisualMemoryOwner & {
 environmentId:string;conversationId:string;sessionId:string;endpointId:string;
 sessionRevision:number;audienceRevision:number;scopeGeneration:number;
 sourceBindingRef:string;captureConfigurationRevision:number;
};
export type VisualMemoryObservation={
 schemaVersion:'1.0.0';recordType:'visualObservation';observationId:string;revision:number;
 batchId:string;sourceFrameIds:string[];earliestCaptureAt:string;latestCaptureAt:string;
 receivedAt:string;interpretedAt:string;expiresAt:string;sourceKind:'modelVisualObservation';
 epistemicKind:'visibleFeature'|'inference';description:string;
 subject:{subjectRef:string|null;binding:'authenticatedParticipant'|'userConfirmed'|'unidentified';basisRefs:string[];limitations:string[]};
 visibility:'inView'|'partlyOccluded'|'outOfView'|'uncertain';uncertainty:string;
 confidence:null|{value:number;basis:string;calibrationRef:string|null};limitations:string[];
 independenceKey:string;providerConfigurationRef:string;transformationVersion:string;untrusted:true;
};
export type VisualObservationEpisode={
 schemaVersion:'1.0.0';recordType:'visualObservationEpisode';episodeId:string;revision:number;
 scope:VisualMemoryScope;sourceKind:'modelVisualObservation';observations:VisualMemoryObservation[];
 summary:string;sourceObservationIds:string[];independenceKeys:string[];sourceDigest:string;
 occurredAt:string;retainedAt:string;retentionPolicyRef:string;processingPolicyRevision:number;
 expiresAt:string;state:'candidate'|'retained'|'superseded'|'invalidated';correctionRefs:string[];
 memoryRecordId:string|null;rawMediaRetained:false;memoryFactuality:'unverified';memorySourceType:'interaction';
};
/** Closed canonical shape only; authorization, source currency and retention are host checks. */
export function validateVisualEpisode(value:unknown):ValidationResult{
 return createContractValidator().validate(conversationalVisionSchemaId+'#/$defs/VisualObservationEpisode',value);
}
