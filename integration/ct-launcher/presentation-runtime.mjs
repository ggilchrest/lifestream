// Operator-owned configuration only. Package manifests never choose code paths.
import assert from 'node:assert/strict';
import {dirname,resolve} from 'node:path';
import {lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {regularFile,inspectOwnerFile} from './owner-file.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fields=(v,keys)=>{assert(v&&Object.getPrototypeOf(v)===Object.prototype);assert.deepEqual(Reflect.ownKeys(v).sort(),keys.sort());assert(Object.values(Object.getOwnPropertyDescriptors(v)).every(d=>Object.hasOwn(d,'value')));};
const within=(value,root)=>{assert.equal(typeof value,'string');assert.equal(resolve(value),value);assert(value.startsWith(root+'/')&&value.length<=4096);};
export function validateOptionalPresentationRuntime(value,{configRoot}){
 fields(value,['schemaVersion','path','sha256','bytes']);
 assert.equal(value.schemaVersion,'canonical-presentation-runtime/1');within(value.path,configRoot);assert(digest(value.sha256));assert(Number.isSafeInteger(value.bytes)&&value.bytes>0&&value.bytes<=16384);
 return structuredClone(value);
}
export function validateTrustedPresentationRuntime(value,{runtimeRoot='/srv/lifestream/deployment/private-runtime'}={}){
 fields(value,['kind','module','bindings']);assert.equal(value.kind,'world-delta.v1');
 fields(value.module,['path','bytes','sha256']);within(value.module.path,runtimeRoot);assert(value.module.path.endsWith('.mjs'));assert(digest(value.module.sha256));assert(Number.isSafeInteger(value.module.bytes)&&value.module.bytes>0&&value.module.bytes<=262144);
 assert(Array.isArray(value.bindings)&&value.bindings.length>0&&value.bindings.length<=32);
 const ids=new Set();for(const b of value.bindings){fields(b,['sourceVariantId','modelSha256','profileSha256']);assert(typeof b.sourceVariantId==='string'&&/^[a-z0-9][a-z0-9:_-]{0,191}$/.test(b.sourceVariantId));assert(!ids.has(b.sourceVariantId));ids.add(b.sourceVariantId);assert(digest(b.modelSha256)&&digest(b.profileSha256));}
 return structuredClone(value);
}
export async function inspectOptionalPresentationRuntimeConfiguration(deployment,{directory}){
 if(!Object.hasOwn(deployment,'presentationRuntime'))return {configured:false};
 const pin=validateOptionalPresentationRuntime(deployment.presentationRuntime,{configRoot:dirname(deployment.ownershipBaselinePath)});
 await directory(dirname(pin.path));const meta=await inspectOwnerFile(pin.path,16384);assert.equal(meta.size,BigInt(pin.bytes));assert.equal(meta.mode&0o777n,0o400n);
 return {configured:true,configurationBodyRead:false};
}
export async function loadOptionalPresentationRuntime(deployment,{directory,capture,runtimeRoot='/srv/lifestream/deployment/private-runtime'}){
 if(!Object.hasOwn(deployment,'presentationRuntime'))return undefined;
 assert.equal(typeof capture,'function');
 const pin=validateOptionalPresentationRuntime(deployment.presentationRuntime,{configRoot:dirname(deployment.ownershipBaselinePath)});
 await inspectOptionalPresentationRuntimeConfiguration(deployment,{directory});
 const bytes=await regularFile(pin.path,16384,{sealed:true});assert.equal(bytes.length,pin.bytes);assert.equal(hash(bytes),pin.sha256);
 const config=validateTrustedPresentationRuntime(JSON.parse(bytes.toString('utf8')),{runtimeRoot});
 await directory(dirname(config.module.path));const meta=await lstat(config.module.path);assert.equal(meta.mode&0o777,0o400);
 // Original backend capture checks owner/inode/size/digest, without importing JS.
 const captured=await capture(config);assert(captured instanceof Uint8Array);assert.equal(captured.byteLength,config.module.bytes);assert.equal(hash(captured),config.module.sha256);
 return config;
}
