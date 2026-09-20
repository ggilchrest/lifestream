import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const require=createRequire(import.meta.url);
export async function presentationVendor(name:string):Promise<Buffer|undefined> {
  const files:Record<string,string>={ 'SkeletonUtils.js':'examples/jsm/utils/SkeletonUtils.js','RoomEnvironment.js':'examples/jsm/environments/RoomEnvironment.js','three.module.js':'build/three.module.js','three.core.js':'build/three.core.js','GLTFLoader.js':'examples/jsm/loaders/GLTFLoader.js','BufferGeometryUtils.js':'examples/jsm/utils/BufferGeometryUtils.js' };
  const file=files[name];if(!file)return undefined;
  const root=resolve(dirname(require.resolve('three')),'..');
  const source=await readFile(resolve(root,file),'utf8');
  return Buffer.from(name==='GLTFLoader.js'?source.replace('../utils/BufferGeometryUtils.js','./BufferGeometryUtils.js').replace('../utils/SkeletonUtils.js','./SkeletonUtils.js'):source);
}
