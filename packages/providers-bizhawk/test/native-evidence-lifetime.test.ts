import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {NativeGameEvidence} from '../src/native-evidence.ts';
import {createNativeExecutionLifetime} from '../src/native-execution-lifetime.ts';
import {observe} from './game-host-fixtures.ts';

test('native evidence /3 follows original dual-clock custody while legacy constructor duration remains unchanged',t=>{
 let wall=1000000,mono=100;t.mock.method(Date,'now',()=>wall);t.mock.method(performance,'now',()=>mono);
 const root=mkdtempSync(join(tmpdir(),'ct-evidence-clock-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const source=join(root,'synthetic-source'),raw=Buffer.from('Synthetic source only, no emulator.');writeFileSync(source,raw);
 const originalScope=observe().scope,pinsDigest='a'.repeat(64),controller=new AbortController(),lifecycle=Object.freeze({signal:controller.signal,check:()=>true});
 const executionLifetime=createNativeExecutionLifetime(lifecycle,new Date(wall+120000).toISOString());
 for(const mode of ['legacy','execution']){
  const directory=join(root,mode);requireDirectory(directory);
  const evidence=new NativeGameEvidence({directory,scope:originalScope,pinsDigest,providerRef:'synthetic-bridge',romSha1:'b'.repeat(40),sourceFiles:[{path:source,sha256:createHash('sha256').update(raw).digest('hex')}],custody:{} as any,sessionDurationMs:1,isCurrent:()=>true,...(mode==='execution'?{executionLifetime}:{})});
  assert.equal(evidence.installationAvailable(originalScope,pinsDigest),true);wall+=5;mono+=5;
  assert.equal(evidence.installationAvailable(originalScope,pinsDigest),mode==='execution');
  if(mode==='execution'){
   evidence.bindOwnedProcess({pid:123,exitCode:null,signalCode:null} as any);
   writeFileSync(evidence.evidenceFile,JSON.stringify({schemaVersion:'1.0.0',recordType:'nativeGameEvidence',scope:originalScope,pinsDigest,providerRef:'synthetic-bridge',romSha1:'b'.repeat(40),version:'2.11.1',system:'SNES',sequence:1,frameNumber:10,monotonicMs:1,checkedAt:new Date(wall).toISOString(),buttonsAvailable:true,buttons:Object.fromEntries(['Up','Down','Left','Right','A','B','X','Y','L','R','Start','Select'].map(k=>[k,false])),event:'ready'}));
   assert.equal(evidence.sourceAvailable(originalScope,pinsDigest),true);controller.abort();assert.equal(evidence.sourceAvailable(originalScope,pinsDigest),false);assert.equal(evidence.installationAvailable(originalScope,pinsDigest),false);
  }
 }
});
import {mkdirSync} from 'node:fs';function requireDirectory(path:string){mkdirSync(path,{mode:0o700});}
