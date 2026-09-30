import {createHash} from 'node:crypto';
import type {MemoryRepository} from '@lifestream/storage-sqlite';
import {visualExperienceEpisode,type ExperienceScope,type Source} from '@lifestream/contracts/experience';
import type {VisualObservationEpisode} from '@lifestream/contracts/visual-memory';

/** One attributable-source filter for runtime reconciliation and isolated recovery. */
export function retainedExperienceSources(memories:MemoryRepository,scope:ExperienceScope,contentAllowed:(content:string)=>boolean,visualEpisodes:readonly VisualObservationEpisode[]=[]):Source[]{
 const statements=memories.contextRecords(scope.assistantId,scope.principalId).filter(r=>r.provenance.actor===scope.principalId&&r.provenance.relationshipId===scope.relationshipId&&r.lifecycle.status==='active'&&r.provenance.epistemicStatus==='userStatement'&&typeof r.provenance.sourceTurnRef==='string'&&contentAllowed(r.content)).slice(-256).map(r=>({id:r.id,revision:Number(r.lifecycle.revision),family:String(r.provenance.sourceFamily??r.provenance.source??r.id),digest:createHash('sha256').update(r.content).digest('hex'),content:r.content,occurredAt:r.createdAt}));
 const visual=visualEpisodes.flatMap(episode=>{const content=JSON.stringify(episode);if(content.length>4000||Buffer.byteLength(content)>8192||!contentAllowed(content))return [];const source:Source={id:`visual-episode:${episode.episodeId}`,revision:episode.revision,family:`visual:${episode.independenceKeys[0]}`,digest:createHash('sha256').update(content).digest('hex'),content,occurredAt:episode.occurredAt};return visualExperienceEpisode(source)&&episode.scope.principalId===scope.principalId&&episode.scope.assistantId===scope.assistantId&&episode.scope.relationshipId===scope.relationshipId&&Date.parse(episode.expiresAt)>Date.now()?[source]:[];});
 return [...statements,...visual].slice(0,256);
}
