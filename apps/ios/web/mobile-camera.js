import * as THREE from 'three';

export const defaultView=()=>({yaw:0,pitch:0,zoom:1,panX:0,panY:0});
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
export function adjustMobileView(view,{yaw=0,pitch=0,zoom=1,panX=0,panY=0}={}){
 if(![yaw,pitch,zoom,panX,panY].every(Number.isFinite)||zoom<=0)return false;
 view.yaw=(view.yaw+yaw)%(2*Math.PI);view.pitch=clamp(view.pitch+pitch,-.8,.8);view.zoom=clamp(view.zoom*zoom,.45,3);view.panX=clamp(view.panX+panX,-1,1);view.panY=clamp(view.panY+panY,-1,1);return true;
}
// Follow a centrally located generic pelvis/hip joint when a package does not
// declare its own motion anchor. This is camera-only and does not alter bones.
export function findBodyAnchor(value){
 value.root.updateMatrixWorld(true);const box=new THREE.Box3().setFromObject(value.root);if(box.isEmpty())return null;
 const size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3()),height=Math.max(size.y,.1);let best=null,score=Infinity;
 value.root.traverse(node=>{if(!node.isBone||!/(^|[^a-z])(?:hip|hips|pelvis)(?:[^a-z]|$)/i.test(node.name))return;
  const p=node.getWorldPosition(new THREE.Vector3()),relative=(p.y-box.min.y)/height;if(relative<.2||relative>.8)return;
  const n=Math.abs(p.x-center.x)/Math.max(size.x,.1)+Math.abs(p.z-center.z)/Math.max(size.z,.1)+Math.abs(relative-.55);if(n<score){score=n;best=node;}
 });return best;
}

// The default crop matches Daily. The authored option keeps the original mobile
// camera at rest; a build-owned, generic option chooses it without model names.
export function frameMobileCamera(camera,value,view,authored=false){
 value.root.updateMatrixWorld(true);
 // Skin bounds can cost tens of milliseconds. Compute once per loaded model;
 // translate them with the selected motion anchor as the animation moves.
 if(!value.mobileFrameBounds){
  value.root.traverse(node=>{if(node.isSkinnedMesh)node.computeBoundingBox();});
  const original=new THREE.Box3().setFromObject(value.root);if(original.isEmpty())return null;
  value.mobileFrameBounds={box:original,anchor:value.motionAnchor?.getWorldPosition(new THREE.Vector3())??null};
 }
 const box=value.mobileFrameBounds.box.clone();
 if(value.motionAnchor&&value.mobileFrameBounds.anchor)box.translate(value.motionAnchor.getWorldPosition(new THREE.Vector3()).sub(value.mobileFrameBounds.anchor));
 const size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3()),height=Math.max(size.y,.1),framing=value.manifest.framing;
 const yaw=(framing.yaw??0)+view.yaw,pitch=view.pitch,tangent=Math.tan(THREE.MathUtils.degToRad(camera.fov/2));
 const orbit=new THREE.Vector3(Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch));
 const right=new THREE.Vector3(Math.cos(yaw),0,-Math.sin(yaw)),up=new THREE.Vector3().crossVectors(orbit,right);
 let target,fit;
 if(authored){target=new THREE.Vector3(center.x,box.min.y+height*framing.targetHeight,center.z);fit=Math.max(height,size.x/camera.aspect)/(2*tangent)*framing.distance;}
 else{
  const waist=new THREE.Vector3(center.x,box.min.y+height*.6,center.z);fit=.1;
  for(const x of [box.min.x,box.max.x])for(const y of [waist.y,box.max.y+height*.05])for(const z of [box.min.z,box.max.z]){
   const corner=new THREE.Vector3(x,y,z).sub(waist),depth=corner.dot(orbit);
   fit=Math.max(fit,(corner.dot(up)+tangent*depth)/(2*tangent),depth+Math.abs(corner.dot(right))/(camera.aspect*tangent),depth+.01);
  }
  target=waist.clone().addScaledVector(up,fit*tangent);
 }
 target.addScaledVector(right,view.panX*height).addScaledVector(up,view.panY*height);
 const distance=fit*view.zoom;camera.position.copy(target).addScaledVector(orbit,distance);camera.near=Math.max(.001,distance/1000);camera.far=Math.max(100,distance*10);camera.lookAt(target);camera.updateProjectionMatrix();
 return value.motionAnchor?.getWorldPosition(new THREE.Vector3())??null;
}

// Pointer capture is confined to the canvas. Cancellation, replacement, a third
// finger and lost capture end the gesture instead of reusing stale positions.
export function installMobileGestures(canvas,{adjust,reset,active=()=>true}){
 let points=new Map(),model=null;const cancel=()=>{points.clear();model=null;};
 const geometry=()=>{const p=[...points.values()];if(p.length!==2)return null;return {x:(p[0].x+p[1].x)/2,y:(p[0].y+p[1].y)/2,d:Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y)};};
 const handlers={
  pointerdown:e=>{if(!active()||e.button!==0)return;if(points.size>=2){cancel();return;}points.set(e.pointerId,{x:e.clientX,y:e.clientY});model=true;try{canvas.setPointerCapture?.(e.pointerId);}catch{}e.preventDefault();},
  pointermove:e=>{if(!model||!active()||!points.has(e.pointerId))return;const before=geometry(),old=points.get(e.pointerId);points.set(e.pointerId,{x:e.clientX,y:e.clientY});const after=geometry();
   if(before&&after&&before.d>1&&after.d>1)adjust({panX:-(after.x-before.x)/Math.max(canvas.clientWidth,1),panY:(after.y-before.y)/Math.max(canvas.clientHeight,1),zoom:before.d/after.d});
   else if(points.size===1)adjust({yaw:-(e.clientX-old.x)/200,pitch:(e.clientY-old.y)/200});e.preventDefault();},
  pointerup:e=>{points.delete(e.pointerId);if(!points.size)model=null;},pointercancel:cancel,lostpointercapture:cancel,
  keydown:e=>{let change;if(e.key==='Home'){reset();e.preventDefault();return;}if(['+','=','-'].includes(e.key))change={zoom:e.key==='-'?1.12:1/1.12};else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){const x=e.key==='ArrowLeft'?-.1:e.key==='ArrowRight'?.1:0,y=e.key==='ArrowUp'?-.1:e.key==='ArrowDown'?.1:0;change=e.shiftKey?{panX:-x,panY:y}:{yaw:x,pitch:y};}else return;if(active()){adjust(change);e.preventDefault();}}
 };
 for(const [name,handler] of Object.entries(handlers))canvas.addEventListener(name,handler);
 return {cancel,dispose(){cancel();for(const [name,handler] of Object.entries(handlers))canvas.removeEventListener(name,handler);}};
}
