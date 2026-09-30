import type * as G from '@lifestream/contracts/game-activity';
/** This port does not launch, install, enroll or qualify an emulator. */
export type GameCallContext={signal:AbortSignal;isCurrent:(scope:G.ActivityScope)=>boolean};
export interface GameActivityAdapter{
 observe(request:G.GameObserveRequest,context:GameCallContext):Promise<G.GameObserveResult>;
 applyController(request:G.GameActionRequest,context:GameCallContext):Promise<G.GameActionResult>;
 releaseControls(request:G.GameReleaseRequest,context:GameCallContext):Promise<G.GameReleaseResult>;
 controlSave(request:G.GameSaveRequest,context:GameCallContext):Promise<G.GameSaveResult>;
}
