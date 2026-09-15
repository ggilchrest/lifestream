import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const at=process.argv.indexOf('--producer-root');if(at<0||!process.argv[at+1])throw new Error('usage: --producer-root <public PWCE checkout> [--write]');
const root=resolve(process.argv[at+1]),manifest=JSON.parse(await readFile(join(root,'contracts/action-admission/bundle-manifest.json'),'utf8'));
const paths=['contracts/action-admission/profile.json','contracts/action-admission/evidence.schema.json'];
if(manifest.bundleId!=='pwce-action-admission.bundle.v1'||manifest.bundleVersion!=='1.0.0'||manifest.profileId!=='pwce-action-admission.v1'||manifest.profileVersion!=='1.0.0'||manifest.digestAlgorithm!=='sha256-ordered-path-bytes-v1'||JSON.stringify(manifest.artifacts.map(x=>x.path))!==JSON.stringify(paths))throw new Error('unsupported admission profile');
const aggregate=createHash('sha256'),sources=[];
for(const item of manifest.artifacts){const bytes=await readFile(join(root,item.path));if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw new Error('admission artifact mismatch');aggregate.update(item.path).update('\0').update(bytes);sources.push(bytes);}
if(aggregate.digest('hex')!==manifest.bundleDigest)throw new Error('admission bundle mismatch');
const expectedDispatch={bundleId:'pwce-trusted-dispatch.bundle.v1',bundleVersion:'1.0.0',bundleDigest:'c61b022af86244d9da5f6b1e2222b44df22487289c0a963816f5242e0958e7be'},expectedCapability={bundleId:'pwce-capability-contracts.bundle.v1',bundleVersion:'1.0.0',bundleDigest:'6df58c602d8a43fdababd388c588aef631662e5904139837baa36db9c6730a0c'};
if(JSON.stringify(manifest.requiredDispatchBundle)!==JSON.stringify(expectedDispatch)||JSON.stringify(manifest.requiredCapabilityBundle)!==JSON.stringify(expectedCapability))throw new Error('unsupported admission dependency');
const schema=JSON.parse(sources[1]),artifact={reference:schema.$id,sha256:manifest.artifacts[1].sha256,byteLength:sources[1].length,mediaType:'application/schema+json',schemaRef:schema.$schema};
if(JSON.stringify(manifest.schemaArtifact)!==JSON.stringify(artifact)||manifest.schemaRef!==schema.$id)throw new Error('admission schema identity mismatch');
const source=`// Generated only from PWCE public admission contracts.\nconst freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};\nexport const EXPECTED_PWCE_ADMISSION_BUNDLE=freeze(${JSON.stringify(manifest,null,2)} as const);\nexport const PWCE_ADMISSION_SCHEMA=freeze(${JSON.stringify(schema,null,2)} as const);\n`;
const output='packages/providers-pwce/src/admission-bundle.ts',matches=await readFile(output,'utf8').catch(()=>'')===source;
if(process.argv.includes('--write'))await writeFile(output,source);else if(!matches)process.exitCode=1;
console.log(JSON.stringify({source:'public-PWCE-contract',bundleDigest:manifest.bundleDigest,byteIdentical:matches||process.argv.includes('--write')}));
