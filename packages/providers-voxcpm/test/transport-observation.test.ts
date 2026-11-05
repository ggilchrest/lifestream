import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,readFileSync,existsSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTransportObservation} from '../src/transport-observation.ts';
test('closed adapter records redact arbitrary fields, bound storage and expire without new request',()=>{
 const directory=mkdtempSync(join(tmpdir(),'tts-observation-'));chmodSync(directory,0o700);let now=100000;const observer=createTransportObservation(directory,now+200000000,()=>now),path=join(directory,'adapter.jsonl'),id='61420c1f-4e12-43c1-a6be-8e2136bf1b42:cbb69a36-412b-4c27-9b7b-28efde8e0382';
 try{observer.emit('http_failure',id,{elapsedMs:5,aborted:false,timedOut:false,bytesRead:0,bytesWritten:55,localPort:32123,text:'SECRET',headers:'SECRET',error:'SECRET',remoteAddress:'SECRET'});const row=JSON.parse(readFileSync(path,'utf8'));assert.deepEqual(Object.keys(row).sort(),['aborted','atMs','bytesRead','bytesWritten','elapsedMs','event','localPort','requestId','timedOut'].sort());assert.ok(!readFileSync(path,'utf8').includes('SECRET'));
 observer.emit('http_begin','a'.repeat(36)+':'+ 'b'.repeat(36));assert.equal(readFileSync(path,'utf8').trim().split('\n').length,1);
 for(let i=0;i<600;i++)observer.emit('http_begin',id);assert.equal(readFileSync(path,'utf8').trim().split('\n').length,256);assert.ok(statSync(path).size<=131072);assert.equal(statSync(path).mode&0o777,0o600);
 now+=86400001;observer.emit('http_begin',id);assert.equal(readFileSync(path,'utf8').trim().split('\n').length,1);
 now+=200000000;observer.emit('http_begin',id);assert.equal(readFileSync(path,'utf8').trim().split('\n').length,1);observer.prune();assert.equal(existsSync(path),false);
 }finally{observer.close();rmSync(directory,{recursive:true,force:true});}
});
test('observer rejects non-closed event/identity and cannot break provider when directory unavailable',()=>{
 const observer=createTransportObservation('/nonexistent/synthetic-only',Date.now()+10000);try{assert.doesNotThrow(()=>observer.emit('http_failure','bad',{bytesRead:NaN}));assert.doesNotThrow(()=>observer.emit('http_begin','61420c1f-4e12-43c1-a6be-8e2136bf1b42:cbb69a36-412b-4c27-9b7b-28efde8e0382'));}finally{observer.close();}
});
