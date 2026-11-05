export type CtVisibleGoalPolicy = Readonly<
 {kind:'dialogueMovement';initialDialogue:string}|{kind:'movementOnly'}|{kind:'observedGameplay'}
>;

/** Trusted pinned configuration only. No model output, request body or consent
 * is accepted here; this selects a stop condition and grants no input authority. */
export function captureCtVisibleGoalPolicy(value:{goalMode?:unknown;initialDialogue?:unknown}):CtVisibleGoalPolicy{
 if(value.goalMode==='observedGameplay'){
  if(value.initialDialogue!=='')throw Error('Observed gameplay must not supply an expected dialogue');
  return Object.freeze({kind:'observedGameplay'});
 }
 if(value.goalMode==='movementOnly'){
  if(value.initialDialogue!=='')throw Error('Movement-only CT goal requires an explicitly closed dialogue');
  return Object.freeze({kind:'movementOnly'});
 }
 if(value.goalMode!==undefined||typeof value.initialDialogue!=='string'||!value.initialDialogue.trim()||value.initialDialogue.length>500)throw Error('Reviewed initial dialogue goal required');
 return Object.freeze({kind:'dialogueMovement',initialDialogue:value.initialDialogue});
}
