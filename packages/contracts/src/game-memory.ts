import {createHash} from 'node:crypto';
import {createContractValidator} from './validator.ts';
import {boundedGameDataSnapshot} from './game-journal.ts';
import type {GameExperienceEpisode,GameMemoryProjection,GameMemoryBinding} from './game-activity.ts';
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const gameEpisodeDigest=(episode:GameExperienceEpisode)=>createHash('sha256').update(JSON.stringify(canonical(episode))).digest('hex');
/** Timeline/run changes cannot multiply independence for the same campaign event. */
export const gameEpisodeFamilyKey=(episode:GameExperienceEpisode)=>createHash('sha256').update(JSON.stringify([episode.scope.principalId,episode.scope.assistantId,episode.scope.relationshipId,episode.scope.environmentId,episode.scope.activityId,episode.scope.campaignId,episode.independenceKey])).digest('hex');
export function gameEpisodeSnapshot(input:unknown,now:number):GameExperienceEpisode|null{
 const e=boundedGameDataSnapshot(input,16384) as GameExperienceEpisode|null;
 if(!e||!Number.isSafeInteger(now)||now<0||!Number.isFinite(new Date(now).getTime())||!validator.validate(schema+'GameExperienceEpisode',e).valid||e.state!=='retained'||e.frameRange.from>e.frameRange.to||Date.parse(e.occurredFrom)>Date.parse(e.occurredTo)||Date.parse(e.occurredTo)>Date.parse(e.recordedAt)||Date.parse(e.recordedAt)>now||Date.parse(e.expiresAt)<=now)return null;
 for(const refs of [e.sourceAdmissionIds,e.sourceObservationIds,e.sourceActionIds,e.adviceRefs])if(new Set(refs).size!==refs.length)return null;
 // Claims of an attempt require actual action/admission lineage, qualified by
 // the host against recorded started actions and resulting observations.
 if(e.sourceActionIds.length!==e.sourceAdmissionIds.length)return null;
 return e;
}
export function gameProjectionSnapshot(input:unknown,now:number,statuses:readonly string[]=['candidate']):GameMemoryProjection|null{
 const p=boundedGameDataSnapshot(input,32768) as GameMemoryProjection|null;
 if(!p||!validator.validate(schema+'GameMemoryProjection',p).valid)return null;
 const e=gameEpisodeSnapshot(p.episode,now),m=p.memoryRecord,b=m.extensions?.['lifestream.localGameActivity'] as GameMemoryBinding|undefined;
 if(!e||!b||Object.keys(m.extensions!).length!==1||!statuses.includes(m.status)||m.kind!=='experiential'||m.factuality!=='unverified'||m.sensitivity!=='personal'||m.assistantId!==e.scope.assistantId||m.createdBy!==e.scope.principalId||m.content!==e.summary||m.lastReinforcedAt!==null||m.contradictedBy.length||m.worldEvidenceRefs!==undefined||m.supersedes!==undefined||m.reviewAfter!==undefined||m.confidence!==b.transformationConfidence.value||m.provenance.transformationId!=='lifestream.game-episode-projection'||m.provenance.transformationVersion!=='1.0.0'||m.provenance.sourceRefs.length!==1||m.provenance.sourceRefs[0]!==`game-episode:${e.episodeId}:${e.revision}:${gameEpisodeDigest(e)}`||Date.parse(m.createdAt)<Date.parse(e.recordedAt)||Date.parse(m.createdAt)>now||Date.parse(m.createdAt)>=Date.parse(e.expiresAt))return null;
 if(b.episodeId!==e.episodeId||b.episodeRevision!==e.revision||b.activityId!==e.scope.activityId||b.runId!==e.scope.runId||b.timelineId!==e.scope.timelineId||b.campaignId!==e.scope.campaignId||b.pinsDigest!==e.pinsDigest)return null;
 return p;
}
