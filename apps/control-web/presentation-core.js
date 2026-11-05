// Shared presentation mechanics. Hosts supply approved bytes and own UI, identity and I/O.
import * as THREE from 'three';
import {SpeechMotion} from './presentation-speech.js';
import {FaceMotion} from './presentation-motion.js';
import {validateAnimationClips} from './presentation-state.js';
import {AnimationPlaylist} from './animation-playlist.js';
import {loadTrustedPresentationAdapter} from './presentation-trusted-adapter.js';

// Cleanup is best effort across independent owners; one failing disposer must
// never strand another owner's resources or mask the original prepare failure.
function cleanup(attempt){try{attempt();}catch{ /* Continue releasing the remaining owners. */ }}
export function disposePresentation(root) {
 const geometries=new Set(),materials=new Set(),textures=new Set();
 root?.traverse(node=>{if(node.geometry)geometries.add(node.geometry);for(const material of [node.material].flat().filter(Boolean)){materials.add(material);for(const value of Object.values(material))if(value?.isTexture)textures.add(value);}});
 for(const value of geometries)cleanup(()=>value.dispose());for(const value of materials)cleanup(()=>value.dispose());for(const value of textures){cleanup(()=>value.source?.data?.close?.());cleanup(()=>value.dispose());}
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
 } catch(error) { if(parsed?.scene)cleanup(()=>disposePresentation(parsed.scene));throw error; }
}

