import type {MemoryRecord,GameEpisodeOptions,GameHelpOptions} from '@lifestream/storage-sqlite';
import type {GameExperienceEpisode,GameMemoryBinding} from '@lifestream/contracts/game-activity';
import type {RelationshipContextRecord} from '@lifestream/runtime/context';
import type {GameHelpAdviceIntakeOptions} from './game-advice.ts';
export type GameMemoryHostOptions={source:GameEpisodeOptions;maximumCandidates:number;estimate:(episode:Readonly<GameExperienceEpisode>)=>GameMemoryBinding['transformationConfidence']|null;help?:{options:Omit<GameHelpOptions,'episodeFor'|'scopeCurrent'|'quarantined'|'now'>;maximumCandidates:number;reply?:GameHelpAdviceIntakeOptions}};
/** Called only with a source-validated existing memory record. Full opaque
 * activity/run/campaign/artifact lineage remains in the typed source binding;
 * a compact dated timeline label fits the existing optional-memory allocation. */
export function gameMemoryContextRecord(record:MemoryRecord):RelationshipContextRecord{
 const binding=(record.provenance.canonical as {extensions:Record<string,GameMemoryBinding>}).extensions['lifestream.localGameActivity']!;
 return {id:record.id,revision:Number(record.lifecycle.revision),sourceFamily:'game:'+String(record.provenance.gameFamilyKey),status:'approved',use:'relevant',personalization:true,mention:true,expiresAt:String(record.provenance.gameExpiresAt),gameExperience:true,memoryRecord:true,
  content:`Past simulated game experience ${String(record.provenance.gameOccurredFrom)} [timeline=${binding.timelineId}]. ${record.content} Uncertainty: ${String(record.provenance.gameUncertainty)}. Raw evidence not retained. Historical game memory, not current progress, a Human statement, physical-world fact or feelings.`};
}
