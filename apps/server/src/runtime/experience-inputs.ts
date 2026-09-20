import {createHash} from 'node:crypto';
import type {MemoryRepository} from '@lifestream/storage-sqlite';
import type {ExperienceScope,Source} from '@lifestream/contracts/experience';

/** One attributable-source filter for runtime reconciliation and isolated recovery. */
export function retainedExperienceSources(memories:MemoryRepository,scope:ExperienceScope,contentAllowed:(content:string)=>boolean):Source[]{
 return memories.contextRecords(scope.assistantId,scope.principalId).filter(r=>r.provenance.actor===scope.principalId&&r.provenance.relationshipId===scope.relationshipId&&r.lifecycle.status==='active'&&r.provenance.epistemicStatus==='userStatement'&&typeof r.provenance.sourceTurnRef==='string'&&contentAllowed(r.content)).slice(-256).map(r=>({id:r.id,revision:Number(r.lifecycle.revision),family:String(r.provenance.sourceFamily??r.provenance.source??r.id),digest:createHash('sha256').update(r.content).digest('hex'),content:r.content,occurredAt:r.createdAt}));
}
