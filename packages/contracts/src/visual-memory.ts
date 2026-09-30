import {createContractValidator,type ValidationResult} from './validator.ts';
import {createHash} from 'node:crypto';

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

/** This estimate describes the source-to-memory transformation, not perception
 * accuracy. Its author must supply a concrete basis and versioned policy. */
export type VisualTransformationConfidence={value:number;basis:string;policyRef:string};
export type VisualMemoryProjection={schemaVersion:'1.0.0';recordType:'visualMemoryProjection';episode:VisualObservationEpisode;memoryRecord:{
 schemaVersion:'2.0.0';memoryId:string;assistantId:string;kind:'experiential';content:string;factuality:'unverified';confidence:number;sensitivity:'personal';status:'candidate';
 provenance:{sourceType:'interaction';sourceRefs:string[];transformationId:string;transformationVersion:string};createdAt:string;createdBy:string;lastReinforcedAt:null;contradictedBy:string[];
 extensions:{'lifestream.conversationalVision':{schemaVersion:'1.0.0';sourceKind:'modelVisualObservation';episodeId:string;episodeRevision:number;transformationConfidence:VisualTransformationConfidence;sourceDigest:string;rawMediaRetained:false}};
}};
export function validateVisualMemoryProjection(value:unknown):ValidationResult{
 const shape=createContractValidator().validate(conversationalVisionSchemaId+'#/$defs/VisualMemoryProjection',value);if(!shape.valid)return shape;
 const {episode,memoryRecord:memory}=value as VisualMemoryProjection,binding=memory.extensions['lifestream.conversationalVision'];
 const sourceRef=`visual-episode:${episode.episodeId}:${episode.revision}:${episode.sourceDigest}`;
 const sourceDigest=createHash('sha256').update(JSON.stringify({scope:episode.scope,observations:episode.observations})).digest('hex');
 const consistent=episode.sourceDigest===sourceDigest&&episode.state==='retained'&&episode.memoryRecordId===memory.memoryId&&episode.scope.assistantId===memory.assistantId&&episode.scope.principalId===memory.createdBy&&
  binding.episodeId===episode.episodeId&&binding.episodeRevision===episode.revision&&binding.sourceDigest===episode.sourceDigest&&binding.transformationConfidence.value===memory.confidence&&
  memory.provenance.sourceRefs.length===1&&memory.provenance.sourceRefs[0]===sourceRef&&memory.content===episode.summary&&memory.kind==='experiential'&&memory.status==='candidate'&&memory.sensitivity==='personal'&&
  memory.lastReinforcedAt===null&&memory.contradictedBy.length===0&&Date.parse(memory.createdAt)>=Date.parse(episode.retainedAt)&&Date.parse(memory.createdAt)<Date.parse(episode.expiresAt);
 return consistent?shape:{valid:false,errors:[{instancePath:'',keyword:'visualSourceBinding',message:'Visual projection does not match its retained source and transformation boundary'}]};
}
