import {gameWindowCurrent,type GameWindowSelection} from '@lifestream/runtime/activity/policy';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type * as G from '@lifestream/contracts/game-activity';
import type {GameStartRepository} from '@lifestream/storage-sqlite';
/** First-party temporal-to-durable metadata join. Host admission remains an
 * independent required predicate; no timer/enrollment/start/dispatch is created. */
export function claimConfiguredGameStart(repository:GameStartRepository,raw:{scope:G.ActivityScope;policy:G.GamePolicy;bounds:G.GameBounds},window:GameWindowSelection):boolean {
 const input=boundedGameDataSnapshot(raw) as typeof raw|null;if(!input||Object.keys(input).sort().join(',')!=='bounds,policy,scope'||!gameWindowCurrent(window,input.scope,{policy:input.policy,bounds:input.bounds})||window.purpose!=='play'||window.status!=='inside'||window.policyRevision!==input.policy.revision||!window.windowId||!window.localDate||!window.occurrenceKey)return false;
 return repository.claim({...input,windowId:window.windowId,localDate:window.localDate,occurrenceKey:window.occurrenceKey},()=>gameWindowCurrent(window,input.scope,{policy:input.policy,bounds:input.bounds}));
}
