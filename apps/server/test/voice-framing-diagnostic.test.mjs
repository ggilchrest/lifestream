import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {VoiceResponseRouter} from '@lifestream/runtime/voice/response-router';
const {VoiceFailureTracker}=await import(process.env.VOICE_FAILURE_COMPILED==='1'?'../dist/runtime/voice-failure.js':'../src/runtime/voice-failure.ts');
const parserError=()=>{try{new VoiceResponseRouter().push('PRIVATE_MODEL_SENTINEL\n');}catch(error){return error;}throw Error('expected rejection');};
test('parser-authored reason appears once in diagnostic and never in wire failure origin',()=>{
 const records=[],tracker=new VoiceFailureTracker(randomUUID(),r=>records.push(r));
 const error=tracker.capture(parserError(),'framing','invalid_response');
 assert.deepEqual(tracker.report(error),{stage:'framing',code:'invalid_response'});tracker.report(error);
 assert.equal(records.length,1);assert.equal(records[0].framingReason,'malformed_record');
 assert.deepEqual(Object.keys(records[0]).sort(),['event','version','interactionTraceId','stage','code','provider','elapsedMs','framingReason'].sort());
 assert.equal(records[0].provider,'none');assert.doesNotMatch(JSON.stringify(records),/PRIVATE|MODEL|SENTINEL|message|stack/);
});
test('forged reasons/messages and non-framing origins cannot enter diagnostic',()=>{
 for(const [error,stage] of [[Object.assign(Error('Malformed voice response record PRIVATE'),{framingReason:'malformed_record',reason:'PRIVATE'}),'framing'],[parserError(),'inference'],[Error('inference returned no text'),'framing']]){
  const records=[],tracker=new VoiceFailureTracker(randomUUID(),r=>records.push(r));
  tracker.report(tracker.capture(error,stage,'invalid_response'));
  assert.equal(Object.hasOwn(records[0],'framingReason'),false);assert.doesNotMatch(JSON.stringify(records),/PRIVATE|message|stack/);
 }
});
test('origin follows parser error across synthesis consumer without broadening failure wire fields',async()=>{
 const records=[],tracker=new VoiceFailureTracker(randomUUID(),r=>records.push(r));
 const original=tracker.capture(parserError(),'framing','invalid_response');
 await assert.rejects(tracker.during('synthesis',async()=>{throw original;}),error=>{
  assert.equal(error,original);assert.deepEqual(tracker.report(error),{stage:'framing',code:'invalid_response'});return true;
 });
 assert.equal(records[0].framingReason,'malformed_record');
});
