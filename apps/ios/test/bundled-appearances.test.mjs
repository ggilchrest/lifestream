import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {bundleAppearances,outsideGit} from '../scripts/bundle-appearances.mjs';
async function fixture(t,uri){
 const root=await mkdtemp(join(tmpdir(),'mobile-assets-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const packs=join(root,'packs'),dir=join(packs,'sample');await mkdir(dir,{recursive:true});
 const bytes=Buffer.from(JSON.stringify({asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{}],...(uri?{images:[{uri}]}:{})}));
 const manifest={schemaVersion:'1.0.0',id:'sample',label:'Synthetic bundled asset',version:'1',renderer:'three-glb.v1',model:'model.gltf',resources:[{path:'model.gltf',mime:'model/gltf+json',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}],framing:{distance:1,targetHeight:.5},animations:{},capabilities:{lipSync:'none',facialAnimation:false},fallback:'neutral'};
 await writeFile(join(dir,'model.gltf'),bytes);await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));await writeFile(join(packs,'index.json'),'["sample"]');await writeFile(join(dir,'not-for-bundle.txt'),'must not copy');
 return {root,packs,dir,bytes};
}
test('bundles only selected declared bytes with a local default and neutral fallback',async t=>{
 const f=await fixture(t),output=join(f.root,'out');const value=await bundleAppearances(output,{directory:f.packs,ids:['sample']});
 assert.equal(value.defaultId,'sample');assert.deepEqual(await readFile(join(output,'appearances/sample/model.gltf')),f.bytes);assert.deepEqual(await readdir(join(output,'appearances/sample')),['model.gltf']);
 assert.equal((await bundleAppearances(join(f.root,'generic'))).packages.length,0);
});
test('refuses Git outputs, symlinked Git outputs, and altered/remote-dependent assets',async t=>{
 const f=await fixture(t);await mkdir(join(f.root,'.git'));await assert.rejects(outsideGit(join(f.root,'new/deep')),/outside every Git/);await rm(join(f.root,'.git'),{recursive:true});
 await mkdir(join(f.root,'repo/.git'),{recursive:true});await symlink(join(f.root,'repo'),join(f.root,'alias'));await assert.rejects(outsideGit(join(f.root,'alias/out')),/outside every Git/);
 await writeFile(join(f.dir,'model.gltf'),'changed');await assert.rejects(bundleAppearances(join(f.root,'bad'),{directory:f.packs,ids:['sample']}),/invalid or unavailable/);
 const remote=await fixture(t,'https://example.invalid/texture.png');await assert.rejects(bundleAppearances(join(remote.root,'out'),{directory:remote.packs,ids:['sample']}),/invalid or unavailable/);
});
