import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
const at=process.argv.indexOf('--producer-root');if(at<0||!process.argv[at+1])throw new Error('usage: --producer-root <public PWCE checkout> [--write]');
const root=resolve(process.argv[at+1]),manifest=JSON.parse(await readFile(join(root,'contracts/approval-recovery/bundle-manifest.json')));
const paths=['contracts/approval-recovery/profile.json','contracts/approval-recovery/request.schema.json','contracts/approval-recovery/response.schema.json','contracts/approval-recovery/evidence.schema.json'];
if(manifest.bundleId!=='pwce-approval-recovery.bundle.v1'||manifest.bundleVersion!=='1.0.0'||manifest.profileId!=='pwce-approval-recovery.v1'||manifest.profileVersion!=='1.0.0'||manifest.digestAlgorithm!=='sha256-ordered-path-bytes-v1'||!isDeepStrictEqual(manifest.artifacts.map(item=>item.path),paths))throw new Error('unsupported recovery profile');
const aggregate=createHash('sha256'),sources=[];
for(const item of manifest.artifacts){const bytes=await readFile(join(root,item.path));if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw new Error('recovery artifact mismatch');aggregate.update(item.path).update('\0').update(bytes);sources.push(bytes);}
if(aggregate.digest('hex')!==manifest.bundleDigest)throw new Error('recovery bundle mismatch');
for(const [field,expected] of [['requiredGatewayBundle',{bundleId:'pwce-agent-gateway.bundle.v1',bundleVersion:'1.0.0',bundleDigest:'32c555ba675b61b4c1ec82245e314a8f6ca537484defbeb48b9fe1b6bdf4e2e2'}],['requiredDispatchBundle',{bundleId:'pwce-trusted-dispatch.bundle.v1',bundleVersion:'1.0.0',bundleDigest:'c61b022af86244d9da5f6b1e2222b44df22487289c0a963816f5242e0958e7be'}]])if(!isDeepStrictEqual(manifest[field],expected))throw new Error('unsupported recovery dependency');
const schemas=sources.slice(1).map(bytes=>JSON.parse(bytes));
const artifacts=schemas.map((schema,i)=>({reference:schema.$id,sha256:manifest.artifacts[i+1].sha256,byteLength:sources[i+1].length,mediaType:'application/schema+json',schemaRef:schema.$schema}));
if(!isDeepStrictEqual(artifacts,manifest.schemaArtifacts)||schemas[0].$id!==manifest.requestSchemaRef||schemas[1].$id!==manifest.responseSchemaRef||schemas[2].$id!==manifest.evidenceSchemaRef||!isDeepStrictEqual(schemas[1].$defs.OriginalApproval,schemas[2]))throw new Error('recovery schema identity mismatch');
const source=`// Generated only from PWCE public approval-recovery contracts.\nconst freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};\nexport const EXPECTED_PWCE_APPROVAL_RECOVERY_BUNDLE=freeze(${JSON.stringify(manifest,null,2)} as const);\nexport const PWCE_APPROVAL_RECOVERY_REQUEST_SCHEMA=freeze(${JSON.stringify(schemas[0],null,2)} as const);\nexport const PWCE_APPROVAL_RECOVERY_RESPONSE_SCHEMA=freeze(${JSON.stringify(schemas[1],null,2)} as const);\nexport const PWCE_APPROVAL_EVIDENCE_SCHEMA=freeze(${JSON.stringify(schemas[2],null,2)} as const);\n`;
const output='packages/providers-pwce/src/approval-recovery-bundle.ts',matches=await readFile(output,'utf8').catch(()=>'')===source;
if(process.argv.includes('--write'))await writeFile(output,source);else if(!matches)process.exitCode=1;
console.log(JSON.stringify({source:'public-PWCE-contract',bundleDigest:manifest.bundleDigest,byteIdentical:matches||process.argv.includes('--write')}));
