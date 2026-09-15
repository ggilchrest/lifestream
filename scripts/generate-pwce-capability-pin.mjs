import { createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
const at=process.argv.indexOf('--producer-root');if(at<0||!process.argv[at+1])throw new Error('usage: --producer-root <public PWCE checkout> [--write]');
const root=resolve(process.argv[at+1]),manifest=JSON.parse(await readFile(join(root,'contracts/capabilities/bundle-manifest.json'),'utf8'));
const paths=['contracts/capabilities/catalog.json','contracts/capabilities/light-set-level/descriptor.json','contracts/capabilities/light-set-level/input.schema.json','contracts/capabilities/light-set-level/result.schema.json'];
if(manifest.bundleId!=='pwce-capability-contracts.bundle.v1'||manifest.bundleVersion!=='1.0.0'||manifest.digestAlgorithm!=='sha256-ordered-path-bytes-v1'||JSON.stringify(manifest.artifacts.map(a=>a.path))!==JSON.stringify(paths))throw new Error('unsupported public capability bundle');
const aggregate=createHash('sha256'),sources=[];
for(const artifact of manifest.artifacts){const bytes=await readFile(join(root,artifact.path));if(createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw new Error('public capability artifact digest mismatch');aggregate.update(artifact.path).update('\0').update(bytes);sources.push(bytes);}
if(aggregate.digest('hex')!==manifest.bundleDigest||manifest.capabilities.length!==1)throw new Error('public capability bundle mismatch');
const descriptor=JSON.parse(sources[1]);
for(const [i,field] of [[2,'inputSchema'],[3,'resultSchema']]){
 const schema=JSON.parse(sources[i]),artifact={reference:schema.$id,sha256:manifest.artifacts[i].sha256,byteLength:sources[i].length,mediaType:'application/schema+json',schemaRef:schema.$schema};
 if(descriptor[`${field}Ref`]!==schema.$id||JSON.stringify(manifest.capabilities[0][`${field}Artifact`])!==JSON.stringify(artifact))throw new Error('public schema reference mismatch');
 descriptor[`${field}Artifact`]=artifact;
}
if(JSON.stringify(descriptor)!==JSON.stringify(manifest.capabilities[0]))throw new Error('public descriptor mismatch');
const source=`// Generated exclusively from PWCE's public capability contract bundle.\nconst freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};\nexport const EXPECTED_PWCE_CAPABILITY_BUNDLE=freeze(${JSON.stringify(manifest,null,2)} as const);\n`;
const path='packages/providers-pwce/src/capability-bundle.ts',matches=await readFile(path,'utf8').catch(()=>'')===source;
if(process.argv.includes('--write'))await writeFile(path,source);else if(!matches)process.exitCode=1;
console.log(JSON.stringify({source:'public-PWCE-contract',bundleDigest:manifest.bundleDigest,byteIdentical:matches||process.argv.includes('--write')}));

// Test fixtures are exact public producer bytes, checked by the same generator.
// They are not a second canonical contract and must never be edited by hand.
for(const [i,name] of [[2,'input'],[3,'result']]){
 const target=`apps/server/test/fixtures/pwce-light-${name}.schema.json`;
 const identical=(await readFile(target).catch(()=>Buffer.alloc(0))).equals(sources[i]);
 if(process.argv.includes('--write'))await writeFile(target,sources[i]);else if(!identical)process.exitCode=1;
 console.log(JSON.stringify({fixture:target,sha256:manifest.artifacts[i].sha256,byteIdentical:identical||process.argv.includes('--write')}));
}
