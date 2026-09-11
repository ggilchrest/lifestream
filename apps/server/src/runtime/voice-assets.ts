import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const modules=resolve(dirname(fileURLToPath(import.meta.url)),'../../node_modules');
const assets: Record<string,string>={
  'silero_vad_v5.onnx':'@ricky0123/vad-web/dist/silero_vad_v5.onnx',
  'ort.wasm.min.js':'onnxruntime-web/dist/ort.wasm.min.js',
  'ort-wasm-simd-threaded.mjs':'onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm':'onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
};
export async function voiceAsset(name:string):Promise<Buffer|undefined>{const path=assets[name];return path?readFile(resolve(modules,path)):undefined;}
