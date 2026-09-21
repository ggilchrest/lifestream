import {PropertyBinding} from 'three';

/** Data-only cue-to-pose mapping. Timing belongs to the active audio sample. */
export class SpeechMotion {
 constructor(root,clips,{cueSet,poses,transitionSeconds=.04}={}) {
  if(typeof cueSet!=='string'||!cueSet||cueSet.length>128||!poses||Array.isArray(poses)||typeof poses!=='object'||!Object.keys(poses).length||Object.keys(poses).length>32||!Number.isFinite(transitionSeconds)||transitionSeconds<0||transitionSeconds>.1)throw Error('Invalid speech mapping.');
  this.cueSet=cueSet;this.transitionSamples=transitionSeconds*48000;this.targets=new Map();this.poses=new Map();this.saved=new Map();this.scope=null;this.previousOffset=null;this.cue=null;this.applied=null;
  const nodes=new Map();root.traverse(node=>{const values=nodes.get(node.name)??[];values.push(node);nodes.set(node.name,values);});
  for(const [cue,name] of Object.entries(poses)) {
   if(!/^[A-Za-z0-9_-]{1,32}$/.test(cue)||typeof name!=='string')throw Error('Invalid speech cue.');
   const matches=clips.filter(clip=>clip.name===name);if(matches.length!==1)throw Error('A speech pose is missing or ambiguous.');const clip=matches[0];
   if(!Number.isFinite(clip.duration)||clip.duration<=0||!clip.tracks.length||clip.tracks.length>192)throw Error('Invalid speech pose.');
   const pose=new Map();
   for(const track of clip.tracks) {
    const parsed=PropertyBinding.parseTrackName(track.name),property=parsed.propertyName,found=nodes.get(parsed.nodeName);
    if(parsed.objectName||parsed.propertyIndex!==undefined||!['position','quaternion','scale'].includes(property)||track.getValueSize()!==(property==='quaternion'?4:3)||pose.has(track.name)||track.values.some(value=>!Number.isFinite(value))||!track.times.length||track.times.length>2048||track.times.some((time,i)=>!Number.isFinite(time)||time<0||time>clip.duration||i>0&&time<=track.times[i-1]))throw Error('Unsupported speech track.');
    if(found?.length!==1)throw Error('A speech target is missing or ambiguous.');const node=found[0],values=track.createInterpolant().evaluate(clip.duration);if(values.some(value=>!Number.isFinite(value)))throw Error('Nonfinite speech pose.');const value=node[property].clone().fromArray(values);
    if(property==='quaternion'){if(value.length()<.001)throw Error('Invalid speech rotation.');value.normalize();}
    this.targets.set(track.name,{node,property});pose.set(track.name,value);
   }
   this.poses.set(cue,pose);
  }
  if(new Set([...this.targets.values()].map(x=>x.node)).size>64)throw Error('Speech target bound exceeded.');
  this.tracks=[...this.targets.keys()];
  // Sparse poses reset their other owned targets to the authored neutral pose.
  for(const pose of this.poses.values())for(const [name,{node,property}] of this.targets)if(!pose.has(name))pose.set(name,node[property].clone());
 }
 accepts(track){return track?.cueSet===this.cueSet&&Array.isArray(track.cues)&&track.cues.length>0&&track.cues.every(cue=>this.poses.has(cue.cue));}
 restore(){for(const [name,value] of this.saved){const {node,property}=this.targets.get(name);node[property].copy(value);}this.saved.clear();}
 beginFrame(){this.restore();}
 reset(){this.restore();this.scope=null;this.previousOffset=null;this.cue=null;this.applied=null;}
 apply(sample){
  if(this.saved.size)throw Error('Speech motion requires beginFrame before another application.');
  if(!sample?.playing||sample.clock!=='AudioContext.currentTime'||sample.cueSet!==this.cueSet||!this.poses.has(sample.viseme)||!Number.isSafeInteger(sample.sampleOffset)||sample.sampleOffset<0||typeof sample.trace!=='string'||!sample.trace||typeof sample.segmentId!=='string'||!sample.segmentId){this.reset();return false;}
  const scope=JSON.stringify([sample.trace,sample.segmentId]),fresh=scope!==this.scope||this.previousOffset!==null&&sample.sampleOffset<this.previousOffset;
  if(fresh){this.scope=scope;this.cue=null;this.applied=null;}
  if(this.cue!==sample.viseme){this.cue=sample.viseme;this.startedOffset=sample.sampleOffset;this.from=this.applied??new Map([...this.targets].map(([name,{node,property}])=>[name,node[property].clone()]));}
  this.previousOffset=sample.sampleOffset;const weight=this.transitionSamples===0?1:Math.min(1,(sample.sampleOffset-this.startedOffset)/this.transitionSamples),pose=this.poses.get(sample.viseme);this.applied=new Map();
  for(const [name,{node,property}] of this.targets){this.saved.set(name,node[property].clone());node[property].copy(this.from.get(name));if(property==='quaternion')node[property].slerp(pose.get(name),weight);else node[property].lerp(pose.get(name),weight);this.applied.set(name,node[property].clone());}
  return true;
 }
}
