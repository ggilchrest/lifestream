// Opt-in private noncommercial evaluation. No dataset audio enters source control.
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {VoiceEvidence} from './voice-evidence.mjs';
const revision='33c8ce9eb2cf0b1c2f8bcf322eb349b6be34dbb6';
const base=`https://raw.githubusercontent.com/karolpiczak/ESC-50/${revision}`;
const fixtures=[['coughing','1-19111-A-24.wav'],['keyboard_typing','1-137-A-32.wav'],['mouse_click','1-118206-A-31.wav'],['breathing','1-18631-A-23.wav']];
const evidence=new VoiceEvidence('noise-corpus');
try{
  const license=await fetch(`${base}/LICENSE`,{signal:AbortSignal.timeout(15000)}).then(r=>{assert.equal(r.status,200);return r.text();});
  assert.match(license,/Attribution-NonCommercial/);writeFileSync(join(evidence.directory,'LICENSE.txt'),license,{mode:0o600});
  let failed=false;
  for(const [category,file] of fixtures){
    const record=evidence.startCase(category,{dataset:'ESC-50 by Karol J. Piczak',revision,source:`${base}/audio/${file}`,license:'CC BY-NC 3.0 dataset; individual attribution in adjacent LICENSE.txt',use:'private noncommercial diagnostic only'});
    const response=await fetch(record.configuration.source,{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length<2000000);
    writeFileSync(join(evidence.directory,file),bytes,{mode:0o600});record.sha256=createHash('sha256').update(bytes).digest('hex');
    const output=join(evidence.directory,`${category}.pcm`),convert=spawnSync('ffmpeg',['-nostdin','-v','error','-i',join(evidence.directory,file),'-ac','1','-ar','48000','-f','s16le',output],{timeout:15000,encoding:'utf8'});assert.equal(convert.status,0,convert.stderr);
    const check=spawnSync(process.execPath,['scripts/check-browser-vad.mjs'],{env:{...process.env,VOICE_FIXTURE_PCM:output,VOICE_NOISE_FIXTURE:'1'},timeout:60000,encoding:'utf8'});
    record.outcome=check.status===0?'passed':'failed';record.result=(check.stdout||check.stderr).trim();failed ||=check.status!==0;evidence.finish('inProgress');console.log(JSON.stringify({category,outcome:record.outcome,result:record.result}));
  }
  evidence.finish(failed?'failed':'passed');console.log(JSON.stringify({artifacts:evidence.directory,outcome:failed?'failed':'passed',claim:'four declared clips and scaled versions only; no physical AEC'}));if(failed)process.exitCode=1;
}catch(error){evidence.finish('failed',error);console.error(JSON.stringify({error:error.message,artifacts:evidence.directory}));process.exitCode=1;}
