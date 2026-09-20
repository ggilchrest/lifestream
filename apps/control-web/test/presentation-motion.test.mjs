import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {FaceMotion,sampleFaceMotion} from '../presentation-motion.js';
function fixture(){
 const root=new THREE.Group(),eye=new THREE.Bone(),lid=new THREE.Bone(),mouth=new THREE.Bone(),body=new THREE.Bone();for(const [node,name] of [[eye,'Eye'],[lid,'Lid'],[mouth,'Mouth'],[body,'Body']]){node.name=name;root.add(node);}
 const closed=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),.5),clip=new THREE.AnimationClip('closed',1,[new THREE.QuaternionKeyframeTrack('Lid.quaternion',[0,1],[0,0,0,1,...closed.toArray()])]);
 const config={gaze:{nodes:[{node:'Eye',yawAxis:[0,1,0],pitchAxis:[1,0,0]}],yawLimit:.25,pitchLimit:.15},blink:{clip:'closed',periodSeconds:4,durationSeconds:.2}};
 return {root,eye,lid,mouth,body,clip,config};
}
test('face layers compose after current body pose without accumulating rotation or touching speech',()=>{
 const f=fixture(),motion=new FaceMotion(f.root,[f.clip],f.config,['Mouth.quaternion']),base=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),.2);
 for(let frame=0;frame<100;frame++){motion.beginFrame();f.eye.quaternion.copy(base);f.mouth.rotation.x=.4;f.body.position.x=2;motion.apply({gazeX:1,gazeY:0,blink:1});assert.ok(Math.abs(f.eye.quaternion.angleTo(base)-.25)<1e-6);assert.ok(Math.abs(f.lid.rotation.x-.5)<1e-6);assert.equal(f.mouth.rotation.x,.4);assert.equal(f.body.position.x,2);}
 motion.reset();assert.ok(f.eye.quaternion.angleTo(base)<1e-6);assert.ok(f.lid.quaternion.angleTo(new THREE.Quaternion())<1e-6);assert.equal(f.mouth.rotation.x,.4);
 motion.apply({gazeX:100,gazeY:-100,blink:0});assert.ok(f.eye.quaternion.angleTo(base)<.3);motion.beginFrame();motion.apply({gazeX:0,gazeY:0,blink:0});assert.ok(f.eye.quaternion.angleTo(base)<1e-6);
});
test('mapped facial layers fail closed for ambiguity, unsupported tracks, invalid axes and competing owners',()=>{
 const f=fixture();assert.throws(()=>new FaceMotion(f.root,[f.clip],f.config,['Lid.quaternion']),/ownership/);
 assert.throws(()=>new FaceMotion(f.root,[f.clip],f.config,['Eye.quaternion']),/ownership/);
 const duplicate=f.eye.clone();f.root.add(duplicate);assert.throws(()=>new FaceMotion(f.root,[f.clip],f.config),/ambiguous/);f.root.remove(duplicate);
 assert.throws(()=>new FaceMotion(f.root,[],f.config),/clip/);assert.throws(()=>new FaceMotion(f.root,[f.clip,f.clip],f.config),/clip/);
 assert.throws(()=>new FaceMotion(f.root,[f.clip],{...f.config,gaze:{...f.config.gaze,nodes:[{node:'Eye',yawAxis:[0,0,0],pitchAxis:[1,0,0]}]}}),/axis/);
 const conflict=f.clip.clone();conflict.tracks[0].name='Eye.quaternion';assert.throws(()=>new FaceMotion(f.root,[conflict],f.config),/ownership/);
 const unsupported=new THREE.AnimationClip('closed',1,[new THREE.NumberKeyframeTrack('Lid.visible',[0,1],[1,0])]);assert.throws(()=>new FaceMotion(f.root,[unsupported],f.config),/track/);
});
test('ambient face motion is bounded, deterministic, attention-sensitive and disabled by reduced motion',()=>{
 const blink={periodSeconds:4,durationSeconds:.2};const first=sampleFaceMotion(3.9,{blink,attention:'participant'});assert.ok(first.blink>.99);assert.equal(first.gazeX,0);assert.equal(first.gazeY,0);assert.deepEqual(first,sampleFaceMotion(3.9,{blink,attention:'participant'}));assert.equal(sampleFaceMotion(0,{blink}).blink,0);
 for(let n=0;n<100;n++){const v=sampleFaceMotion(n/10,{blink,attention:'none'});assert.ok(Math.abs(v.gazeX)<=.25&&Math.abs(v.gazeY)<=.15&&v.blink>=0&&v.blink<=1);}
 assert.deepEqual(sampleFaceMotion(3.9,{blink,reducedMotion:true}),{blink:0,gazeX:0,gazeY:0});assert.deepEqual(sampleFaceMotion(NaN,{blink}),{blink:0,gazeX:0,gazeY:0});
});
