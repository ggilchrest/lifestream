import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

test('actual native capture converts synthetic PCM and isolates each graph queue',{skip:process.platform!=='darwin'},async()=>{
 const root=new URL('../',import.meta.url),directory=await mkdtemp(join(tmpdir(),'ls-ios-capture-'));
 try{
  await copyFile(new URL('test/capture-probe.swift',root),join(directory,'main.swift'));
  const built=spawnSync('swiftc',[fileURLToPath(new URL('ios/App/CapApp-SPM/Sources/CapApp-SPM/NativeCapture.swift',root)),join(directory,'main.swift'),'-o',join(directory,'probe')],{encoding:'utf8'});
  assert.equal(built.status,0,built.stderr);
  const run=spawnSync(join(directory,'probe'),[],{encoding:'utf8',timeout:15000});
  assert.equal(run.status,0,run.stderr);const result=JSON.parse(run.stdout);
  assert.equal(result.nativeCapture,'pass');assert.equal(result.physicalMicrophone,false);assert.equal(result.pendingBound,8);
 }finally{await rm(directory,{recursive:true,force:true});}
});
