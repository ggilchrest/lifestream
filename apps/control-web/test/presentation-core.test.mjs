import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {loadPresentationAsset,preparePresentation,createPresentation,applyPresentationFrame,releasePresentation,disposePresentation} from '../presentation-core.js';
const digest=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
function fixture(){
 const root=new THREE.Group(),mouth=new THREE.Bone(),body=new THREE.Bone();mouth.name='Mouth';body.name='Body';root.add(mouth,body);
 const animations=[new THREE.AnimationClip('open',1,[new THREE.VectorKeyframeTrack('Mouth.scale',[0,1],[1,1,1,1,6,1])]),new THREE.AnimationClip('body',1,[new THREE.VectorKeyframeTrack('Body.position',[0,1],[0,0,0,1,0,0])])];
 const manifest={animations:{idle:'body',mouthAmplitude:'open'},speech:{cueSet:'bounded',poses:{A:'open'},transitionSeconds:0}};
 return {root,mouth,body,animations,manifest};
}
const cue={playing:true,amplitude:.1,clock:'AudioContext.currentTime',trace:'turn',segmentId:'speech',sampleOffset:0,cueSet:'bounded',viseme:'A'};
test('shared core preserves clip identities, exact cue-to-amplitude handoff and reduced-motion body freeze',()=>{
 const f=fixture(),value=createPresentation({scene:f.root,animations:f.animations},f.manifest);value.actions.get('body').play();
 assert.equal(value.actions.get('body').getClip(),f.animations[1]);
 applyPresentationFrame(value,{sample:cue,delta:.25});assert.equal(f.mouth.scale.y,6);assert.equal(f.body.position.x,.25);
 applyPresentationFrame(value,{sample:{playing:true,amplitude:.05},delta:.25,bodyMotion:false});assert.equal(f.mouth.scale.y,2.25);assert.equal(f.body.position.x,.25);
 applyPresentationFrame(value,{sample:{playing:false},delta:.25});assert.equal(f.mouth.scale.y,1);assert.equal(f.body.position.x,.5);
 releasePresentation(value);assert.equal(value.mixer.stats.actions.inUse,0);
});
test('private host adapters share restore/body/speech/face ownership order using one clock snapshot',()=>{
 const order=[],sample={playing:true,time:1.125};let seen;
 applyPresentationFrame({faceMotion:{beginFrame(){order.push('restore-face');},apply(value){order.push('face');assert.equal(value.blink,1);}},speechMotion:{beginFrame(){order.push('restore-speech');}}},{sample,face:{blink:1},applyBody:value=>{order.push('body');seen=value;},applySpeech:value=>{order.push('speech');assert.equal(value,seen);}});
 assert.deepEqual(order,['restore-face','restore-speech','body','speech','face']);assert.equal(seen,sample);
});
test('parsed resources are disposed when cancellation wins after asynchronous parse',async()=>{
 const root=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial()),abort=new AbortController();let disposed=0,finish;
 root.geometry.addEventListener('dispose',()=>disposed++);const pending=loadPresentationAsset({signal:abort.signal,retrieve:()=>new ArrayBuffer(0),parse:()=>new Promise(resolve=>{finish=resolve;})});
 await new Promise(resolve=>setImmediate(resolve));abort.abort();finish({scene:root});await assert.rejects(pending,{name:'AbortError'});assert.equal(disposed,1);
 let retrieved=false;await assert.rejects(loadPresentationAsset({signal:abort.signal,retrieve:()=>{retrieved=true;},parse(){}}),{name:'AbortError'});assert.equal(retrieved,false);
});
test('declared resource integrity and dependency allowlist reject unapproved bytes before parsing',async()=>{
 const bytes=new TextEncoder().encode('synthetic'),f=fixture(),manifest={...f.manifest,model:'model.glb',resources:[{path:'model.glb',bytes:bytes.byteLength,sha256:await digest(bytes),mime:'model/gltf-binary'}]};let manager,parses=0;
 const options={retrieveResource:async()=>bytes,createLoader:value=>{manager=value;return {parseAsync:async()=>{parses++;return {scene:f.root,animations:f.animations};}};}};
 const value=await preparePresentation({manifest,label:'fixture'},options);assert.equal(value.root,f.root);assert.throws(()=>manager.resolveURL('https://foreign.invalid/asset'),/undeclared/);assert.ok(manager.resolveURL('model.glb').startsWith('blob:'));releasePresentation(value);
 for(const resource of [{...manifest.resources[0],bytes:1},{...manifest.resources[0],sha256:'0'.repeat(64)}]){await assert.rejects(preparePresentation({manifest:{...manifest,resources:[resource]}},options),/changed/);}
 assert.equal(parses,1);
});
test('failed texture resolution disposes prepared geometry and revokes bounded object URLs',async()=>{
 const f=fixture(),mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());f.root.add(mesh);let disposed=0;mesh.geometry.addEventListener('dispose',()=>disposed++);
 const bytes=new Uint8Array([0]),manifest={...f.manifest,model:'model.glb',resources:[{path:'model.glb',bytes:1,sha256:await digest(bytes),mime:'model/gltf-binary'}]};
 const original=URL.revokeObjectURL,revoked=[];URL.revokeObjectURL=url=>{revoked.push(url);original(url);};
 try{await assert.rejects(preparePresentation({manifest},{retrieveResource:()=>bytes,createLoader:manager=>({parseAsync:async()=>{manager.onError('fixture');return {scene:f.root,animations:f.animations};}})}),/texture/);assert.equal(disposed,1);assert.equal(revoked.length,1);}finally{URL.revokeObjectURL=original;}
});
test('shared disposal releases unique geometry, materials, bitmap and texture once across meshes',()=>{
 const root=new THREE.Group(),geometry=new THREE.BoxGeometry(),material=new THREE.MeshBasicMaterial(),texture=new THREE.Texture();let geometries=0,materials=0,textures=0,bitmaps=0;
 texture.source.data={close(){bitmaps++;}};material.map=texture;root.add(new THREE.Mesh(geometry,material),new THREE.Mesh(geometry,material));geometry.addEventListener('dispose',()=>geometries++);material.addEventListener('dispose',()=>materials++);texture.addEventListener('dispose',()=>textures++);
 const value={root};releasePresentation(value);releasePresentation(value);assert.deepEqual([geometries,materials,textures,bitmaps],[1,1,1,1]);disposePresentation(null);
});
test('opted-in library playback honors enabled clips, reduced motion and release without changing desktop defaults',()=>{
 const make=()=>{const f=fixture();f.manifest.animationLibrary=[{clip:'body',label:'Body'}];return f;};
 const desktop=make(),normal=createPresentation({scene:desktop.root,animations:desktop.animations},desktop.manifest);assert.equal(normal.playlist,undefined);releasePresentation(normal);
 const f=make();let enabled=true;const value=createPresentation({scene:f.root,animations:f.animations},f.manifest,{randomAnimations:true,animationEnabled:()=>enabled});assert.ok(value.playlist);
 applyPresentationFrame(value,{delta:.25});assert.equal(value.playlist.current,'body');assert.equal(f.body.position.x,.25);
 const remaining=value.playlist.remaining;applyPresentationFrame(value,{delta:8,bodyMotion:false});assert.equal(f.body.position.x,.25);assert.equal(value.playlist.remaining,remaining);
 enabled=false;applyPresentationFrame(value,{delta:0,bodyMotion:false});assert.equal(value.playlist.current,null);assert.equal(f.body.position.x,0);
 enabled=true;applyPresentationFrame(value,{delta:.1});assert.equal(value.playlist.current,'body');releasePresentation(value);assert.equal(value.mixer.stats.actions.inUse,0);assert.equal(value.playlist.current,null);
});
test('motion anchor requires exactly one scene node and retains authored translations',()=>{
 const f=fixture();f.manifest.framing={motionAnchor:'Body'};const value=createPresentation({scene:f.root,animations:f.animations},f.manifest);assert.equal(value.motionAnchor,f.body);value.actions.get('body').play();applyPresentationFrame(value,{delta:.5});assert.equal(value.motionAnchor.position.x,.5);releasePresentation(value);
 for(const ambiguous of [false,true]){const f=fixture();f.manifest.framing={motionAnchor:'Anchor'};if(ambiguous)for(let i=0;i<2;i++){const node=new THREE.Group();node.name='Anchor';f.root.add(node);}assert.throws(()=>createPresentation({scene:f.root,animations:f.animations},f.manifest),/motion anchor.*missing or ambiguous/i);}
});
