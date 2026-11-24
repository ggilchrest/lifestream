// Host configuration, not package manifest data. Never executes the bundle here.
import {createHash} from 'node:crypto';
import {openSync,closeSync,readSync,fstatSync,lstatSync,realpathSync,constants} from 'node:fs';
import {isAbsolute,dirname} from 'node:path';
import type {PresentationManifest} from './presentation-packages.ts';
export type TrustedPresentationRuntime={kind:'world-delta.v1';module:{path:string;sha256:string;bytes:number};bindings:{sourceVariantId:string;modelSha256:string;profileSha256:string}[]};
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function captureTrustedRuntime(config:TrustedPresentationRuntime):Buffer{
 if(config.kind!=='world-delta.v1'||!config.module||!isAbsolute(config.module.path)||realpathSync(dirname(config.module.path))!==dirname(config.module.path)||!digest(config.module.sha256)||!Number.isSafeInteger(config.module.bytes)||config.module.bytes<1||config.module.bytes>262144)throw Error('Unregistered presentation runtime');
 const fd=openSync(config.module.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 const signature=(s:import('node:fs').BigIntStats)=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join('/');
 try{const before=fstatSync(fd,{bigint:true});if(!before.isFile()||before.nlink!==1n||before.size!==BigInt(config.module.bytes)||(before.mode&0o777n)!==0o400n||typeof process.getuid==='function'&&before.uid!==BigInt(process.getuid())||typeof process.getgid==='function'&&before.gid!==BigInt(process.getgid()))throw Error('Unsealed presentation runtime');
  const sig=signature(before);if(signature(lstatSync(config.module.path,{bigint:true}))!==sig)throw Error('Runtime identity changed');const bytes=Buffer.alloc(config.module.bytes+1);let used=0;while(used<bytes.length){const n=readSync(fd,bytes,used,bytes.length-used,null);if(!n)break;used+=n;}
  if(used!==config.module.bytes||signature(fstatSync(fd,{bigint:true}))!==sig||signature(lstatSync(config.module.path,{bigint:true}))!==sig||hash(bytes.subarray(0,used))!==config.module.sha256)throw Error('Runtime bytes changed');return bytes.subarray(0,used);
 }finally{closeSync(fd);}
}
export function runtimeDescriptor(config:TrustedPresentationRuntime|undefined,manifest:PresentationManifest):{kind:'world-delta.v1';sha256:string;bytes:number}|null{
 if(!config||config.kind!=='world-delta.v1'||manifest.schemaVersion!=='1.5.0'||manifest.worldDelta?.adapter!=='world-delta.v1'||!manifest.sourceVariant||!manifest.physics||!Array.isArray(config.bindings)||config.bindings.length>32)return null;
 const allowed=config.bindings.filter(b=>b.sourceVariantId===manifest.sourceVariant!.catalogId&&digest(b.modelSha256)&&b.modelSha256===manifest.sourceVariant!.modelSha256&&digest(b.profileSha256)&&b.profileSha256===manifest.physics!.profileSha256);
 if(allowed.length!==1||!digest(config.module.sha256)||!Number.isSafeInteger(config.module.bytes)||config.module.bytes<1||config.module.bytes>262144)return null;
 return {kind:'world-delta.v1',sha256:config.module.sha256,bytes:config.module.bytes};
}
