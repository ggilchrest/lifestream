export const presentationStates=Object.freeze(['idle','listening','preparing','speaking','interrupted','working','waiting','failure']);

export function stateForPresentation(semantic){
 if(semantic.activity==='error')return 'failure';
 if(['listening','preparing','speaking','interrupted'].includes(semantic.speechState))return semantic.speechState;
 return ['working','waiting'].includes(semantic.activity)?semantic.activity:'idle';
}

export function animationForState(manifest,state){
 if(!presentationStates.includes(state))throw new Error('Unsupported animation preview state.');
 const requested=manifest.animations[state],clip=requested??manifest.animations.idle??null;
 return {requested:state,effective:requested?state:clip?'idle':null,clip,degraded:!requested,transitionSeconds:manifest.transitionSeconds??.15};
}

export function validateAnimationClips(manifest,clips){
 const library=(manifest.animationLibrary??[]).map(item=>item.clip);
 if(new Set(library).size!==library.length)throw new Error('The animation library has duplicate clip declarations.');
 for(const name of [...Object.values(manifest.animations),...library]){
  if(clips.filter(clip=>clip.name===name).length!==1)throw new Error('A declared animation is missing or ambiguous. The previous appearance is retained.');
 }
}
