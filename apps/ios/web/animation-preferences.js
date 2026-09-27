export const animationKey=(item,clip)=>JSON.stringify([item.id,item.digest,clip]);

export function animationChoices(item){
 if(item.manifest?.animationLibrary)return item.manifest.animationLibrary;
 const clips=new Map();for(const [state,clip] of Object.entries(item.manifest?.animations??{}))if(state!=='mouthAmplitude')clips.set(clip,[...(clips.get(clip)??[]),state]);
 return [...clips].map(([clip,states])=>({clip,label:states.map(x=>x[0].toUpperCase()+x.slice(1)).join(' / ')}));
}

// A package author must explicitly approve each predecessor. Arbitrary digest
// changes retain the existing unavailable-selection behavior.
export function resolveAppearance(catalog,saved,disabled){
 const choices=[catalog.neutral,...catalog.packages];
 if(!saved)return {item:choices.find(x=>x.id===catalog.defaultId)??catalog.neutral,migrated:false};
 const exact=choices.find(x=>x.id===saved.id&&x.digest===saved.digest);if(exact)return {item:exact,migrated:false};
 const item=choices.find(x=>x.id===saved.id&&x.manifest?.replaces?.includes(saved.digest));if(!item)return {item:null,migrated:false};
 for(const {clip} of animationChoices(item))if(disabled[animationKey(saved,clip)]){disabled[animationKey(item,clip)]=true;delete disabled[animationKey(saved,clip)];}
 return {item,migrated:true};
}
