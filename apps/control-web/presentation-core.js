// Shared presentation mechanics. Hosts supply approved bytes and own UI, identity and I/O.
import * as THREE from 'three';
import {SpeechMotion} from './presentation-speech.js';
import {FaceMotion} from './presentation-motion.js';
import {validateAnimationClips} from './presentation-state.js';
import {AnimationPlaylist} from './animation-playlist.js';

export function disposePresentation(root) {
 const geometries=new Set(),materials=new Set(),textures=new Set();
 root?.traverse(node=>{if(node.geometry)geometries.add(node.geometry);for(const material of [node.material].flat().filter(Boolean)){materials.add(material);for(const value of Object.values(material))if(value?.isTexture)textures.add(value);}});
 for(const value of geometries)value.dispose();for(const value of materials)value.dispose();for(const value of textures){value.source?.data?.close?.();value.dispose();}
}
// Parsing may finish after cancellation. Never leak its model in that case.
export async function loadPresentationAsset({retrieve,parse,signal}) {
 let parsed;
 try {
  signal?.throwIfAborted();
  const bytes=await retrieve(signal);signal?.throwIfAborted();
  parsed=await parse(bytes);signal?.throwIfAborted();
  if(!parsed?.scene)throw Error('The presentation model is missing.');
  return parsed;
 } catch(error) { if(parsed?.scene)disposePresentation(parsed.scene);throw error; }
}

export async function preparePresentation(item,{retrieveResource,createLoader,signal,randomAnimations=false,animationEnabled=()=>true}) {
 const urls=[],byPath=new Map();let parsed;
 try {
  for(const resource of item.manifest.resources){
   signal?.throwIfAborted();const bytes=await retrieveResource(resource,signal);signal?.throwIfAborted();
   if(bytes.byteLength!==resource.bytes)throw Error('Package resource size changed.');
   const actual=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
   if(actual!==resource.sha256)throw Error('Package resource digest changed.');
   const url=URL.createObjectURL(new Blob([bytes],{type:resource.mime}));urls.push(url);byPath.set(resource.path,{url,bytes});
  }
  const model=item.manifest.model,manager=new THREE.LoadingManager();let resourceFailed=false;
  manager.onError=()=>{resourceFailed=true;};
  manager.setURLModifier(url=>{if(urls.includes(url)||globalThis.location?.origin&&url.startsWith(`blob:${globalThis.location.origin}/`))return url;const entry=byPath.get(url);if(!entry)throw Error('The model requested an undeclared resource.');return entry.url;});
  const loader=createLoader(manager),data=byPath.get(model)?.bytes;if(!data)throw Error('The declared model resource is missing.');
  parsed=await loadPresentationAsset({retrieve:()=>data,parse:bytes=>loader.parseAsync(bytes,model.includes('/')?model.slice(0,model.lastIndexOf('/')+1):''),signal});
  if(resourceFailed)throw Error('A model texture could not be loaded. The previous appearance is retained.');
  return createPresentation(parsed,item.manifest,{urls,label:item.label,randomAnimations,animationEnabled});
 } catch(error){if(parsed?.scene)disposePresentation(parsed.scene);for(const url of urls)URL.revokeObjectURL(url);throw error;}
}

export function createPresentation(parsed,manifest,{urls=[],label,randomAnimations=false,animationEnabled=()=>true}={}) {
 const root=parsed.scene,mixer=new THREE.AnimationMixer(root);
 validateAnimationClips(manifest,parsed.animations);
 const anchors=[];if(manifest.framing?.motionAnchor)root.traverse(node=>{if(node.name===manifest.framing.motionAnchor)anchors.push(node);});
 if(manifest.framing?.motionAnchor&&anchors.length!==1)throw Error('The declared motion anchor is missing or ambiguous.');
 // A bone can move beyond the bind-pose sphere while its mesh node stays still.
 // Anchored presentations keep authored motion without stale-sphere culling.
 if(anchors.length)root.traverse(node=>{if(node.isSkinnedMesh)node.frustumCulled=false;});
 const actions=new Map(parsed.animations.map(clip=>[clip.name,mixer.clipAction(clip)]));
 if(manifest.animations.idle&&!actions.has(manifest.animations.idle))throw Error('The declared idle animation is missing.');
 let mouth=null;if(manifest.mouth){const node=root.getObjectByName(manifest.mouth.node),index=node?.morphTargetDictionary?.[manifest.mouth.morph];if(index===undefined)throw Error('The declared mouth mapping is missing.');mouth={node,index,gain:manifest.mouth.gain};}
 const mouthClip=parsed.animations.find(clip=>clip.name===manifest.animations.mouthAmplitude);if(manifest.animations.mouthAmplitude&&!mouthClip)throw Error('The declared mouth animation is missing.');
 const mouthMixer=mouthClip?new THREE.AnimationMixer(root):null,mouthAction=mouthClip?mouthMixer.clipAction(mouthClip):null;
 if(mouthAction){mouthAction.setLoop(THREE.LoopOnce,1);mouthAction.clampWhenFinished=true;mouthAction.play();mouthAction.paused=true;}
 const speechMotion=manifest.speech?new SpeechMotion(root,parsed.animations,manifest.speech):null;
 const faceMotion=manifest.face?new FaceMotion(root,parsed.animations,manifest.face,[...(speechMotion?.tracks??[]),...(mouthClip?.tracks.map(t=>t.name)??[]),...(manifest.mouth?[manifest.mouth.node+'.morphTargetInfluences']:[])]):null;
 const value={root,mouth,mixer,actions,manifest,urls,label,mouthMixer,mouthAction,faceMotion,speechMotion,motionAnchor:anchors[0]};
 if(randomAnimations&&manifest.animationLibrary?.length)value.playlist=new AnimationPlaylist(value,{enabled:animationEnabled});
 return value;
}

// Restore overlays before body evaluation; speech owns the mouth, then face owns
// only its declared targets. Private authoring adapters may supply their own layers.
export function applyPresentationFrame(value,{sample,delta=0,bodyMotion=true,face,applyBody,applySpeech}={}) {
 if(!value)return;
 value.faceMotion?.beginFrame();value.speechMotion?.beginFrame();
 if(applyBody)applyBody(sample);else{value.playlist?.update(delta,{paused:!bodyMotion});if(bodyMotion)value.mixer?.update(delta);}
 const level=sample?.playing?Math.min(1,sample.amplitude*5):0;
 if(value.mouthAction){value.mouthAction.time=level*value.mouthAction.getClip().duration;value.mouthMixer.update(0);}
 if(value.mouth?.node)value.mouth.node.morphTargetInfluences[value.mouth.index]=level*value.mouth.gain;else if(value.mouth)value.mouth.scale.y=1+level*10;
 if(applySpeech)applySpeech(sample);else value.speechMotion?.apply(sample);
 if(face)value.faceMotion?.apply(face);
}

export function releasePresentation(value) {
 if(!value||value.released)return;value.released=true;
 value.faceMotion?.reset();value.speechMotion?.reset();
 value.playlist?.dispose();
 value.mouthMixer?.stopAllAction();value.mouthMixer?.uncacheRoot(value.root);
 value.mixer?.stopAllAction();value.mixer?.uncacheRoot(value.root);
 disposePresentation(value.root);for(const url of value.urls??[])URL.revokeObjectURL(url);
}
