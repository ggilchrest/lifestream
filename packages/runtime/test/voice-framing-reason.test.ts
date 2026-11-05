import assert from 'node:assert/strict';
import test from 'node:test';
import {VoiceResponseRouter,voiceResponseFramingReason,voiceResponseFramingReasons} from '../src/voice/response-router.ts';
const header='{"version":"voice-response/1"}\n';
const record=(channel:string,text:string)=>JSON.stringify({channel,text})+'\n';
const speech=record('speech','Hello.');
const cases:[string,string,string][]=[
 ['wire_limit',' '.repeat(65537),'Voice response wire limit exceeded'],
 ['frame_limit',header+' '.repeat(4097),'Voice response frame limit exceeded'],
 ['frame_limit',header+JSON.stringify({channel:'display',text:'x'.repeat(4097)})+'\n','Voice response frame limit exceeded'],
 ['missing_speech',header,'Voice response has no framed speech'],
 ['malformed_record','PRIVATE_BODY_SENTINEL\n','Malformed voice response record'],
 ['invalid_record','[]\n','Invalid voice response record'],
 ['unsupported_framing','{"version":"PRIVATE_BODY_SENTINEL"}\n','Unsupported voice response framing'],
 ['invalid_unit',header+'{"channel":"PRIVATE_BODY_SENTINEL","text":"secret"}\n','Invalid voice response unit'],
 ['text_limit',header+speech.repeat(129),'Voice response text limit exceeded'],
 ['speech_after_display',header+speech+record('display','Table')+speech,'Speech cannot follow a display-only supplement'],
 ['invalid_speech_prose',header+record('speech','```PRIVATE_BODY_SENTINEL```'),'Speech unit must be bounded plain prose'],
 ['display_before_speech',header+record('display','PRIVATE_BODY_SENTINEL'),'Display supplement must follow speech'],
];
for(const [reason,body,message] of cases)test(`parser mints closed ${reason} without changing rejection`,()=>{
 const router=new VoiceResponseRouter();
 assert.throws(()=>{router.push(body);router.finish();},error=>{
  assert.ok(error instanceof Error);assert.equal(error.message,message);assert.equal(voiceResponseFramingReason(error),reason);
  assert.doesNotMatch(JSON.stringify(error),/PRIVATE_BODY_SENTINEL|secret/);return true;
 });
 assert.deepEqual(router.push(header+speech),[]);assert.deepEqual(router.finish(),[]);
});
test('reason lookup accepts only parser-minted errors, never message/property/prototype claims',()=>{
 const forged=Object.assign(new Error('Malformed voice response record'),{reason:'malformed_record',framingReason:'malformed_record'});
 assert.equal(voiceResponseFramingReason(forged),undefined);
 assert.equal(voiceResponseFramingReason({get reason(){throw Error('PRIVATE');}}),undefined);
 assert.deepEqual(new Set(cases.map(([reason])=>reason)),new Set(voiceResponseFramingReasons));
});
