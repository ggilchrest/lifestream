import {preparePresentation,applyPresentationFrame,releasePresentation} from './presentation-core.js';
export {disposePresentation} from './presentation-core.js';
import {sampleFaceMotion} from './presentation-motion.js';
import * as THREE from 'three';
import { GLTFLoader } from './GLTFLoader.js';
import { RoomEnvironment } from './RoomEnvironment.js';
import {AnimationPlaylist} from './animation-playlist.js';
import { BehaviorController } from './behavior-controller.js';
import {animationForState,stateForPresentation,presentationStates} from './presentation-state.js';

export class PresentationRuntime {
 constructor(canvas,{onFailure=()=>{},playback=()=>null,identity=()=>null,onState=()=>{},retrieveResource,animationEnabled=()=>true,randomAnimations=false}={}) {
  this.randomAnimations=randomAnimations;this.animationEnabled=animationEnabled;this.identity=identity;this.onState=onState;this.retrieveResource=retrieveResource;this.interaction='idle';this.motionStartedAt=performance.now();this.reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');this.motionPreference=this.reducedMotion.matches;
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
  return preparePresentation(item,{signal,randomAnimations:this.randomAnimations,animationEnabled:clip=>this.animationEnabled(clip),createLoader:manager=>new GLTFLoader(manager),retrieveResource:async(resource,signal)=>{
   // Host-owned authenticated routing. The shared core cannot select another source.
   const route=`/api/runtime/v1/presentation/resources/${encodeURIComponent(item.id)}/${resource.path.split('/').map(encodeURIComponent).join('/')}`;
   if(this.retrieveResource)return this.retrieveResource(route,signal);
   const response=await fetch(route,{signal,credentials:'same-origin',cache:'no-store'});if(!response.ok)throw Error('A package resource is unavailable.');return response.arrayBuffer();
  }});
 }
 release(value){releasePresentation(value);}
 commit(value){this.endPreview();const old=this.current;this.current=value;this.scene.add(value.root);if(old){this.scene.remove(old.root);this.release(old);}this.state='idle';this.renderState('idle');value.mixer?.update(0);this.frame(value);}
 frame(value){value.root.updateMatrixWorld(true);value.root.traverse(n=>{if(n.isSkinnedMesh)n.computeBoundingBox();});const box=new THREE.Box3().setFromObject(value.root);if(box.isEmpty())return;const size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3()),height=Math.max(size.y,.1);const target=new THREE.Vector3(center.x,box.min.y+height*value.manifest.framing.targetHeight,center.z);const distance=Math.max(height,size.x/this.camera.aspect)/(2*Math.tan(THREE.MathUtils.degToRad(17)))*value.manifest.framing.distance;this.camera.position.copy(target).add(new THREE.Vector3(Math.sin(value.manifest.framing.yaw??0)*distance,0,Math.cos(value.manifest.framing.yaw??0)*distance));this.camera.near=Math.max(.001,distance/1000);this.camera.far=Math.max(100,distance*10);this.camera.lookAt(target);this.camera.updateProjectionMatrix();this.motionAnchorAt=value.motionAnchor?.getWorldPosition(new THREE.Vector3())??null;}
 followMotionAnchor(value){if(!value?.motionAnchor)return;const current=value.motionAnchor.getWorldPosition(new THREE.Vector3());if(this.motionAnchorAt)this.camera.position.add(current.clone().sub(this.motionAnchorAt));this.motionAnchorAt=current;}
 applyState(state){this.endPreview();this.interaction=['idle','listening','preparing','generating','speaking','working','waiting','error','interrupted'].includes(state)?state:'idle';this.semanticKey=null;}
 preview(state){if(!presentationStates.includes(state)||this.disposed||this.playback()?.playing)throw new Error('Animation preview is unavailable.');this.facePreview=null;if(this.current?.playlist){this.current.playlist.dispose();delete this.current.playlist;this.playlistPreview=true;}this.previewState={state,until:performance.now()+5000};this.renderState(state);return {...this.mapping};}
 previewFace(mode){if(!['blink','left','right','up','down','center'].includes(mode)||this.disposed||this.playback()?.playing)throw Error('Face preview is unavailable.');if(!(mode==='blink'?this.current?.manifest.face?.blink:this.current?.manifest.face?.gaze))throw Error('This appearance has no '+(mode==='blink'?'blink':'gaze')+' mapping.');this.endPreview();this.facePreview={mode,until:performance.now()+5000};return mode;}
 endPreview(){if(this.playlistPreview&&this.current){this.current.action?.stop();this.current.action=null;this.current.playlist=new AnimationPlaylist(this.current,{enabled:clip=>this.animationEnabled(clip)});}this.playlistPreview=false;this.previewState=null;this.facePreview=null;this.semanticKey=null;}
 renderState(state){const value=this.current;if(!value)return;if(value.playlist){this.state=state;this.mapping={requested:state,effective:'library',clip:value.playlist.current,degraded:false,transitionSeconds:value.manifest.transitionSeconds??.2};return;}for(const [clip,action] of value.actions??[])if(!this.animationEnabled(clip))action.stop();this.state=state;const mapping=this.mapping=animationForState(value.manifest,state),enabled=!mapping.clip||this.animationEnabled(mapping.clip),action=enabled?value.actions?.get(mapping.clip):undefined;if(this.reducedMotion.matches&&!this.previewState&&value.action&&enabled)return;if(action!==value.action){const previous=value.action;if(!enabled||mapping.transitionSeconds===0)previous?.stop();else previous?.fadeOut(mapping.transitionSeconds);if(action){action.reset().setEffectiveWeight(1);if(previous&&mapping.transitionSeconds>0)action.fadeIn(mapping.transitionSeconds);action.play();}value.action=action;}}
 animate(){if(this.disposed)return;this.animation=requestAnimationFrame(()=>this.animate());const now=performance.now(),delta=Math.min(.05,(now-this.last)/1000);this.last=now;if(document.hidden||this.renderer.domElement.getClientRects().length===0)return;const value=this.current,sample=this.playback(),identity=this.identity();if(this.motionPreference!==this.reducedMotion.matches){this.motionPreference=this.reducedMotion.matches;this.endPreview();}
  if(identity?.assistantId&&identity?.endpointId){
   const scope=JSON.stringify(identity);if(scope!==this.behaviorScope){this.behaviorScope=scope;this.behavior=new BehaviorController({...identity,stateId:crypto.randomUUID(),interactionTraceId:sample?.trace??crypto.randomUUID()});this.semanticKey=null;}
   const signature=JSON.stringify([this.interaction,!!sample?.playing,sample?.trace??null]);
   if(signature!==this.semanticKey||sample?.playing&&now-(this.semanticAt??0)>1000){this.semanticKey=signature;this.semanticAt=now;this.semantic=this.behavior.update({interaction:this.interaction==='interrupted'?'idle':this.interaction,audioPlaying:!!sample?.playing,interrupted:this.interaction==='interrupted',attention:this.interaction==='idle'?'none':'participant',affect:{valence:0,arousal:0,confidence:1},now:new Date().toISOString(),...(sample?.trace?{interactionTraceId:sample.trace}:{})});}
   this.semantic=this.behavior.current(new Date().toISOString());
  }
  if(this.previewState&&(now>=this.previewState.until||sample?.playing)||this.facePreview&&(now>=this.facePreview.until||sample?.playing))this.endPreview();
  this.renderState(this.previewState?.state??(this.semantic?stateForPresentation(this.semantic):'idle'));this.onState(this.state,this.semantic,{...this.mapping,preview:!!this.previewState,facePreview:this.facePreview?.mode??null,reducedMotion:this.reducedMotion.matches,bodyMotionPaused:this.reducedMotion.matches&&!this.previewState,face:{blink:!!value?.manifest.face?.blink,gaze:!!value?.manifest.face?.gaze}});
  const mode=this.facePreview?.mode,face=value?.faceMotion?(mode?{blink:mode==='blink'?1:0,gazeX:mode==='left'?-1:mode==='right'?1:0,gazeY:mode==='up'?1:mode==='down'?-1:0}:sampleFaceMotion((now-this.motionStartedAt)/1000,{blink:value.manifest.face?.blink,attention:this.interaction==='idle'?'none':'participant',reducedMotion:this.reducedMotion.matches})):null;
  applyPresentationFrame(value,{sample,delta,bodyMotion:!this.reducedMotion.matches||!!this.previewState,face});this.followMotionAnchor(value);this.renderer.render(this.scene,this.camera);this.frames.push(Math.max(0,now-(this.renderedAt??now)));this.renderedAt=now;if(this.frames.length>600)this.frames.shift();}
 pause(){this.endPreview();this.current?.faceMotion?.reset();this.current?.speechMotion?.reset();cancelAnimationFrame(this.animation);this.current?.mixer?.stopAllAction();if(this.current?.mouth?.node)this.current.mouth.node.morphTargetInfluences[this.current.mouth.index]=0;this.state='failure';}
 dispose(){this.disposed=true;this.pause();this.resize.disconnect();this.renderer.domElement.removeEventListener('webglcontextlost',this.lost);this.release(this.current);this.environment.dispose();this.renderer.dispose();}
}
