import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod,readdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {bundleAppearances} from '../scripts/bundle-appearances.mjs';
import {bundledResource} from '../web/bundled-appearances.js';
import {loadTrustedPresentationAdapter} from '../../control-web/presentation-trusted-adapter.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function glb(){
 const raw=JSON.stringify({asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{}]});
 const json=Buffer.from(raw.padEnd(Math.ceil(raw.length/4)*4,' '));
 const bytes=Buffer.alloc(20+json.length);bytes.writeUInt32LE(0x46546c67,0);bytes.writeUInt32LE(2,4);bytes.writeUInt32LE(bytes.length,8);bytes.writeUInt32LE(json.length,12);bytes.writeUInt32LE(0x4e4f534a,16);json.copy(bytes,20);return bytes;
}
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'mobile-runtime-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const packs=join(root,'packs'),dir=join(packs,'sample');await mkdir(dir,{recursive:true});
 const model=glb(),profile=Buffer.from(JSON.stringify({id:'synthetic',hairBones:['Hair'],softBones:['Soft'],colliders:[{bone:'Body',a:[0,0,0],b:[0,1,0],radius:.1}],limits:[],derivation:{headNeckDistance:.1,shoulderWidth:.2,weightedJointsAndAncestors:3}}));
 const resources=[['model.glb',model,'model/gltf-binary'],['rest.glb',model,'model/gltf-binary'],['clip.glb',model,'model/gltf-binary'],['profile.json',profile,'application/json']].map(([path,bytes,mime])=>({path,bytes:bytes.length,sha256:hash(bytes),mime}));
 for(const r of resources)await writeFile(join(dir,r.path),r.path.endsWith('.json')?profile:model);
 const sourceVariant={packageId:'synthetic',variantId:'sample',catalogId:'mod:synthetic:sample',modelSha256:hash(model)};
 const manifest={schemaVersion:'1.5.0',id:'sample',label:'Synthetic motion fixture',version:'1',renderer:'three-glb.v1',model:'model.glb',resources,framing:{distance:1,targetHeight:.5},animations:{idle:'Idle'},capabilities:{lipSync:'none',facialAnimation:false},fallback:'neutral',sourceVariant,worldDelta:{adapter:'world-delta.v1',family:'synthetic',rotationY:0,basis:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],boneMap:{Target:'Source'},referenceResource:'rest.glb',animations:[{sourceAnimationId:'idle',clipName:'Idle',resource:'clip.glb',playback:'finite-once-clamp'}],families:[{id:'Idle',members:['idle']}],cycle:['idle'],transitionSeconds:.2},physics:{profileResource:'profile.json',profileSha256:hash(profile),sourceVariantId:sourceVariant.catalogId,modelSha256:hash(model)}};
 await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));await writeFile(join(packs,'index.json'),'["sample"]');
 const module=Buffer.from("export const contract='world-delta.v1';export function createPresentationAdapter(){return {synthetic:true};}\n"),path=join(root,'sealed.mjs');await writeFile(path,module,{mode:0o400});
 const trustedRuntime={kind:'world-delta.v1',module:{path,bytes:module.length,sha256:hash(module)},bindings:[{sourceVariantId:sourceVariant.catalogId,modelSha256:hash(model),profileSha256:hash(profile)}]};
 return {root,packs,dir,manifest,module,trustedRuntime,output:join(root,'output')};
}
test('packages schema1.5 resources and only the exact sealed runtime; catalog excludes host configuration',async t=>{
 const f=await fixture(t),catalog=await bundleAppearances(f.output,{directory:f.packs,ids:['sample'],trustedRuntime:f.trustedRuntime}),item=catalog.packages[0];
 assert.deepEqual(item.trustedRuntime,{kind:'world-delta.v1',sha256:hash(f.module),bytes:f.module.length});
 assert.deepEqual(await readFile(join(f.output,'appearances/adapters/world-delta.v1/sample',item.digest+'.js')),f.module);
 assert.deepEqual((await readdir(join(f.output,'appearances/sample'))).sort(),['clip.glb','model.glb','profile.json','rest.glb']);
 const serialized=await readFile(join(f.output,'bundled-appearances.json'),'utf8');assert.ok(!serialized.includes(f.root));assert.ok(!serialized.includes('bindings'));
 const route=`/api/runtime/v1/presentation/adapters/world-delta.v1/sample/${item.digest}`;
 const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});try{const bytes=await readFile(join(f.output,url.slice(2)));return new Response(bytes);}catch{return new Response(null,{status:404});}});
 const abort=new AbortController(),bytes=await bundledResource(route,abort.signal);
 assert.deepEqual(Buffer.from(bytes),f.module);assert.equal(calls[0].url,`./appearances/adapters/world-delta.v1/sample/${item.digest}.js`);assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.signal,abort.signal);
 let imports=0;const factory=await loadTrustedPresentationAdapter(item,{retrieveAdapter:()=>bundledResource(route),importModule:async()=>{imports++;return {contract:'world-delta.v1',createPresentationAdapter:()=>({synthetic:true})};}});
 assert.deepEqual(factory(),{synthetic:true});assert.equal(imports,1);
 await assert.rejects(bundledResource(route.replace('/sample/','/unknown/')),/unavailable/);
 await assert.rejects(bundledResource(route.replace(item.digest,'0'.repeat(64))),/unavailable/);
 await writeFile(join(f.output,'appearances/adapters/world-delta.v1/sample',item.digest+'.js'),Buffer.from('x'.repeat(f.module.length)));
 await assert.rejects(loadTrustedPresentationAdapter(item,{retrieveAdapter:()=>bundledResource(route),importModule:async()=>{imports++;return {};}}),/digest changed/);assert.equal(imports,1);
});
test('missing, unsealed, changed and mismatched runtime bindings fail before packaging',async t=>{
 const f=await fixture(t),options={directory:f.packs,ids:['sample']};
 await assert.rejects(bundleAppearances(f.output,options),/approved mobile motion runtime/);
 for(const change of [r=>{r.module.sha256='0'.repeat(64);},r=>{r.bindings[0].modelSha256='0'.repeat(64);},r=>{r.kind='unknown';}]){const runtime=structuredClone(f.trustedRuntime);change(runtime);await assert.rejects(bundleAppearances(f.output,{...options,trustedRuntime:runtime}),/approved mobile motion runtime/);}
 await chmod(f.trustedRuntime.module.path,0o600);await assert.rejects(bundleAppearances(f.output,{...options,trustedRuntime:f.trustedRuntime}),/approved mobile motion runtime/);
 await assert.rejects(readdir(f.output),{code:'ENOENT'});
 await chmod(f.trustedRuntime.module.path,0o400);await mkdir(join(f.root,'.git'));await assert.rejects(bundleAppearances(join(tmpdir(),'unused-mobile-output'),{...options,trustedRuntime:f.trustedRuntime}),/outside every Git/);
});
test('adapter paths reject traversal, unknown kinds and malformed digests without fetching',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;throw Error('unexpected fetch');});
 const base='/api/runtime/v1/presentation/adapters/',digest='a'.repeat(64);
 for(const suffix of [`foreign/sample/${digest}`,`world-delta.v1/../${digest}`,`world-delta.v1/%2e%2e/${digest}`,`world-delta.v1/sample/not-a-digest`,`world-delta.v1/sample/${digest}?query`,`world-delta.v1/sample/${digest}/extra`,`world-delta.v1/sample/${digest.toUpperCase()}`])await assert.rejects(bundledResource(base+suffix),/Invalid bundled motion runtime path/);
 await assert.rejects(bundledResource('https://foreign.invalid/code.js'),/not bundled/);assert.equal(calls,0);
});
test('bundled host permits verified blob modules without remote script sources',async()=>{
 const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8');
 const directive=html.match(/script-src ([^;]+);/)[1];assert.equal(directive,"'self' blob:");
});
test('browser imports the hash-verified bundled adapter under the actual mobile CSP',{timeout:30000},async t=>{
 const f=await fixture(t),catalog=await bundleAppearances(f.output,{directory:f.packs,ids:['sample'],trustedRuntime:f.trustedRuntime}),item=catalog.packages[0];
 const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8'),policy=html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
 const source=new Map([
  ['/',{mime:'text/html',bytes:Buffer.from(`<meta http-equiv="Content-Security-Policy" content="${policy}"><script type="module" src="/start.js"></script>`)}],
  ['/start.js',{mime:'text/javascript',bytes:Buffer.from(`import {bundledResource} from './bundled.js';import {loadTrustedPresentationAdapter} from './adapter.js';const item=${JSON.stringify(item)};try{const factory=await loadTrustedPresentationAdapter(item,{retrieveAdapter:approved=>bundledResource('/api/runtime/v1/presentation/adapters/world-delta.v1/'+approved.id+'/'+approved.digest)});globalThis.result=factory();}catch(e){globalThis.result={error:String(e)};}`)}],
  ['/bundled.js',{mime:'text/javascript',bytes:await readFile(new URL('../web/bundled-appearances.js',import.meta.url))}],
  ['/adapter.js',{mime:'text/javascript',bytes:await readFile(new URL('../../control-web/presentation-trusted-adapter.js',import.meta.url))}],
  [`/appearances/adapters/world-delta.v1/sample/${item.digest}.js`,{mime:'text/javascript',bytes:f.module}]
 ]);
 const server=createServer((req,res)=>{const value=source.get(req.url);if(!value){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':value.mime,'cache-control':'no-store'});res.end(value.bytes);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright'),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>globalThis.result!==undefined);assert.deepEqual(await page.evaluate(()=>globalThis.result),{synthetic:true});
});
