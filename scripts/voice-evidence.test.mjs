import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VoiceEvidence} from './voice-evidence.mjs';
test('failed assertion retains partial PCM, events, exact text and failure report',()=>{
  const root=mkdtempSync(join(tmpdir(),'voice-evidence-test-'));
  try {
    const evidence=new VoiceEvidence('fixture',root),record=evidence.startCase('original',{text:'Preserve the full original request.',totalDeadlineMs:60000});
    evidence.event(record,{kind:'data',frame:{dataBase64:'AAABAA==',sampleOffset:0,sampleCount:2}});
    evidence.event(record,{kind:'terminal',outcome:'timedOut'});
    evidence.finish('failed',new Error('original deadline exceeded'));
    const report=JSON.parse(readFileSync(join(evidence.directory,'result.json')));
    assert.equal(report.outcome,'failed');assert.equal(report.cases[0].samples,2);
    assert.equal(report.cases[0].configuration.totalDeadlineMs,60000);
    assert.equal(readFileSync(join(evidence.directory,'original.pcm')).length,4);
    assert.match(readFileSync(join(evidence.directory,'original.events.ndjson'),'utf8'),/timedOut/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
