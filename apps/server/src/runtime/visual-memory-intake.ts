import {randomUUID} from 'node:crypto';
import type {VisualMemoryObservation,VisualMemoryScope,VisualObservationEpisode,VisualTransformationConfidence} from '@lifestream/contracts/visual-memory';
import {visualEpisodeSourceDigest,type VisualMemoryAdmission,type VisualMemoryPolicy} from '@lifestream/storage-sqlite';
import type {VisualObservationBatch} from '@lifestream/runtime/perception/observation';

/** Host-owned selection and visual association. Neither login nor provider text
 * supplies an identity, meaningful-event decision or independent source family. */
export type VisualMemorySelection={
 reason:VisualMemoryAdmission['reason'];independenceKey:string;
 transformationConfidence?:VisualTransformationConfidence;
 observations:readonly {observationId:string;subject:VisualMemoryObservation['subject'];visibility:VisualMemoryObservation['visibility']}[];
};
export type VisualMemoryPublication={batch:VisualObservationBatch;freshUntilMs:number;isCurrent:()=>boolean};

/** Lossless appearance attribution with an explicitly omitted inference lane.
 * The closed canonical validator and repository enforce all final bounds. */
export function visualPublicationEpisode(batch:VisualObservationBatch,selection:VisualMemorySelection,policy:VisualMemoryPolicy,now:number,freshUntilMs:number){
 if(!batch.scope.relationshipId||!policy.enabled||!policy.retentionMs||!policy.retentionPolicyRef||selection.observations.length<1||selection.observations.length>8)return null;
 if(!Number.isFinite(freshUntilMs)||freshUntilMs<=now||freshUntilMs>batch.capturedAtEarliestMs+6000)return null;
 const scope:VisualMemoryScope={...batch.scope,relationshipId:batch.scope.relationshipId};
 const iso=(ms:number)=>new Date(ms).toISOString();
 const observations:VisualMemoryObservation[]=selection.observations.map(binding=>{
  const source=batch.observations.find(item=>item.observationId===binding.observationId);
  if(!source)throw Error('Visual memory selection does not name a published observation');
  return {schemaVersion:'1.0.0',recordType:'visualObservation',observationId:source.observationId,revision:1,batchId:batch.requestId,
   sourceFrameIds:[...source.frameIds],earliestCaptureAt:iso(batch.capturedAtEarliestMs),latestCaptureAt:iso(batch.capturedAtLatestMs),receivedAt:iso(batch.receivedAtMs),interpretedAt:iso(batch.interpretedAtMs),expiresAt:iso(freshUntilMs),
   sourceKind:'modelVisualObservation',epistemicKind:'visibleFeature',description:source.appearance,subject:structuredClone(binding.subject),visibility:binding.visibility,
   uncertainty:'Unverified sampled appearance; model confidence is uncalibrated. Tentative inference is not retained by this transformation.',
   confidence:source.confidence===null?null:{value:source.confidence,basis:'Uncalibrated perception-provider score',calibrationRef:null},
   limitations:[...source.limitations,'Raw media is not retained.','Capture interval includes host clock-mapping uncertainty; its upper bound is not an exact event time.'],independenceKey:selection.independenceKey,
   providerConfigurationRef:JSON.stringify([batch.provider.id,batch.provider.version,scope.sourceBindingRef,scope.captureConfigurationRevision]),transformationVersion:'1.0.0',untrusted:true};
 });
 const subjectRef=observations[0]!.subject.subjectRef;
 if(!subjectRef||observations.some(o=>o.subject.subjectRef!==subjectRef))return null;
 const episode:VisualObservationEpisode={schemaVersion:'1.0.0',recordType:'visualObservationEpisode',episodeId:randomUUID(),revision:1,scope,sourceKind:'modelVisualObservation',observations,
  summary:'Unverified sampled visual appearance: '+observations.map(o=>o.description).join(' '),sourceObservationIds:observations.map(o=>o.observationId),independenceKeys:[selection.independenceKey],sourceDigest:'',occurredAt:iso(batch.capturedAtEarliestMs),retainedAt:iso(now),
  retentionPolicyRef:policy.retentionPolicyRef,processingPolicyRevision:policy.revision,expiresAt:iso(batch.capturedAtEarliestMs+policy.retentionMs),state:'candidate',correctionRefs:[],memoryRecordId:null,rawMediaRetained:false,memoryFactuality:'unverified',memorySourceType:'interaction'};
 episode.sourceDigest=visualEpisodeSourceDigest(episode);
 const admission:VisualMemoryAdmission={scope,policyRevision:policy.revision,current:true,reason:selection.reason,verifiedSubjectRef:subjectRef};
 return {episode,admission};
}
