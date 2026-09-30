import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {evaluateLocalGameFile} from './qualify-local-game.mjs';
const input=()=>({decisions:[],proposals:[],admissions:[],actions:[],observations:[],campaigns:[],episodes:[],projections:[],terminalEpisodes:[]});
async function files(t){const dir=await mkdtemp(join(tmpdir(),'game-lineage-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'input.json'),output=join(dir,'report.json');await writeFile(path,JSON.stringify(input()));return {dir,path,output};}

test('offline evaluator reports missing coverage, source/input hashes and private file permissions without acceptance',async t=>{
 const {path,output}=await files(t),result=await evaluateLocalGameFile(path,output),report=JSON.parse(await readFile(output,'utf8'));
 assert.equal(result.status,'partialDiagnosticCorrelation');assert.equal(result.claimsRuntimeAcceptance,false);assert.equal(result.metadataReplayEqual,true);assert.equal(report.correlation.events.length,0);assert.ok(report.correlation.missingEvidence.includes('observationsCoverageMissing'));assert.equal(report.perceptionReplayed,false);assert.equal(report.liveEffects,false);assert.equal(report.durableReinforcement,false);assert.equal(report.manifest.liveRoute,false);assert.match(report.inputSha256,/^[a-f0-9]{64}$/);assert.equal(report.evaluatorSources.length,3);assert.equal((await stat(output)).mode&0o777,0o600);
 const prior=await readFile(output,'utf8');await assert.rejects(evaluateLocalGameFile(path,output));assert.equal(await readFile(output,'utf8'),prior);
});
test('CLI accepts only local file/options and preserves original report on repeated invocation',async t=>{
 const {path,output}=await files(t),args=['--experimental-strip-types',fileURLToPath(new URL('./qualify-local-game.mjs',import.meta.url)),'--input',path,'--output',output];
 const run=spawnSync(process.execPath,args,{encoding:'utf8',timeout:15000});assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).claimsRuntimeAcceptance,false);assert.equal(JSON.parse(run.stdout).status,'partialDiagnosticCorrelation');
 const prior=await readFile(output,'utf8'),again=spawnSync(process.execPath,args,{encoding:'utf8',timeout:15000});assert.equal(again.status,1);assert.equal(await readFile(output,'utf8'),prior);
 const bad=spawnSync(process.execPath,[...args,'--provider','live:forbidden'],{encoding:'utf8',timeout:15000});assert.equal(bad.status,1);assert.doesNotMatch(bad.stderr,/live:forbidden/);
});
test('report writer rejects connected repository and symlinked output parents',async t=>{
 const {path,dir}=await files(t);await assert.rejects(evaluateLocalGameFile(path,fileURLToPath(new URL('../game-lineage-test-output.json',import.meta.url))),/outside/);
 const link=join(dir,'linked-repository');await symlink(fileURLToPath(new URL('../',import.meta.url)),link);await assert.rejects(evaluateLocalGameFile(path,join(link,'game-lineage-test-output.json')),/outside/);
});
test('malformed, excess, non-file and unrecognized data never create reports or echo private payload',async t=>{
 const {path,output,dir}=await files(t);
 for(const value of ['not json',JSON.stringify({...input(),scene:'PRIVATE_SCENE'}),JSON.stringify({...input(),observations:Array(33).fill({})}),Buffer.alloc(262144+1)]){await writeFile(path,value);await assert.rejects(evaluateLocalGameFile(path,output));await assert.rejects(stat(output));}
 await assert.rejects(evaluateLocalGameFile(dir,output));await assert.rejects(stat(output));
 const fifo=join(dir,'input.fifo'),created=spawnSync('mkfifo',[fifo],{encoding:'utf8',timeout:1000});assert.equal(created.status,0,created.stderr);
 const run=spawnSync(process.execPath,['--experimental-strip-types',fileURLToPath(new URL('./qualify-local-game.mjs',import.meta.url)),'--input',fifo,'--output',output],{encoding:'utf8',timeout:5000});assert.equal(run.status,1,run.stderr);assert.equal(run.error,undefined);await assert.rejects(stat(output));
});
