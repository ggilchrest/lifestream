import * as THREE from 'three';
const zero=()=>({blink:0,gazeX:0,gazeY:0});
const clamp=(value,min,max)=>Number.isFinite(value)?Math.max(min,Math.min(max,value)):0;
function axis(value){
 if(!Array.isArray(value)||value.length!==3||value.some(v=>!Number.isFinite(v)))throw Error('Invalid gaze axis.');
 const result=new THREE.Vector3(...value);if(Math.abs(result.length()-1)>.001)throw Error('Gaze axis must be a unit vector.');return result.normalize();
}
function trackNode(name){const parsed=THREE.PropertyBinding.parseTrackName(name);if(parsed.objectName||parsed.propertyIndex!==undefined||!parsed.nodeName)throw Error('Unsupported face track.');return parsed;}

/** Pure presentation motion, never evidence of an observed person or sensed gaze. */
export function sampleFaceMotion(seconds,{blink,attention='none',reducedMotion=false}={}){
 if(!Number.isFinite(seconds)||seconds<0||reducedMotion)return zero();
 let closure=0;if(blink){const period=blink.periodSeconds,duration=blink.durationSeconds,phase=seconds%period;if(phase>=period-duration)closure=Math.sin(Math.PI*(phase-period+duration)/duration);}
 return {blink:clamp(closure,0,1),gazeX:attention==='none'?Math.sin(seconds*.31)*.25:0,gazeY:attention==='none'?Math.sin(seconds*.23)*.15:0};
}

/** Host calls beginFrame before body/speech evaluation and apply afterwards.
 * Only declared local targets are owned; no character names, hierarchy heuristics,
 * retargeting, asset loading, audio generation or camera access is included. */
export class FaceMotion {
 constructor(root,clips,configuration={},reservedTracks=[]){
  this.configuration=configuration;this.saved=new Map();this.gaze=[];this.poses=[];
  const nodes=new Map();root.traverse(node=>{const found=nodes.get(node.name)??[];found.push(node);nodes.set(node.name,found);});
  const resolve=name=>{const found=nodes.get(name);if(found?.length!==1)throw Error('A face target is missing or ambiguous.');return found[0];};
  const reserved=new Set(reservedTracks.map(name=>trackNode(name).nodeName)),owned=new Set();
  if(configuration.gaze){
   const {nodes:targets,yawLimit,pitchLimit}=configuration.gaze;
   if(!Array.isArray(targets)||!targets.length||targets.length>4||!Number.isFinite(yawLimit)||yawLimit<=0||yawLimit>.35||!Number.isFinite(pitchLimit)||pitchLimit<=0||pitchLimit>.25)throw Error('Invalid gaze bounds.');
   for(const target of targets){const node=resolve(target.node),yaw=axis(target.yawAxis),pitch=axis(target.pitchAxis);if(Math.abs(yaw.dot(pitch))>.01)throw Error('Gaze axes must be independent.');if(reserved.has(target.node)||owned.has(target.node))throw Error('Competing facial target ownership.');owned.add(target.node);this.gaze.push({node,yaw,pitch,yawLimit,pitchLimit});}
  }
  if(configuration.blink){
   const {clip:name,periodSeconds:period,durationSeconds:duration}=configuration.blink;
   if(!Number.isFinite(period)||period<1||period>30||!Number.isFinite(duration)||duration<.08||duration>1||duration>=period)throw Error('Invalid blink bounds.');
   const matches=clips.filter(c=>c.name===name);if(matches.length!==1)throw Error('A declared blink clip is missing or ambiguous.');const clip=matches[0];
   if(!clip.tracks.length||clip.tracks.length>192||!Number.isFinite(clip.duration)||clip.duration<0)throw Error('Invalid blink clip.');
   const tracks=new Set(),blinkNodes=new Set();
   for(const track of clip.tracks){
    const parsed=trackNode(track.name),property=parsed.propertyName,node=resolve(parsed.nodeName);
    if(!['position','quaternion','scale'].includes(property)||track.getValueSize()!==(property==='quaternion'?4:3)||tracks.has(track.name))throw Error('Unsupported face track.');
    if(reserved.has(parsed.nodeName)||owned.has(parsed.nodeName))throw Error('Competing facial target ownership.');tracks.add(track.name);blinkNodes.add(node);
    const values=Array.from(track.createInterpolant().evaluate(clip.duration));if(values.some(v=>!Number.isFinite(v)))throw Error('Nonfinite face pose.');const target=node[property].clone().fromArray(values);
    if(property==='quaternion'){if(target.length()<.001)throw Error('Invalid face rotation.');target.normalize();}this.poses.push({node,property,target});
   }
   if(blinkNodes.size>64)throw Error('Face pose target bound exceeded.');
  }
 }
 remember(node,property){let values=this.saved.get(node);if(!values){values=new Map();this.saved.set(node,values);}if(!values.has(property))values.set(property,node[property].clone());}
 beginFrame(){this.reset();}
 reset(){for(const [node,values] of this.saved)for(const [property,value] of values)node[property].copy(value);this.saved.clear();}
 apply({blink=0,gazeX=0,gazeY=0}={}){
  if(this.saved.size)throw Error('Face motion requires beginFrame before another application.');
  const weight=clamp(blink,0,1),x=clamp(gazeX,-1,1),y=clamp(gazeY,-1,1);
  if(weight)for(const {node,property,target} of this.poses){this.remember(node,property);if(property==='quaternion')node.quaternion.slerp(target,weight);else node[property].lerp(target,weight);}
  if(x||y)for(const {node,yaw,pitch,yawLimit,pitchLimit} of this.gaze){this.remember(node,'quaternion');node.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(yaw,x*yawLimit)).multiply(new THREE.Quaternion().setFromAxisAngle(pitch,y*pitchLimit));}
 }
}
