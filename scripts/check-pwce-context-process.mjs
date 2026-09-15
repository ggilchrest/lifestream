import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';

const consumer=fileURLToPath(new URL('..',import.meta.url));
const producer=resolve(process.env.PWCE_FIXTURE_REPOSITORY??fileURLToPath(new URL('../../PWCE',import.meta.url)));
const token=randomUUID()+randomUUID();
const host=spawn(process.execPath,['scripts/gateway-fixture-server.mjs'],{cwd:producer,env:{PATH:process.env.PATH,PWCE_FIXTURE_TOKEN:token,PWCE_FIXTURE_SCENARIO:'qualified-context'},stdio:['pipe','pipe','pipe']});
let hostError='';host.stderr.on('data',chunk=>{hostError+=String(chunk).slice(0,4096-hostError.length);});
const hostExited=once(host,'exit');
let child;
try{
 const ready=await Promise.race([
  new Promise((resolve,reject)=>{
   let buffer='';host.stdout.on('data',chunk=>{
    buffer+=String(chunk);if(buffer.length>4096){reject(new Error('Fixture readiness exceeds its bound.'));return;}
    if(buffer.includes('\n')){try{resolve(JSON.parse(buffer.split('\n')[0]));}catch{reject(new Error('Fixture readiness is invalid.'));}}
   });
  }),
  hostExited.then(()=>{throw new Error('Fixture exited before readiness.');}),
  new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Fixture readiness timed out.')),10000);timer.unref();})
 ]);
 assert.equal(ready.fixture,true);assert.equal(ready.scenario,'qualified-context');assert.equal(ready.liveEffects,false);
 const url=new URL(ready.url);assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');
 assert.equal(typeof ready.historicalBoundary,'string');
 child=spawn(process.execPath,['scripts/check-pwce-context.mjs'],{cwd:consumer,env:{PATH:process.env.PATH,PWCE_GATEWAY_URL:ready.url,PWCE_GATEWAY_TOKEN:token,PWCE_FIXTURE_HISTORICAL_BOUNDARY:ready.historicalBoundary},stdio:['ignore','pipe','pipe']});
 let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=String(chunk);if(output.length>65536)child.kill('SIGTERM');});
 const timeout=setTimeout(()=>child.kill('SIGTERM'),50000);timeout.unref();
 const [code]=await once(child,'exit');clearTimeout(timeout);
 assert.equal(output.includes(token),false,'synthetic token must not appear in diagnostics');
 process.stdout.write(output);assert.equal(code,0,'separate-process context conformance');
}finally{
 if(child&&child.exitCode===null)child.kill('SIGTERM');
 host.stdin.end('stop\n');
 await Promise.race([hostExited,new Promise(resolve=>{const timer=setTimeout(()=>{host.kill('SIGTERM');resolve();},5000);timer.unref();})]);
 if(hostError){assert.equal(hostError.includes(token),false);process.stderr.write(hostError);}
}
