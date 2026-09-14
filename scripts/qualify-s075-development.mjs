import { persistModelQuality } from './model-quality-observations.mjs';
// Actual rendered S075 journey against the existing selected development provider.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWindowsKey, sshArgs } from '../../orchestration/scripts/start-conversation.mjs';
const exec=promisify(execFile),repository=fileURLToPath(new URL('../',import.meta.url));
const listening=port=>new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port});socket.setTimeout(500);for(const event of ['connect','error','timeout'])socket.once(event,()=>{socket.destroy();resolve(event==='connect');});});
const report={slice:'LS-S075',collectedAt:new Date().toISOString(),checks:[],exclusions:['No personal data, physical output, Human fit acceptance, training, deployment, production or provider service changes']};let tunnel,root,key;
try{
 report.sourceRevision=(await exec('git',['rev-parse','HEAD'],{cwd:repository})).stdout.trim();report.scriptSha256=createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');report.selectedProfileSha256=createHash('sha256').update(await readFile(new URL('../apps/server/src/config/profiles/ai5090.json',import.meta.url))).digest('hex');report.sourceWorktreeStatus=(await exec('git',['status','--porcelain','--untracked-files=no'],{cwd:repository})).stdout.trim();
 const ports=await Promise.all([43000,48080,48787].map(listening));assert.ok(ports.every(Boolean)||ports.every(value=>!value),'mixed tunnel ownership');
 if(!ports.every(Boolean)){tunnel=spawn('ssh',sshArgs(),{stdio:['ignore','ignore','ignore']});let failed=false;tunnel.once('error',()=>{failed=true;});tunnel.once('exit',()=>{failed=true;});for(let i=0;i<30&&!failed&&!(await listening(43000));i++)await new Promise(resolve=>setTimeout(resolve,250));assert.ok(!failed&&await listening(43000),'selected tunnel unavailable');}
 key=await loadWindowsKey();root=await mkdtemp(join(tmpdir(),'ls-s075-report-'));const output=join(root,'report.json');
 await exec(process.execPath,['--test','apps/control-web/test/relationship-administration.test.mjs'],{cwd:repository,env:{...process.env,LIFESTREAM_INFERENCE_API_KEY:key,LIFESTREAM_S075_PROVIDER:'selected',LIFESTREAM_S075_REPORT:output},timeout:120000,maxBuffer:1024*1024});
 const evidence=JSON.parse(await readFile(output,'utf8'));assert.equal(evidence.result,'pass');assert.equal(evidence.selectedProvider,true);report.checks.push({id:'LS-TEST-090-rendered-selected-provider',result:'pass',evidence});report.result='pass';
}catch(error){if(root){try{report.joinedEvidence=JSON.parse(await readFile(join(root,'report.json'),'utf8'));}catch{/* No observed journey output yet. */}}report.result='fail';report.blocker=error instanceof assert.AssertionError?error.message:'Bounded rendered/provider check failed; no credentials logged.';report.failureEvidence=typeof error.stdout==='string'?error.stdout.slice(-12000):undefined;process.exitCode=1;}
finally{tunnel?.kill('SIGTERM');if(root)await rm(root,{recursive:true,force:true});key=undefined;await persistModelQuality(repository,report);console.log(JSON.stringify(report,null,2));}
