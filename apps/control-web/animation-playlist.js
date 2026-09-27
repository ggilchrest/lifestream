import * as THREE from 'three';

// A shuffled cycle avoids starving a clip and repeating at a cycle boundary.
export class ShuffleAnimations {
 constructor(random=Math.random){this.random=random;this.key='';this.bag=[];}
 next(names,previous=null){
  const key=JSON.stringify(names);if(key!==this.key){this.key=key;this.bag=[];}
  if(!names.length)return null;
  if(!this.bag.length){this.bag=[...names];for(let i=this.bag.length-1;i>0;i--){const j=Math.min(i,Math.max(0,Math.floor(this.random()*(i+1))));[this.bag[i],this.bag[j]]=[this.bag[j],this.bag[i]];}if(this.bag.length>1&&this.bag.at(-1)===previous)[this.bag[0],this.bag[this.bag.length-1]]=[this.bag.at(-1),this.bag[0]];}
  return this.bag.pop();
 }
}

// Local presentation only. This never drives speech, inference or audience truth.
export class AnimationPlaylist {
 constructor(value,{enabled=()=>true,random=Math.random}={}){
  this.value=value;this.enabled=enabled;this.shuffle=new ShuffleAnimations(random);this.current=null;this.remaining=0;this.fallbacks=new Map();this.retiring=[];this.transition=value.manifest.transitionSeconds??.2;
  for(const entry of value.manifest.animationLibrary??[])value.actions.get(entry.clip)?.setEffectiveWeight(1);
  for(const entry of value.manifest.animationLibrary??[])if(entry.blendMode==='additive')value.actions.get(entry.clip).blendMode=THREE.AdditiveAnimationBlendMode;
 }
 idleFallback(name){
  const idle=this.value.manifest.animations.idle;if(!idle||name===idle||!this.enabled(idle))return null;
  if(!this.fallbacks.has(name)){
   const base=this.value.actions.get(idle)?.getClip(),owned=new Set(this.value.actions.get(name).getClip().tracks.map(t=>t.name));
   const additive=this.value.manifest.animationLibrary?.find(item=>item.clip===name)?.blendMode==='additive';
   const tracks=base?.tracks.filter(t=>additive||!owned.has(t.name));
   this.fallbacks.set(name,tracks?.length?this.value.mixer.clipAction(new THREE.AnimationClip('fallback-'+name,base.duration,tracks)):null);
  }
  return this.fallbacks.get(name);
 }
 retire(action,immediate=false){if(!action)return;if(immediate||!this.transition)action.stop();else{action.fadeOut(this.transition);this.retiring.push({action,remaining:this.transition});}}
 choose(name){
  const previous=this.action,previousFallback=this.fallback;
  this.retire(previous,this.current&&!this.enabled(this.current));this.retire(previousFallback,!this.enabled(this.value.manifest.animations.idle));
  this.current=name;this.action=name?this.value.actions.get(name):null;this.fallback=name?this.idleFallback(name):null;
  for(const action of [this.action,this.fallback].filter(Boolean)){
   this.retiring=this.retiring.filter(item=>item.action!==action);
   action.reset().setEffectiveWeight(1).setEffectiveTimeScale(1);action.setLoop(action===this.fallback?THREE.LoopRepeat:THREE.LoopOnce,action===this.fallback?Infinity:1);action.clampWhenFinished=action===this.action;
   if(previous&&this.transition)action.fadeIn(this.transition);action.play();
  }
  this.remaining=this.action?Math.max(2,this.action.getClip().duration):0;
 }
 update(delta,{paused=false}={}){
  const names=(this.value.manifest.animationLibrary??[]).map(item=>item.clip).filter(name=>this.enabled(name));
  for(const [name,action]of this.value.actions)if(!this.enabled(name))action.stop();
  if(!this.enabled(this.value.manifest.animations.idle)){for(const action of this.fallbacks.values())action?.stop();this.fallback=null;}
  if(!names.length){this.choose(null);for(const item of this.retiring)item.action.stop();this.retiring=[];this.value.mixer.update(0);return;}
  if(this.current&&!names.includes(this.current)){this.choose(this.shuffle.next(names,this.current));}
  if(paused)return;
  const elapsed=Math.max(0,Number.isFinite(delta)?delta:0);
  for(const item of this.retiring){item.remaining-=elapsed;if(item.remaining<=0)item.action.stop();}this.retiring=this.retiring.filter(item=>item.remaining>0);
  this.remaining-=elapsed;if(!this.current||this.remaining<=0)this.choose(this.shuffle.next(names,this.current));
  // Re-enabling idle adds the missing body fallback without restarting the pose.
  if(!this.fallback){this.fallback=this.idleFallback(this.current);this.fallback?.reset().setLoop(THREE.LoopRepeat,Infinity).setEffectiveWeight(1).play();}
 }
 dispose(){this.action?.stop();this.fallback?.stop();for(const item of this.retiring)item.action.stop();for(const action of this.fallbacks.values())if(action){action.stop();this.value.mixer.uncacheAction(action.getClip());}this.fallbacks.clear();this.retiring=[];this.current=null;}
}