export async function preparePresentation(item,{retrieveResource,createLoader,retrieveAdapter,signal,randomAnimations=false,animationEnabled=()=>true,onStage=()=>{}}) {
 const urls=[],byPath=new Map(),extras=new Map();let parsed,adapter,diagnosticStage=null,stageStarted=0,failureCode=null;
 const clock=()=>{try{const n=performance.now();return Number.isFinite(n)?n:0;}catch{return 0;}};
 const finish=(code='ok',error=null)=>{if(!diagnosticStage)return;const status=Number.isInteger(error?.status)&&error.status>=(error?.bodyDecodeCode==='responseJsonInvalid'?100:400)&&error.status<=599?error.status:null;const detail=Object.freeze({stage:diagnosticStage,code:code==='failed'?(signal?.aborted?'aborted':error?.bodyDecodeCode==='responseJsonInvalid'?'responseJsonInvalid':status?'http_'+status:failureCode??diagnosticStage+'_failed'):code,durationMs:Math.min(600000,Math.max(0,Math.round(clock()-stageStarted))),...(status?{httpStatus:status}:{})});diagnosticStage=null;try{onStage(detail);}catch{/* Observation never changes resource custody. */}};
 const stage=name=>{finish();diagnosticStage=name;stageStarted=clock();failureCode=null;};
 try {
  for(const resource of item.manifest.resources){
   stage('fetch');signal?.throwIfAborted();const bytes=await retrieveResource(resource,signal);signal?.throwIfAborted();
   stage('hash');
   if(bytes.byteLength!==resource.bytes){failureCode='resource_size_mismatch';throw Error('Package resource size changed.');}
   const actual=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
   if(actual!==resource.sha256){failureCode='resource_digest_mismatch';throw Error('Package resource digest changed.');}
   const url=URL.createObjectURL(new Blob([bytes],{type:resource.mime}));urls.push(url);byPath.set(resource.path,{url,bytes});
  }
  stage('parse');const model=item.manifest.model,manager=new THREE.LoadingManager();let resourceFailed=false;
  manager.onError=()=>{resourceFailed=true;};
  manager.setURLModifier(url=>{if(urls.includes(url)||globalThis.location?.origin&&url.startsWith(`blob:${globalThis.location.origin}/`))return url;const entry=byPath.get(url);if(!entry)throw Error('The model requested an undeclared resource.');return entry.url;});
  const loader=createLoader(manager),data=byPath.get(model)?.bytes;if(!data)throw Error('The declared model resource is missing.');
  parsed=await loadPresentationAsset({retrieve:()=>data,parse:bytes=>loader.parseAsync(bytes,model.includes('/')?model.slice(0,model.lastIndexOf('/')+1):''),signal});
  if(resourceFailed)throw Error('A model texture could not be loaded. The previous appearance is retained.');
  let physicsProfile=null;
  if(item.manifest.schemaVersion==='1.5.0'){
   const recipe=item.manifest.worldDelta,physics=item.manifest.physics;if(!recipe||!physics)throw Error('Missing motion data.');
   const profileBytes=byPath.get(physics.profileResource)?.bytes;if(!profileBytes)throw Error('Missing physics profile.');physicsProfile=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(profileBytes));
   const parseResource=async path=>{if(extras.has(path))return extras.get(path);stage('parse');const resource=byPath.get(path);if(!resource)throw Error('Missing declared animation resource.');const value=await loadPresentationAsset({retrieve:()=>resource.bytes,parse:bytes=>loader.parseAsync(bytes,path.includes('/')?path.slice(0,path.lastIndexOf('/')+1):''),signal});extras.set(path,value);return value;};
   const reference=await parseResource(recipe.referenceResource),animationSources=[];
   for(const clip of recipe.animations)animationSources.push({...clip,parsed:await parseResource(clip.resource)});
   stage('adapter');signal?.throwIfAborted();const create=await loadTrustedPresentationAdapter(item,{retrieveAdapter,signal});signal?.throwIfAborted();
   if(!Number.isFinite(recipe.rotationY)||Math.abs(recipe.rotationY)>Math.PI)throw Error('Invalid model orientation.');parsed.scene.rotation.y+=recipe.rotationY;parsed.scene.updateMatrixWorld(true);parsed.scene.traverse(node=>{if(node.isSkinnedMesh)node.frustumCulled=false;});
   const overwritten=new Set([...physicsProfile.hairBones,...physicsProfile.softBones]);
   const overlays=[...(item.manifest.face?.gaze?.nodes?.map(n=>n.node)??[]),...(item.manifest.mouth?[item.manifest.mouth.node]:[])];
   for(const clipName of [item.manifest.face?.blink?.clip,...Object.values(item.manifest.speech?.poses??{})].filter(Boolean))for(const track of parsed.animations.find(c=>c.name===clipName)?.tracks??[])overlays.push(track.name.replace(/\.(?:position|quaternion|scale).*$/,''));
   if(overlays.some(name=>overwritten.has(name)))throw Error('Physics and speech or face ownership overlap.');
   adapter=create({THREE,targetRoot:parsed.scene,reference,animationSources,worldDelta:recipe,sourceVariant:item.manifest.sourceVariant,physicsProfile,physicsSettings:{hair:true,hairIntensity:1,collision:true,collisionIntensity:1,soft:true,softIntensity:1}});
   for(const method of ['update','setSettings','playCycle','playClip','pause','seek','suspend','dispose'])if(typeof adapter?.[method]!=='function')throw Error('Incomplete motion runtime.');signal?.throwIfAborted();
  }
  const value=createPresentation(parsed,item.manifest,{urls,label:item.label,randomAnimations,animationEnabled,adapter,ownedAssets:[...extras.values()]});value.id=item.id;value.digest=item.digest;finish();return value;
 } catch(error){finish('failed',error);cleanup(()=>adapter?.dispose?.());if(parsed?.scene)cleanup(()=>disposePresentation(parsed.scene));for(const extra of extras.values())cleanup(()=>disposePresentation(extra.scene));for(const url of urls)cleanup(()=>URL.revokeObjectURL(url));throw error;}
}

