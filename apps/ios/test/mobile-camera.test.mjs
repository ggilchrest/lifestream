import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {adjustMobileView,defaultView,findBodyAnchor,frameMobileCamera,installMobileGestures} from '../web/mobile-camera.js';
function fixture(aspect){const root=new THREE.Group(),mesh=new THREE.Mesh(new THREE.BoxGeometry(1,2,.5),new THREE.MeshBasicMaterial());root.add(mesh);const value={root,manifest:{framing:{distance:1.2,targetHeight:.5,yaw:0}}},camera=new THREE.PerspectiveCamera(34,aspect,.01,2000);return {value,camera,mesh};}
for(const aspect of [.55,1,2])test(`waist crop and authored framing remain finite at aspect ${aspect}`,()=>{
 const {value,camera,mesh}=fixture(aspect),view=defaultView();frameMobileCamera(camera,value,view);camera.updateMatrixWorld(true);
 const waist=new THREE.Vector3(0,.2,0).project(camera),head=new THREE.Vector3(0,1,.0).project(camera);assert.ok(waist.y<-.5&&waist.y>=-1.01);assert.ok(head.y<1&&head.y>waist.y);assert.ok(camera.position.toArray().every(Number.isFinite));
 frameMobileCamera(camera,value,view,true);const expected= Math.max(2,1/aspect)/(2*Math.tan(THREE.MathUtils.degToRad(17)))*1.2;assert.ok(Math.abs(camera.position.z-expected)<1e-9);assert.ok(Math.abs(camera.position.y)<1e-9);
 mesh.geometry.dispose();mesh.material.dispose();
});
test('orbit, pan and zoom are bounded, reject invalid input and do not move model bones',()=>{
 const {value,camera,mesh}=fixture(.7),view=defaultView(),before=value.root.position.clone();assert.equal(adjustMobileView(view,{yaw:20,pitch:10,zoom:100,panX:9,panY:-9}),true);assert.equal(view.pitch,.8);assert.equal(view.zoom,3);assert.equal(view.panX,1);assert.equal(view.panY,-1);frameMobileCamera(camera,value,view);assert.ok(camera.position.toArray().every(Number.isFinite));assert.ok(value.root.position.equals(before));assert.equal(adjustMobileView(view,{zoom:NaN}),false);assert.equal(adjustMobileView(view,{zoom:0}),false);mesh.geometry.dispose();mesh.material.dispose();
});
test('one finger peeks, two fingers pinch and pan; cancellation and disposal retire input',()=>{
 const handlers=new Map(),calls=[],canvas={clientWidth:400,clientHeight:300,addEventListener:(n,f)=>handlers.set(n,f),removeEventListener:n=>handlers.delete(n),setPointerCapture(){}};const c=installMobileGestures(canvas,{adjust:v=>calls.push(v),reset:()=>calls.push('reset')});
 const emit=(name,id,x,y,extra={})=>handlers.get(name)?.({pointerId:id,clientX:x,clientY:y,button:0,preventDefault(){},...extra});
 emit('pointerdown',1,100,100);emit('pointermove',1,140,120);assert.ok(calls[0].yaw<0&&calls[0].pitch>0);
 emit('pointerdown',2,200,100);emit('pointermove',2,240,130);assert.ok(calls[1].zoom<1);assert.ok(Number.isFinite(calls[1].panX));
 emit('pointercancel',1,0,0);const n=calls.length;emit('pointermove',2,250,140);assert.equal(calls.length,n);emit('pointerdown',3,10,10);c.cancel();emit('pointermove',3,30,30);assert.equal(calls.length,n);emit('keydown',0,0,0,{key:'Home'});assert.equal(calls.at(-1),'reset');c.dispose();assert.equal(handlers.size,0);
});


test('generic body anchor follows a central joint without changing a model rig',()=>{
 const {value,mesh}=fixture(1),hip=new THREE.Bone(),other=new THREE.Bone();hip.name='Pelvis';hip.position.y=.1;other.name='HipHelper';other.position.x=.4;value.root.add(hip,other);assert.equal(findBodyAnchor(value),hip);assert.equal(hip.position.y,.1);mesh.geometry.dispose();mesh.material.dispose();
});


test('cached model bounds follow anchor motion without recalculating or mutating the original box',()=>{
 const {value,camera,mesh}=fixture(1),hip=new THREE.Bone();hip.name='Pelvis';value.root.add(hip);value.motionAnchor=hip;const view=defaultView();frameMobileCamera(camera,value,view);const first=camera.position.clone(),bounds=value.mobileFrameBounds.box.clone();hip.position.x=.3;frameMobileCamera(camera,value,view);assert.ok(Math.abs(camera.position.x-first.x-.3)<1e-9);assert.ok(value.mobileFrameBounds.box.equals(bounds));mesh.geometry.dispose();mesh.material.dispose();
});
