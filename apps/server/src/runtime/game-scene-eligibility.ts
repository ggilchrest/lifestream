import type {GameObservation} from '@lifestream/contracts/game-activity';
/** Fallible image-model scene descriptions, never reviewed/native truth or
 * controller permission. A changed or unknown scene requires fresh planning. */
export type GameSceneRejection='planning_scene_unavailable'|'current_scene_unavailable'|'scene_interpreter_changed'|'scene_comparison_changed'|'scene_comparison_unknown'|'scene_comparison_missing'|'scene_reference_changed'|'scene_kind_changed';
export function observedGameSceneRejection(before:GameObservation,after:GameObservation):GameSceneRejection|null{
 const read=(observation:GameObservation)=>{
  const shot=observation.screenshots[0];if(!shot||!observation.providerConfigurationRef)return null;
  const fact=observation.facts.find(f=>f.extractorRef===observation.providerConfigurationRef&&f.untrusted===true&&f.sourceKind==='playerVisibleGameObservation'&&f.sourceScreenshotIds.length===1&&f.sourceScreenshotIds[0]===shot.screenshotId&&f.description.startsWith('Model scene: '));if(!fact)return null;
  try{const value=JSON.parse(fact.description.slice(13));if(Object.keys(value).sort().join(',')!=='comparedObservationId,comparison,key,kind'||typeof value.key!=='string'||!value.key.trim()||value.key.length>80||!['dialogue','menu','battle','exploration'].includes(value.kind))return null;return {kind:value.kind,comparison:value.comparison,comparedObservationId:value.comparedObservationId};}catch{return null;}
 };
 const a=read(before),b=read(after);
 if(!a)return 'planning_scene_unavailable';if(!b)return 'current_scene_unavailable';
 if(before.providerConfigurationRef!==after.providerConfigurationRef)return 'scene_interpreter_changed';
 if(b.comparison==='changed')return 'scene_comparison_changed';if(b.comparison==='unknown')return 'scene_comparison_unknown';if(b.comparison!=='same')return 'scene_comparison_missing';
 if(b.comparedObservationId!==before.observationId)return 'scene_reference_changed';
 return a.kind===b.kind?null:'scene_kind_changed';
}
export function sameObservedGameScene(before:GameObservation,after:GameObservation):boolean{return observedGameSceneRejection(before,after)===null;}