export function createPresentation(parsed,manifest,{urls=[],label,randomAnimations=false,animationEnabled=()=>true,adapter=null,ownedAssets=[]}={}) {
 const root=parsed.scene,mixer=new THREE.AnimationMixer(root);
 validateAnimationClips(adapter?{...manifest,animations:{},animationLibrary:undefined}:manifest,parsed.animations);
 const anchors=[];if(manifest.framing?.motionAnchor)root.traverse(node=>{if(node.name===manifest.framing.motionAnchor)anchors.push(node);});
 if(manifest.framing?.motionAnchor&&anchors.length!==1)throw Error('The declared motion anchor is missing or ambiguous.');
 // A bone can move beyond the bind-pose sphere while its mesh node stays still.
 // Anchored presentations keep authored motion without stale-sphere culling.
 if(anchors.length)root.traverse(node=>{if(node.isSkinnedMesh)node.frustumCulled=false;});
 const actions=new Map(parsed.animations.map(clip=>[clip.name,mixer.clipAction(clip)]));
 if(!adapter&&manifest.animations.idle&&!actions.has(manifest.animations.idle))throw Error('The declared idle animation is missing.');
 let mouth=null;if(manifest.mouth){const node=root.getObjectByName(manifest.mouth.node),index=node?.morphTargetDictionary?.[manifest.mouth.morph];if(index===undefined)throw Error('The declared mouth mapping is missing.');mouth={node,index,gain:manifest.mouth.gain};}
 const mouthClip=parsed.animations.find(clip=>clip.name===manifest.animations.mouthAmplitude);if(manifest.animations.mouthAmplitude&&!mouthClip)throw Error('The declared mouth animation is missing.');
 const mouthMixer=mouthClip?new THREE.AnimationMixer(root):null,mouthAction=mouthClip?mouthMixer.clipAction(mouthClip):null;
 if(mouthAction){mouthAction.setLoop(THREE.LoopOnce,1);mouthAction.clampWhenFinished=true;mouthAction.play();mouthAction.paused=true;}
 const speechMotion=manifest.speech?new SpeechMotion(root,parsed.animations,manifest.speech):null;
 const faceMotion=manifest.face?new FaceMotion(root,parsed.animations,manifest.face,[...(speechMotion?.tracks??[]),...(mouthClip?.tracks.map(t=>t.name)??[]),...(manifest.mouth?[manifest.mouth.node+'.morphTargetInfluences']:[])]):null;
 const value={root,mouth,mixer,actions,manifest,urls,label,mouthMixer,mouthAction,faceMotion,speechMotion,motionAnchor:anchors[0],adapter,ownedAssets};
 if(!adapter&&randomAnimations&&manifest.animationLibrary?.length)value.playlist=new AnimationPlaylist(value,{enabled:animationEnabled});
 return value;
}

// Restore overlays before body evaluation; speech owns the mouth, then face owns
// only its declared targets. Private authoring adapters may supply their own layers.
export function applyPresentationFrame(value,{sample,delta=0,bodyMotion=true,face,applyBody,applySpeech}={}) {
 if(!value)return;
 value.faceMotion?.beginFrame();value.speechMotion?.beginFrame();
 if(applyBody)applyBody(sample);else if(value.adapter)value.adapter.update(delta,{motionEnabled:bodyMotion});else{value.playlist?.update(delta,{paused:!bodyMotion});if(bodyMotion)value.mixer?.update(delta);}
 const level=sample?.playing?Math.min(1,sample.amplitude*5):0;
 if(value.mouthAction){value.mouthAction.time=level*value.mouthAction.getClip().duration;value.mouthMixer.update(0);}
 if(value.mouth?.node)value.mouth.node.morphTargetInfluences[value.mouth.index]=level*value.mouth.gain;else if(value.mouth)value.mouth.scale.y=1+level*10;
 if(applySpeech)applySpeech(sample);else value.speechMotion?.apply(sample);
 if(face)value.faceMotion?.apply(face);
}

export function releasePresentation(value) {
 if(!value||value.released)return;value.released=true;
 for(const attempt of [()=>value.faceMotion?.reset(),()=>value.speechMotion?.reset(),()=>value.adapter?.dispose(),...((value.ownedAssets??[]).map(extra=>()=>disposePresentation(extra.scene))),()=>value.playlist?.dispose(),()=>value.mouthMixer?.stopAllAction(),()=>value.mouthMixer?.uncacheRoot(value.root),()=>value.mixer?.stopAllAction(),()=>value.mixer?.uncacheRoot(value.root),()=>disposePresentation(value.root),...((value.urls??[]).map(url=>()=>URL.revokeObjectURL(url)))])cleanup(attempt);
}
