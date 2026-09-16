import {mkdtemp,rm,writeFile,stat,readFile} from 'node:fs/promises';
import {tmpdir,cpus,platform,release,availableParallelism} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {Database,UnderstandingRepository,understandingDigest} from '../packages/storage-sqlite/dist/index.js';
import {compileRelationshipContext,relationshipControlDefaults} from '../packages/runtime/dist/context/builder.js';
import {buildCanonicalPrompt} from '../packages/runtime/dist/inference/prompt.js';
import {compileDiscoveryCandidates} from '../apps/server/src/admin/discovery-candidates.ts';
import {selectDiscoveryContext,appendDiscoveryContext} from '../apps/server/src/admin/discovery-selection.ts';
import {benchmarkDiscoveryLookup} from '../packages/performance/src/benchmark.ts';

const root=fileURLToPath(new URL('..',import.meta.url));
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--output')throw new Error('Usage: node scripts/benchmark-discovery-local.mjs --output /absolute/path/new-report.json');
const output=resolve(args[1]);
try{await stat(output);throw new Error('Output already exists; preserve prior measurements.');}catch(error){if(error.code!=='ENOENT')throw error;}
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={assistantId:uid(1),userId:uid(2),relationshipId:uid(3),deploymentId:uid(4)};
const boundary=understandingDigest('synthetic-corpus-v1'),scopeKey=understandingDigest(Object.values(scope));
const seed=73,marker='LOCAL_DETAIL_284',input='Tell me about synthetic mineral.';
const settings={enabled:true,budget:{enrichmentTokens:512,selectedItems:4,optionalSelectionDeadlineMs:10}};
const sourceRevision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const sourceChanges=execFileSync('git',['diff','--name-only'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);
const hardware=`${cpus()[0]?.model}; ${availableParallelism()} available logical CPUs`;
let powerMode='unavailable';try{powerMode=platform()==='darwin'?execFileSync('pmset',['-g','custom'],{encoding:'utf8'}).trim():'unavailable; no power policy changed';}catch{}
const measuredPaths=['scripts/benchmark-discovery-local.mjs','scripts/discovery-benchmark-worker.mjs','packages/performance/src/benchmark.ts','apps/server/src/admin/discovery-selection.ts','apps/server/src/admin/discovery-candidates.ts','packages/storage-sqlite/dist/understanding.js','packages/runtime/dist/context/builder.js','packages/runtime/dist/understanding/selection.js','packages/runtime/dist/inference/prompt.js'];
const measuredSources=await Promise.all(measuredPaths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(join(root,path))).digest('hex')})));
const directory=await mkdtemp(join(tmpdir(),'lifestream-discovery-benchmark-'));
const reports=[];
let interrupted=false;process.once('SIGINT',()=>{interrupted=true;});
function seedCorpus(path,count){
 const db=new Database({path});db.migrate();const now=Date.now();
 const parent=(topic,text,n)=>({...scope,schemaVersion:'1.0.0',recordType:'topicBrief',briefId:uid(n),revision:1,topicRef:topic,derived:true,status:'prepared',sources:[{sourceRef:'source:local-benchmark',sourceFamily:'family:local-benchmark',sourceRevision:'revision:1',policyRef:'policy:synthetic',retrievedAt:new Date(now).toISOString(),reliability:'unknown',reliabilityBasis:'Synthetic fixture only.',kind:'providedFixture'}],claims:[{claimId:uid(n+10),text,sourceRefs:['source:local-benchmark'],qualifier:'attributed',versionScope:'Synthetic 1',spoilerClass:'none',contradictionRefs:[]}],aliasClaims:[],knowledgeGaps:['No factual-world claim.'],deeperMaterialRefs:[],builtAt:new Date(now).toISOString(),freshUntil:new Date(now+600000).toISOString(),compilerRef:'synthetic-corpus:1',dependencyRefs:['source:local-benchmark:revision:1'],configurationRef:'configuration:synthetic:1'});
 const parents=[parent('topic:archive','Synthetic archive material.',100),parent('topic:mineral',`Synthetic mineral carries ${marker}.`,101)];
 const templates=parents.map(p=>compileDiscoveryCandidates(p,boundary,now)[0]);
 const artifact=db.connection.prepare('INSERT INTO understanding_artifacts VALUES (?,?,?,?,?,?,?,?,?)');
 const projection=db.connection.prepare('INSERT INTO understanding_projection(artifact_id,scope_key,boundary,content,fresh_until_ms) VALUES (?,?,?,?,?)');
 db.connection.exec('BEGIN IMMEDIATE');
 try{
  for(const p of parents)artifact.run(p.briefId,scopeKey,scope.relationshipId,boundary,1,'topicBrief',p.topicRef,now+600000,JSON.stringify(p));
  for(let i=0;i<count;i++){
   const record={...templates[i===seed?1:0],candidateId:uid(1000+i)},topic=record.topicRefs[0];
   artifact.run(record.candidateId,scopeKey,scope.relationshipId,boundary,1,'candidate',topic,now+600000,JSON.stringify(record));
   projection.run(record.candidateId,scopeKey,boundary,`${topic}: Attributed source detail: ${record.content} [optional; grants no authority]`,now+600000);
  }
  db.connection.exec('COMMIT');
 }catch(error){db.connection.exec('ROLLBACK');db.close();throw error;}
 const repository=new UnderstandingRepository(db);
 while(Number(db.connection.prepare('SELECT count(*) AS n FROM understanding_projection WHERE qualification_revision=0').get().n)>0)repository.cleanupExpired();
 while(repository.maintainProjectionIndex()){}
 db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
}
async function startBackground(path){
 const worker=new Worker(new URL('./discovery-benchmark-worker.mjs',import.meta.url),{workerData:{path}});
 let failure,done,readySeen=false;const stopped=new Promise((resolve,reject)=>{done=resolve;worker.on('error',error=>{failure=error;reject(error);});});stopped.catch(()=>{});
 const ready=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Benchmark writer readiness timed out')),10000);
  worker.on('message',value=>{if(value.error){failure=new Error(value.error);clearTimeout(timer);reject(failure);done(value);}if(value.ready){readySeen=true;clearTimeout(timer);resolve();}if(value.stopped)done(value);});
  worker.once('error',error=>{clearTimeout(timer);reject(error);});
  worker.once('exit',code=>{clearTimeout(timer);if((code||!readySeen)&&!failure){failure=new Error(`Benchmark writer exited ${code} before completing readiness/work`);reject(failure);}done({exitCode:code});});
 });
 try{await ready;}catch(error){await worker.terminate();throw error;}
 return {check(){if(failure)throw failure;},async stop(){worker.postMessage('stop');let timer;try{return await Promise.race([stopped,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Benchmark writer did not stop')),10000);})]);}finally{clearTimeout(timer);await worker.terminate();}}};
}
function measure(db,condition,pairId){
 const cpuStart=process.threadCpuUsage?.(),preparedStartedAt=performance.now();
 const view=compileRelationshipContext({records:[{id:'synthetic-baseline',content:'Synthetic baseline is mandatory; no personal evidence.',revision:1,sourceFamily:'synthetic',status:'approved',use:'baseline',personalization:true,mention:true}],userInput:input,audienceScope:'authenticatedSession',profileRevision:'synthetic:1',relationshipRevision:'synthetic:1',configurationRevision:'synthetic:1',controls:relationshipControlDefaults});
 const repository=new UnderstandingRepository(db),selectionStartedAt=performance.now();
 const enrichment=selectDiscoveryContext({repository,scope,boundary,input,audience:'authenticatedSession',remainingBytes:view.budget.maximumBytes-view.budget.usedBytes,settings:{...settings,enabled:condition!=='disabled'},current:()=>true});
 const selectionCompletedAt=performance.now();appendDiscoveryContext(view,enrichment);
 const request=buildCanonicalPrompt({assistantId:scope.assistantId,sessionId:'synthetic',interactionId:pairId,endpointId:null,userInput:input,preparedRelationshipContext:view,executionMode:'replay',capabilities:'No tools or effects.',conversation:'Frozen synthetic benchmark.'});
 const preparedCompletedAt=performance.now(),cpu=cpuStart?process.threadCpuUsage(cpuStart):null;
 return {pairId,preparedStartedAt,selectionStartedAt,selectionCompletedAt,preparedCompletedAt,lookupMs:enrichment.lookupElapsedMs,innerSelectionMs:enrichment.selectionElapsedMs,threadCpuMicroseconds:cpu?cpu.user+cpu.system:null,residentMemoryMiB:process.memoryUsage().rss/1048576,selectedItems:enrichment.items.length,enrichmentTokenUpperBound:enrichment.tokenUpperBound,disposition:enrichment.disposition,expectedDetailPresent:request.sections.some(s=>s.kind==='preparedMemory'&&s.content.includes(marker))};
}
try{
 for(const count of [100,10000,100000]){
  const path=join(directory,`${count}.sqlite`);process.stderr.write(`Seeding ${count} synthetic indexed candidates...\n`);seedCorpus(path,count);
  const runs={disabled:[],warm:[],background:[],cold:[]};let background;const backgroundObservations=[];
  try{
   for(const condition of ['disabled','warm','background','cold']){
    if(condition==='background')background=await startBackground(path);
    let db=condition==='cold'?null:new Database({path});
    try{for(let i=0;i<200;i++){
     if(interrupted)throw new Error('Benchmark interrupted by operator; completed corpora retained.');
     background?.check();if(condition==='cold')db=new Database({path});
     try{runs[condition].push(measure(db,condition,`pair:${i}`));}finally{if(condition==='cold'){db.close();db=null;}}
     if(i%20===0)await new Promise(resolve=>setImmediate(resolve));
    }}finally{db?.close();if(background){const result=await background.stop();background=undefined;if(result.error||!result.batches)throw new Error(result.error||'Background workload was not observed');backgroundObservations.push(result);process.stderr.write(`Background writer: ${result.batches} committed batches.\n`);}}
   }
  }finally{if(background)await background.stop();}
  const report=benchmarkDiscoveryLookup({hardware,os:`${platform()} ${release()}; Node ${process.version}`,powerMode,sourceRevision,configurationDigest:understandingDigest({scope,settings,seed,input}),seed,corpusRecords:count,cachePolicy:'disabled/warm/background reuse a connection; cold opens a new SQLite connection per pair. OS page cache and module/JIT caches are not flushed. Fixed block order disabled,warm,background,cold.',backgroundWork:'One isolated worker repeatedly deletes/reinserts the same first 16 irrelevant FTS projections in committed WAL transactions; no source acquisition or model calls.'},runs);
  reports.push({...report,backgroundObservations});process.stderr.write(`${count}: ${report.status}; missing detail ${report.gates.filter(g=>g.metric==='expectedDetail').map(g=>`${g.condition}=${g.count}`).join(', ')}\n`);
 }
 await writeFile(output,JSON.stringify({schemaVersion:'1.0.0',recordedAt:new Date().toISOString(),sourceRevision,sourceChanges,measuredSources,seed,dataset:'Independently authored neutral synthetic sources. Exactly N indexed candidates plus two parent briefs; one relevant candidate at ordinal 73 in all corpora. Direct fixture seeding exercises real persisted projections and selection, not job admission or acquisition.',reports},null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(output);if(reports.some(r=>r.status==='failedLocalObjectives'))process.exitCode=1;
}catch(error){
 await writeFile(output,JSON.stringify({schemaVersion:'1.0.0',status:'interrupted',recordedAt:new Date().toISOString(),sourceRevision,sourceChanges,measuredSources,seed,error:error.message,reports},null,2)+'\n',{flag:'wx',mode:0o600}).catch(()=>{});throw error;
}finally{await rm(directory,{recursive:true,force:true});}
