import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {AnimationPlaylist,ShuffleAnimations} from '../animation-playlist.js';

test('shuffle visits every enabled clip before repeating and avoids a boundary repeat',()=>{
 const bag=new ShuffleAnimations(()=>.3),names=['a','b','c'];let previous=null;const result=[];
 for(let i=0;i<12;i++){const next=bag.next(names,previous);assert.notEqual(next,previous);result.push(next);previous=next;}
 for(let i=0;i<12;i+=3)assert.deepEqual([...new Set(result.slice(i,i+3))].sort(),names);
 assert.equal(bag.next([],previous),null);assert.equal(bag.next(['b'],previous),'b');
});

function fixture(){
 const root=new THREE.Group(),body=new THREE.Object3D(),face=new THREE.Object3D();body.name='Body';face.name='Face';root.add(body,face);
 const idle=new THREE.AnimationClip('idle',2,[new THREE.NumberKeyframeTrack('Body.position[y]',[0,2],[1,2]),new THREE.NumberKeyframeTrack('Face.position[x]',[0,2],[0,0])]);
 const pose=new THREE.AnimationClip('smile',.03,[new THREE.NumberKeyframeTrack('Face.position[x]',[0,.03],[0,1])]);
 const wave=new THREE.AnimationClip('wave',.3,[new THREE.NumberKeyframeTrack('Body.position[y]',[0,.3],[1,3])]);
 const mixer=new THREE.AnimationMixer(root),clips=[idle,pose,wave],actions=new Map(clips.map(c=>[c.name,mixer.clipAction(c)]));
 return {root,body,face,mixer,actions,manifest:{animations:{idle:'idle'},animationLibrary:clips.map(c=>({clip:c.name,label:c.name})),transitionSeconds:0}};
}

test('short facial poses keep only unowned enabled idle tracks moving, then advance',()=>{
 const value=fixture(),enabled=new Set(['idle','smile']);const player=new AnimationPlaylist(value,{enabled:name=>enabled.has(name),random:()=>.99});
 player.update(.01);assert.equal(player.current,'smile');value.mixer.update(.01);
 for(let i=0;i<40;i++){player.update(.025);value.mixer.update(.025);}
 assert.ok(value.face.position.x>.99,'face pose is not diluted by idle tracks');assert.ok(value.body.position.y>1.3,'masked idle keeps body moving');
 player.update(1.1);assert.equal(player.current,'idle');
});

test('disabled clips stop immediately, all-off is still, pause does not advance and disposal releases actions',()=>{
 const value=fixture(),enabled=new Set(['smile','wave']);const player=new AnimationPlaylist(value,{enabled:name=>enabled.has(name),random:()=>0});
 player.update(.1);const first=player.current;player.update(100,{paused:true});assert.equal(player.current,first);
 enabled.delete(first);player.update(.1);assert.notEqual(player.current,first);assert.equal(value.actions.get(first).isRunning(),false);
 enabled.clear();player.update(.1);assert.equal(player.current,null);assert.equal([...value.actions.values()].filter(a=>a.isRunning()).length,0);
 player.dispose();assert.equal(player.current,null);
});


test('authored additive clips preserve a nonzero rest scale over the full idle baseline',()=>{
 const value=fixture(),delta=new THREE.AnimationClip('delta',.2,[new THREE.VectorKeyframeTrack('Body.scale',[0,.2],[0,0,0,0,0,0]),new THREE.NumberKeyframeTrack('Body.position[y]',[0,.2],[0,.1])]);
 value.actions.set('delta',value.mixer.clipAction(delta));value.manifest.animationLibrary.push({clip:'delta',label:'Delta',blendMode:'additive'});
 const player=new AnimationPlaylist(value,{enabled:name=>['idle','delta'].includes(name),random:()=>.99});player.update(.01);assert.equal(player.current,'delta');value.mixer.update(.1);
 assert.equal(value.body.scale.x,1);assert.ok(value.body.position.y>1);player.dispose();
});
