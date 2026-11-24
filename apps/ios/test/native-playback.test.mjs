import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

test('AVAudioEngine offline waveform continuity, paused startup, cancellation and resampling; device completion not exercised',{skip:process.platform!=='darwin'},async()=>{
 const root=new URL('../',import.meta.url),directory=await mkdtemp(join(tmpdir(),'ls-ios-playback-'));
 try{
  await copyFile(new URL('test/playback-render-probe.swift',root),join(directory,'main.swift'));
  const sources=['VoiceProtocol.swift','PlaybackPCM.swift'].map(name=>fileURLToPath(new URL(`native/Sources/AssistantCore/${name}`,root)));
  const built=spawnSync('swiftc',[...sources,join(directory,'main.swift'),'-o',join(directory,'probe')],{encoding:'utf8',timeout:60000});
  assert.equal(built.status,0,built.stderr);
  const run=spawnSync(join(directory,'probe'),[],{encoding:'utf8',timeout:15000});
  assert.equal(run.status,0,run.stderr);const result=JSON.parse(run.stdout);
  assert.equal(result.nativePlayback,'pass');assert.equal(result.physicalMicrophone,false);assert.equal(result.physicalOutput,false);
  assert.equal(result.scope,'offline waveform only; device dataPlayedBack completion not exercised');
  assert.equal(result.sourceRate,48000);assert.deepEqual(result.renderRates,[48000,16000]);assert.equal(result.exactPCMFrames,7853);
  assert.ok(Math.abs(result.resampledRMS-0.25/Math.sqrt(2))<0.003);assert.ok(Math.abs(result.positiveCrossings-800)<=1);
 }finally{await rm(directory,{recursive:true,force:true});}
});
