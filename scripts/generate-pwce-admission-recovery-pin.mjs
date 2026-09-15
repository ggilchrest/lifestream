import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
const at=process.argv.indexOf('--producer-root');if(at<0||!process.argv[at+1])throw new Error('usage: --producer-root <public PWCE checkout> [--write]');
const root=resolve(process.argv[at+1]),manifest=JSON.parse(await readFile(join(root,'contracts/admission-recovery/bundle-manifest.json')));
const paths=['contracts/admission-recovery/profile.json','contracts/admission-recovery/request.schema.json','contracts/admission-recovery/response.schema.json'];
if(manifest.bundleId!=='pwce-admission-recovery.bundle.v1'||manifest.bundleVersion!=='1.0.0'||manifest.profileId!=='pwce-admission-recovery.v1'||manifest.profileVersion!=='1.0.0'||manifest.digestAlgorithm!=='sha256-ordered-path-bytes-v1'||!isDeepStrictEqual(manifest.artifacts.map(item=>item.path),paths))throw new Error('unsupported recovery profile');
const aggregate=createHash('sha256'),sources=[];
for(const item of manifest.artifacts){const bytes=await readFile(join(root,item.path));if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw new Error('recovery artifact mismatch');aggregate.update(item.path).update('\0').update(bytes);sources.push(bytes);}
if(aggregate.digest('hex')!==manifest.bundleDigest)throw new Error('recovery bundle mismatch');
for(const [field,expected] of [['requiredGatewayBundle',{bundleId:'pwce-agent-gateway.bundle.v1',bundleVersion:'1.0.0',bundleDigest:'32c555ba675b61b4c1ec82245e314a8f6ca537484defbeb48b9fe1b6bdf4e2e2'}],['requiredAdmissionBundle',{bundleId:'pwce-action-admission.bundle.v1',bundleVersion:'1.0.0',bundleDigest:'0379a7615ee3df928024d8f0290bbcf62b5ccb67e016ef3c3373d37a87294f8f'}]])if(!isDeepStrictEqual(manifest[field],expected))throw new Error('unsupported recovery dependency');
const schemas=sources.slice(1).map(bytes=>JSON.parse(bytes));
const artifacts=schemas.map((schema,i)=>({reference:schema.$id,sha256:manifest.artifacts[i+1].sha256,byteLength:sources[i+1].length,mediaType:'application/schema+json',schemaRef:schema.$schema}));
if(!isDeepStrictEqual(artifacts,manifest.schemaArtifacts)||schemas[0].$id!==manifest.requestSchemaRef||schemas[1].$id!==manifest.responseSchemaRef)throw new Error('recovery schema identity mismatch');
const source=`// Generated only from PWCE public admission-recovery contracts.\nconst freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};\nexport const EXPECTED_PWCE_ADMISSION_RECOVERY_BUNDLE=freeze(${JSON.stringify(manifest,null,2)} as const);\nexport const PWCE_ADMISSION_RECOVERY_REQUEST_SCHEMA=freeze(${JSON.stringify(schemas[0],null,2)} as const);\nexport const PWCE_ADMISSION_RECOVERY_RESPONSE_SCHEMA=freeze(${JSON.stringify(schemas[1],null,2)} as const);\n`;
const output='packages/providers-pwce/src/admission-recovery-bundle.ts',matches=await readFile(output,'utf8').catch(()=>'')===source;
if(process.argv.includes('--write'))await writeFile(output,source);else if(!matches)process.exitCode=1;
console.log(JSON.stringify({source:'public-PWCE-contract',bundleDigest:manifest.bundleDigest,byteIdentical:matches||process.argv.includes('--write')}));
