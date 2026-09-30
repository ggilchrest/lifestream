import {gameEpisodeSnapshot,gameEpisodeDigest,gameProjectionSnapshot} from '@lifestream/contracts/game-memory';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type {GameExperienceEpisode,GameMemoryBinding,GameMemoryProjection} from '@lifestream/contracts/game-activity';
export type GameProjectionInput={episode:GameExperienceEpisode;memoryId:string;estimate:GameMemoryBinding['transformationConfidence'];nowMs:number};
/** Pure candidate transformation. No consent, source qualification, retention,
 * learning, reinforcement or gameplay authority is created by this function. */
export function projectGameEpisode(raw:GameProjectionInput,sourceCurrent:(episode:Readonly<GameExperienceEpisode>)=>boolean):GameMemoryProjection|null{
 const input=boundedGameDataSnapshot(raw,32768) as GameProjectionInput|null;
 if(!input||Object.keys(input).sort().join(',')!=='episode,estimate,memoryId,nowMs')return null;
 const episode=gameEpisodeSnapshot(input.episode,input.nowMs);if(!episode)return null;
 const freeze=<T>(v:T):T=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;};freeze(episode);
 const current=()=>{try{return sourceCurrent(episode)===true;}catch{return false;}};if(!current())return null;
 const p:GameMemoryProjection={schemaVersion:'1.0.0',recordType:'gameMemoryProjection',episode,memoryRecord:{schemaVersion:'2.0.0',memoryId:input.memoryId,assistantId:episode.scope.assistantId,kind:'experiential',content:episode.summary,factuality:'unverified',confidence:input.estimate?.value,sensitivity:'personal',status:'candidate',provenance:{sourceType:'interaction',sourceRefs:[`game-episode:${episode.episodeId}:${episode.revision}:${gameEpisodeDigest(episode)}`],transformationId:'lifestream.game-episode-projection',transformationVersion:'1.0.0'},createdAt:new Date(input.nowMs).toISOString(),createdBy:episode.scope.principalId,lastReinforcedAt:null,contradictedBy:[],extensions:{'lifestream.localGameActivity':{schemaVersion:'1.0.0',observationDomain:'simulatedGame',sourceKind:'simulatedGameExperience',episodeId:episode.episodeId,episodeRevision:episode.revision,activityId:episode.scope.activityId,runId:episode.scope.runId,timelineId:episode.scope.timelineId,campaignId:episode.scope.campaignId,pinsDigest:episode.pinsDigest,transformationConfidence:input.estimate}}}};
 const projection=gameProjectionSnapshot(p,input.nowMs);return projection&&current()?freeze(projection):null;
}
