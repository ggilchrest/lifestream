// Only the producer's digest-verified public artifacts define this boundary.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const flag=process.argv.indexOf('--producer-root');
if(flag>=0&&(!process.argv[flag+1]||process.argv[flag+1].startsWith('--')))throw Error('A producer root is required');
const producer=resolve(flag>=0?process.argv[flag+1]:join(root,'../PWCE'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const bundle=JSON.parse(await readFile(join(producer,'contracts/urgent-conditions/bundle-manifest.json'),'utf8'));
const paths=['contracts/urgent-conditions/profile.json','contracts/urgent-conditions/schema.json'];
if(bundle.bundleId!=='pwce-urgent-conditions.bundle.v1'||bundle.bundleVersion!=='1.0.0'||bundle.digestAlgorithm!=='sha256-ordered-path-bytes-v1'||bundle.artifacts?.length!==paths.length)throw Error('Unsupported producer condition bundle');
const hash=createHash('sha256'),sources=[],bytesByPath=new Map();
for(const [index,path] of paths.entries()){
  const bytes=await readFile(join(producer,path)),artifact=bundle.artifacts[index];
  if(artifact.path!==path||artifact.sha256!==sha(bytes))throw Error('Producer condition artifact digest mismatch');
  hash.update(path).update('\0').update(bytes);sources.push(JSON.parse(bytes));bytesByPath.set(path,bytes);
}
if(hash.digest('hex')!==bundle.bundleDigest)throw Error('Producer condition bundle digest mismatch');
const {digestAlgorithm:_,bundleDigest:__,artifacts:___,...profile}=bundle;
if(JSON.stringify(profile)!==JSON.stringify(sources[0]))throw Error('Producer condition profile differs from manifest');
const schema=sources[1];
for(const name of ['request','response','condition'])if(!schema.$defs?.[name])throw Error('Producer condition root is absent');
const output='// Generated exclusively from digest-verified PWCE public condition contracts.\nconst freeze=<T>(v:T):T=>{if(v&&typeof v===\'object\'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;};\n'+[
  ['EXPECTED_PWCE_CONDITION_BUNDLE',bundle],
  ['PWCE_CONDITION_SCHEMA',schema]
].map(([name,value])=>'export const '+name+'=freeze('+JSON.stringify(value,null,2)+');\n').join('')+['request','response','condition'].map(name=>'export const PWCE_CONDITION_'+(name==='condition'?'RECORD':name.toUpperCase())+'_SCHEMA=freeze({...PWCE_CONDITION_SCHEMA,$ref:'+JSON.stringify('#/$defs/'+name)+'});\n').join('');
const file=join(root,'packages/providers-pwce/src/condition-bundle.ts'),lockFile=join(root,'packages/providers-pwce/condition-compatibility-lock.json');
if(process.argv.includes('--write')){
  const revision=execFileSync('git',['-C',producer,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  let committed=true;
  for(const [path,bytes] of bytesByPath)try{if(!execFileSync('git',['-C',producer,'show',revision+':'+path],{stdio:['ignore','pipe','ignore']}).equals(bytes))committed=false;}catch{committed=false;}
  await writeFile(file,output);
  await writeFile(lockFile,JSON.stringify({schemaVersion:'1.0.0',producer:'PWCE',producerRevision:committed?revision:'WORKTREE',bundleId:bundle.bundleId,bundleVersion:bundle.bundleVersion,bundleDigest:bundle.bundleDigest,generatedBoundary:'src/condition-bundle.ts',generatedBoundarySha256:sha(output),claim:'Bounded condition contract mapping; no live source, interruption, Human acknowledgment, camera or remote notification acceptance.'},null,2)+'\n');
}else{
  if(await readFile(file,'utf8')!==output)throw Error('Consumer condition contract is stale');
  const lock=JSON.parse(await readFile(lockFile,'utf8'));
  if(lock.bundleId!==bundle.bundleId||lock.bundleVersion!==bundle.bundleVersion||lock.bundleDigest!==bundle.bundleDigest||lock.generatedBoundarySha256!==sha(output))throw Error('Condition compatibility lock differs');
  if(!/^[a-f0-9]{40}$/.test(lock.producerRevision))throw Error('Condition producer revision is not committed');
  for(const [path,bytes] of bytesByPath)if(!execFileSync('git',['-C',producer,'show',lock.producerRevision+':'+path],{stdio:['ignore','pipe','ignore']}).equals(bytes))throw Error('Pinned producer artifact differs');
}
console.log(JSON.stringify({bundleId:bundle.bundleId,bundleDigest:bundle.bundleDigest,byteIdentical:true}));
