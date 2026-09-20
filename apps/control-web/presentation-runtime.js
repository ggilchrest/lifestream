import * as THREE from 'three';
import { GLTFLoader } from './GLTFLoader.js';
import { RoomEnvironment } from './RoomEnvironment.js';
import { BehaviorController } from './behavior-controller.js';

export function disposePresentation(root) {
 const geometries=new Set(),materials=new Set(),textures=new Set();
 root?.traverse(node=>{if(node.geometry)geometries.add(node.geometry);for(const material of [node.material].flat().filter(Boolean)){materials.add(material);for(const value of Object.values(material))if(value?.isTexture)textures.add(value);}});
 for(const value of geometries)value.dispose();for(const value of materials)value.dispose();for(const value of textures){value.source?.data?.close?.();value.dispose();}
}
export class PresentationRuntime {
 constructor(canvas,{onFailure=()=>{},playback=()=>null,identity=()=>null,onState=()=>{}}={}) {
  this.identity=identity;this.onState=onState;this.interaction='idle';
  this.onFailure=onFailure;this.playback=playback;this.generation=0;this.state='idle';this.disposed=false;this.pending=null;this.frames=[];
  this.renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'low-power'});
  this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;
  this.scene=new THREE.Scene();this.scene.background=new THREE.Color('#111f2e');this.camera=new THREE.PerspectiveCamera(34,1,.01,2000);
  const room=new RoomEnvironment(),pmrem=new THREE.PMREMGenerator(this.renderer);this.environment=pmrem.fromScene(room,.04);room.dispose();pmrem.dispose();this.scene.environment=this.environment.texture;this.scene.environmentIntensity=.3;
  this.scene.add(new THREE.HemisphereLight(0xeaf2ff,0x6b6060,.3));
  for(const [color,power,position] of [[0xfff0e4,1.8,[2.5,4,4]],[0xe4edff,.8,[-3,2.5,3]],[0xffffff,1.5,[1,3,-3]]]){const light=new THREE.DirectionalLight(color,power);light.position.set(...position);this.scene.add(light);}
  this.resize=new ResizeObserver(()=>this.size());this.resize.observe(canvas);this.size();
  this.lost=event=>{event.preventDefault();this.pause();this.onFailure('Display paused after graphics context loss. Text and speech remain available. Use Restart display to retry.');};canvas.addEventListener('webglcontextlost',this.lost);
  this.commit(this.neutral());this.last=performance.now();this.animate();
 }
 size(){const canvas=this.renderer.domElement,width=Math.max(1,canvas.clientWidth),height=Math.max(1,canvas.clientHeight);this.renderer.setSize(width,height,false);this.camera.aspect=width/height;this.camera.updateProjectionMatrix();if(this.current)this.frame(this.current);}
 neutral(){const root=new THREE.Group(),material=new THREE.MeshStandardMaterial({color:0x77d6cc,roughness:.6});const head=new THREE.Mesh(new THREE.SphereGeometry(.32,24,16),material);head.position.y=1.28;root.add(head);const body=new THREE.Mesh(new THREE.CapsuleGeometry(.22,.6,8,16),material);body.position.y=.65;root.add(body);const mouth=new THREE.Mesh(new THREE.BoxGeometry(.13,.025,.025),new THREE.MeshBasicMaterial({color:0x143534}));mouth.position.set(0,1.16,.3);root.add(mouth);return {root,mouth,manifest:{framing:{distance:1.2,targetHeight:.52},animations:{},capabilities:{lipSync:'amplitude',facialAnimation:false}},urls:[],label:'Neutral reference',mixer:null};}
 async prepare(item,signal) {
  if(!item||item.id==='neutral')return this.neutral();
  const urls=[],byPath=new Map();let parsed;
  try {
   // URLs are constructed from the authenticated resource allowlist, never from model-supplied hosts.
   for(const resource of item.manifest.resources){signal?.throwIfAborted();const route=`/api/runtime/v1/presentation/resources/${encodeURIComponent(item.id)}/${resource.path.split('/').map(encodeURIComponent).join('/')}`;const response=await fetch(route,{signal,credentials:'same-origin',cache:'no-store'});if(!response.ok)throw new Error('A package resource is unavailable.');const bytes=await response.arrayBuffer();if(bytes.byteLength!==resource.bytes)throw new Error('Package resource size changed.');const actual=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');if(actual!==resource.sha256)throw new Error('Package resource digest changed.');const url=URL.createObjectURL(new Blob([bytes],{type:resource.mime}));urls.push(url);byPath.set(resource.path,{url,bytes});}
   const model=item.manifest.model,manager=new THREE.LoadingManager();let resourceFailed=false;
   manager.onError=()=>{resourceFailed=true;};
   manager.setURLModifier(url=>{if(urls.includes(url)||url.startsWith(`blob:${location.origin}/`))return url;const entry=byPath.get(url);if(!entry)throw new Error('The model requested an undeclared resource.');return entry.url;});
   const loader=new GLTFLoader(manager),data=byPath.get(model).bytes;
   parsed=await loader.parseAsync(data,model.includes('/')?model.slice(0,model.lastIndexOf('/')+1):'');signal?.throwIfAborted();
   if(resourceFailed)throw new Error('A model texture could not be loaded. The previous appearance is retained.');
   const root=parsed.scene,mixer=new THREE.AnimationMixer(root),manifest=item.manifest;
   const actions=new Map(parsed.animations.map(clip=>[clip.name,mixer.clipAction(clip)]));
   if(manifest.animations.idle&&!actions.has(manifest.animations.idle))throw new Error('The declared idle animation is missing.');
   let mouth=null;if(manifest.mouth){const node=root.getObjectByName(manifest.mouth.node),index=node?.morphTargetDictionary?.[manifest.mouth.morph];if(index===undefined)throw new Error('The declared mouth mapping is missing.');mouth={node,index,gain:manifest.mouth.gain};}
   const mouthClip=parsed.animations.find(clip=>clip.name===manifest.animations.mouthAmplitude);if(manifest.animations.mouthAmplitude&&!mouthClip)throw new Error('The declared mouth animation is missing.');const mouthMixer=mouthClip?new THREE.AnimationMixer(root):null,mouthAction=mouthClip?mouthMixer.clipAction(mouthClip):null;if(mouthAction){mouthAction.setLoop(THREE.LoopOnce,1);mouthAction.clampWhenFinished=true;mouthAction.play();mouthAction.paused=true;}return {root,mouth,mixer,actions,manifest,urls,label:item.label,mouthMixer,mouthAction};
  } catch(error){if(parsed?.scene)disposePresentation(parsed.scene);for(const url of urls)URL.revokeObjectURL(url);throw error;}
 }
 release(value){if(!value)return;value.mouthMixer?.stopAllAction();value.mouthMixer?.uncacheRoot(value.root);value.mixer?.stopAllAction();value.mixer?.uncacheRoot(value.root);disposePresentation(value.root);for(const url of value.urls)URL.revokeObjectURL(url);}
 commit(value){const old=this.current;this.current=value;this.scene.add(value.root);if(old){this.scene.remove(old.root);this.release(old);}this.state='idle';this.renderState('idle');value.mixer?.update(0);this.frame(value);}
 frame(value){value.root.updateMatrixWorld(true);value.root.traverse(n=>{if(n.isSkinnedMesh)n.computeBoundingBox();});const box=new THREE.Box3().setFromObject(value.root);if(box.isEmpty())return;const size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3()),height=Math.max(size.y,.1);const target=new THREE.Vector3(center.x,box.min.y+height*value.manifest.framing.targetHeight,center.z);const distance=Math.max(height,size.x/this.camera.aspect)/(2*Math.tan(THREE.MathUtils.degToRad(17)))*value.manifest.framing.distance;this.camera.position.copy(target).add(new THREE.Vector3(Math.sin(value.manifest.framing.yaw??0)*distance,0,Math.cos(value.manifest.framing.yaw??0)*distance));this.camera.near=Math.max(.001,distance/1000);this.camera.far=Math.max(100,distance*10);this.camera.lookAt(target);this.camera.updateProjectionMatrix();}
 applyState(state){this.interaction=['idle','listening','preparing','generating','speaking','working','waiting','error','interrupted'].includes(state)?state:'idle';this.semanticKey=null;}
 renderState(state){const value=this.current;if(!value)return;this.state=state;const key=['listening','speaking'].includes(state)?state:'idle',name=value.manifest.animations[key]??value.manifest.animations.idle,action=value.actions?.get(name);if(action!==value.action){const previous=value.action;previous?.fadeOut(.15);if(action){action.reset().setEffectiveWeight(1);if(previous)action.fadeIn(.15);action.play();}value.action=action;}}
 animate(){if(this.disposed)return;this.animation=requestAnimationFrame(()=>this.animate());const now=performance.now(),delta=Math.min(.05,(now-this.last)/1000);this.last=now;if(document.hidden||this.renderer.domElement.getClientRects().length===0)return;const value=this.current,sample=this.playback(),identity=this.identity();
  if(identity?.assistantId&&identity?.endpointId){
   const scope=JSON.stringify(identity);if(scope!==this.behaviorScope){this.behaviorScope=scope;this.behavior=new BehaviorController({...identity,stateId:crypto.randomUUID(),interactionTraceId:sample?.trace??crypto.randomUUID()});this.semanticKey=null;}
   const signature=JSON.stringify([this.interaction,!!sample?.playing,sample?.trace??null]);
   if(signature!==this.semanticKey||sample?.playing&&now-(this.semanticAt??0)>1000){this.semanticKey=signature;this.semanticAt=now;this.semantic=this.behavior.update({interaction:this.interaction==='interrupted'?'idle':this.interaction,audioPlaying:!!sample?.playing,interrupted:this.interaction==='interrupted',attention:this.interaction==='idle'?'none':'participant',affect:{valence:0,arousal:0,confidence:1},now:new Date().toISOString(),...(sample?.trace?{interactionTraceId:sample.trace}:{})});}
   this.semantic=this.behavior.current(new Date().toISOString());this.renderState(this.semantic.activity==='error'?'failure':this.semantic.speechState==='silent'?'idle':this.semantic.speechState);this.onState(this.state,this.semantic);
  }
  value?.mixer?.update(delta);const level=sample?.playing?Math.min(1,sample.amplitude*5):0;if(value?.mouthAction){value.mouthAction.time=level*value.mouthAction.getClip().duration;value.mouthMixer.update(0);}if(value?.mouth?.node)value.mouth.node.morphTargetInfluences[value.mouth.index]=level*value.mouth.gain;else if(value?.mouth)value.mouth.scale.y=1+level*10;this.renderer.render(this.scene,this.camera);this.frames.push(Math.max(0,now-(this.renderedAt??now)));this.renderedAt=now;if(this.frames.length>600)this.frames.shift();}
 pause(){cancelAnimationFrame(this.animation);this.current?.mixer?.stopAllAction();if(this.current?.mouth?.node)this.current.mouth.node.morphTargetInfluences[this.current.mouth.index]=0;this.state='failure';}
 dispose(){this.disposed=true;this.pause();this.resize.disconnect();this.renderer.domElement.removeEventListener('webglcontextlost',this.lost);this.release(this.current);this.environment.dispose();this.renderer.dispose();}
}
