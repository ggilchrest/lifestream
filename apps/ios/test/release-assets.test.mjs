import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import * as THREE from 'three';
import {createPresentation,preparePresentation,releasePresentation} from '../../control-web/presentation-core.js';
import {releaseAppearancePlan,contextLossResultAccepted} from '../scripts/release-asset-probe.js';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const source=fileURLToPath(new URL('../../../',import.meta.url));
const script=fileURLToPath(new URL('../scripts/verify-release-assets.mjs',import.meta.url));
test('required adapter context-loss check is independent of catalog order and a final legacy item',()=>{
 const neutral={id:'neutral'},legacy={id:'legacy',manifest:{schemaVersion:'1.4.0'}},a={id:'adapter-a',manifest:{schemaVersion:'1.5.0'}},b={id:'adapter-b',manifest:{schemaVersion:'1.5.0'}};
 for(const packages of [[a,b,legacy],[legacy,b,a],[b,legacy,a]]){
  const plan=releaseAppearancePlan({neutral,packages});assert.equal(plan.transitionPairs.length,6);assert.ok(plan.transitionPairs.some(x=>x.from==='adapter-a'&&x.to==='adapter-b'));assert.ok(plan.transitionPairs.some(x=>x.from==='adapter-b'&&x.to==='adapter-a'));assert.equal(plan.contextLossAdapterId,'adapter-a');assert.equal(plan.appearanceIds.at(-1),'adapter-a');assert.equal(new Set(plan.appearanceIds).size,4);
 }
 assert.throws(()=>releaseAppearancePlan({neutral,packages:[a,a]}),/unique/);
});
test('context-loss result refuses skipped, failed and wrong-target checks; notApplicable requires no adapter',()=>{
 for(const result of [{status:'notRun'},{status:'notApplicable'},{status:'failed',id:'adapter-a'},{status:'passed',id:'adapter-b'}])assert.equal(contextLossResultAccepted('adapter-a',result),false);
 assert.equal(contextLossResultAccepted('adapter-a',{status:'passed',id:'adapter-a'}),true);
 const plan=releaseAppearancePlan({neutral:{id:'neutral'},packages:[{id:'legacy',manifest:{schemaVersion:'1.4.0'}}]});assert.equal(plan.contextLossAdapterId,null);assert.equal(contextLossResultAccepted(plan.contextLossAdapterId,{status:'notApplicable'}),true);assert.equal(contextLossResultAccepted(plan.contextLossAdapterId,{status:'notRun'}),false);
});
test('adapter body clips remain external while embedded mouth clips must be present exactly once',()=>{
 const manifest={schemaVersion:'1.5.0',animations:{idle:'external-idle',mouthAmplitude:'mouth'},animationLibrary:[{clip:'external-idle'}]};
 for(const count of [0,2]){
  const scene=new THREE.Group(),animations=Array.from({length:count},()=>new THREE.AnimationClip('mouth',1,[]));
  assert.throws(()=>createPresentation({scene,animations},manifest,{adapter:{}}),/missing or ambiguous/);
 }
 const clip=new THREE.AnimationClip('mouth',1,[]),value=createPresentation({scene:new THREE.Group(),animations:[clip]},manifest,{adapter:{}});
 assert.equal(value.mouthAction.getClip(),clip);assert.equal(value.playlist,undefined);releasePresentation(value);
});
for(const failing of [2,3])test(`reference/clip loader failure ${failing} refuses before adapter and releases every new asset`,async()=>{
 let disposed=0,adapterRequests=0,revoked=0;
 const bytes=[new Uint8Array([1]),new Uint8Array([2]),new Uint8Array([3]),new TextEncoder().encode('{"hairBones":[],"softBones":[]}')];
 const paths=['model.glb','reference.glb','clip.glb','physics.json'];
 const resources=paths.map((path,n)=>({path,bytes:bytes[n].length,sha256:sha(bytes[n]),mime:path.endsWith('.glb')?'model/gltf-binary':'application/json'}));
 const item={id:'sample',digest:'a'.repeat(64),manifest:{schemaVersion:'1.5.0',model:'model.glb',resources,animations:{idle:'external'},physics:{profileResource:'physics.json'},worldDelta:{referenceResource:'reference.glb',animations:[{resource:'clip.glb',clipName:'external',sourceAnimationId:'sample'}],rotationY:0}},trustedRuntime:{kind:'world-delta.v1',bytes:1,sha256:sha(new Uint8Array([0]))}};
 let oldDisposed=0;const oldRoot=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());oldRoot.geometry.addEventListener('dispose',()=>oldDisposed++);
 const previous={root:oldRoot};let current=previous;
 const originalRevoke=URL.revokeObjectURL;URL.revokeObjectURL=url=>{revoked++;originalRevoke(url);};
 try{
  await assert.rejects(preparePresentation(item,{retrieveResource:r=>bytes[paths.indexOf(r.path)],retrieveAdapter:()=>{adapterRequests++;throw Error('Adapter must not be entered.');},createLoader:manager=>({parseAsync:async data=>{const mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());mesh.geometry.addEventListener('dispose',()=>disposed++);if(data[0]===failing)manager.onError('synthetic failed dependency');return {scene:mesh,animations:[]};}})}).then(candidate=>{current=candidate;}),/texture could not be loaded/);
  assert.equal(adapterRequests,0);assert.equal(disposed,3);assert.equal(revoked,4);assert.equal(current,previous);assert.equal(oldDisposed,0);
 }finally{URL.revokeObjectURL=originalRevoke;releasePresentation(previous);}
});
test('release continues across throwing independent disposers and repeated release does no more work',()=>{
 let geometry=0,adapter=0,mixer=0,revoked=0;const root=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());root.geometry.addEventListener('dispose',()=>geometry++);
 const value={root,adapter:{dispose(){adapter++;throw Error('synthetic adapter disposer');}},faceMotion:{reset(){throw Error('synthetic face disposer');}},mixer:{stopAllAction(){mixer++;},uncacheRoot(){}},urls:['blob:synthetic']};
 const original=URL.revokeObjectURL;URL.revokeObjectURL=()=>revoked++;
 try{releasePresentation(value);releasePresentation(value);assert.deepEqual({geometry,adapter,mixer,revoked},{geometry:1,adapter:1,mixer:1,revoked:1});}finally{URL.revokeObjectURL=original;}
});
for(const fault of ['neutral-catalog','missing-model','changed-model'])test(`all-assets release gate refuses ${fault} before any browser starts`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'ios-release-assets-')),pub=join(root,'public');await mkdir(pub);
 const data=Buffer.from('synthetic'),item={id:'sample',digest:'a'.repeat(64),manifest:{schemaVersion:'1.4.0',model:'model.glb',animations:{},resources:[{path:'model.glb',bytes:data.length,sha256:sha(data)}]}},catalog={schemaVersion:'1.0.0',neutral:{id:'neutral'},packages:[item]};
 try{
  await writeFile(join(root,'required.json'),JSON.stringify(catalog));await writeFile(join(pub,'bundled-appearances.json'),JSON.stringify(fault==='neutral-catalog'?{...catalog,packages:[]}:catalog));
  const names=['animation-playlist.js','presentation-runtime.js','presentation-core.js','presentation-motion.js','presentation-speech.js','presentation-state.js','presentation-trusted-adapter.js','packages/runtime/src/embodiment/controller.ts'],shared=[];
  for(const path of names)shared.push({path,sha256:sha(await readFile(join(source,path.startsWith('packages/')?path:'apps/control-web/'+path)))});
  await writeFile(join(pub,'shared-renderer-manifest.json'),JSON.stringify({shared}));
  if(fault==='changed-model'){await mkdir(join(pub,'appearances/sample'),{recursive:true});await writeFile(join(pub,'appearances/sample/model.glb'),Buffer.alloc(data.length));}
  const run=spawnSync(process.execPath,[script,'--source',source,'--public',pub,'--expected-catalog',join(root,'required.json'),'--expected-audio',join(root,'required.wav'),'--output',join(root,'evidence'),'--dependencies',join(root,'node_modules')],{encoding:'utf8',timeout:10000});
  assert.notEqual(run.status,0);assert.match(run.stderr,fault==='neutral-catalog'?/Packaged catalog differs/:fault==='missing-model'?/ENOENT/:/AssertionError/);
 }finally{await rm(root,{recursive:true,force:true});}
});
