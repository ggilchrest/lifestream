import {build} from 'esbuild';
import {mkdir,copyFile,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=new URL('../',import.meta.url);
export const bundleWeb=(options={})=>build({entryPoints:[fileURLToPath(new URL('web/app.js',root))],outfile:fileURLToPath(new URL('dist/app.js',root)),...options,bundle:true,format:'esm',minify:true,legalComments:'eof',plugins:[{name:'shared-three-loaders',setup(b){b.onResolve({filter:/^\.\/behavior-controller\.js$/},()=>({path:fileURLToPath(new URL('../../packages/runtime/src/embodiment/controller.ts',root))}));b.onResolve({filter:/^\.\/(GLTFLoader|RoomEnvironment)\.js$/},args=>({path:fileURLToPath(new URL(`node_modules/three/examples/jsm/${args.path.includes('GLTF')?'loaders/GLTFLoader':'environments/RoomEnvironment'}.js`,root))}));}}]});
if(import.meta.url===pathToFileURL(process.argv[1]).href){
await mkdir(new URL('dist/',root),{recursive:true});await bundleWeb();
for(const f of ['index.html','app.css'])await copyFile(new URL(`web/${f}`,root),new URL(`dist/${f}`,root));
const files=['presentation-runtime.js','presentation-core.js','presentation-motion.js','presentation-speech.js','presentation-state.js'];
const shared=[];for(const path of files){const bytes=await readFile(new URL(`../control-web/${path}`,root));shared.push({path,sha256:createHash('sha256').update(bytes).digest('hex')});}
const behavior=await readFile(new URL('../../packages/runtime/src/embodiment/controller.ts',root));shared.push({path:'packages/runtime/src/embodiment/controller.ts',sha256:createHash('sha256').update(behavior).digest('hex')});
await writeFile(new URL('dist/shared-renderer-manifest.json',root),JSON.stringify({schemaVersion:'1.0.0',shared,privateAssetsIncluded:false},null,2)+'\n');
const notices=[];for(const [name,path] of [['Capacitor Core','node_modules/@capacitor/core/LICENSE'],['Capacitor iOS','node_modules/@capacitor/ios/LICENSE'],['Three.js','node_modules/three/LICENSE'],['Cordova - Apache Software Foundation (Apache-2.0)','../../LICENSE']])notices.push(name+'\n'+await readFile(new URL(path,root),'utf8'));
await writeFile(new URL('dist/THIRD_PARTY_NOTICES.txt',root),notices.join('\n\n'));
console.log('Bundled the existing renderer and generic iOS interface; no asset directories copied.');

}
