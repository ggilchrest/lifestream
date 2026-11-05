import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {VoiceFailureTracker,providerFailureCode} from '../src/runtime/voice-failure.ts';
test('diagnostic is closed, once per turn, and cannot include provider content',()=>{
 const records=[],tracker=new VoiceFailureTracker(randomUUID(),r=>records.push(r),()=>100);
 const error=tracker.capture(Object.assign(Error('PRIVATE_TRANSCRIPT_TOKEN_URL'),{prompt:'PRIVATE_PROMPT',headers:{Authorization:'SECRET'}}),'recognition','provider_timeout');
 assert.deepEqual(tracker.report(error),{stage:'recognition',code:'provider_timeout'});tracker.report(error);
 assert.equal(records.length,1);assert.deepEqual(Object.keys(records[0]).sort(),['event','version','interactionTraceId','stage','code','provider','elapsedMs'].sort());
 assert.equal(/PRIVATE|SECRET|TOKEN|URL/.test(JSON.stringify(records)),false);assert.equal(records[0].provider,'recognition');
});
test('concurrent queue propagation preserves originating branch instead of consumer phase',async()=>{
 const tracker=new VoiceFailureTracker(randomUUID(),()=>{}),original=tracker.capture(Error('hidden'),'inference','provider_protocol');
 await assert.rejects(tracker.during('synthesis',async()=>{await Promise.resolve();throw original;}),error=>{assert.equal(error,original);assert.deepEqual(tracker.report(error),{stage:'inference',code:'provider_protocol'});return true;});
});
test('independent concurrent errors retain individual origin and reused errors cannot cross turns',()=>{
 const shared=Error('hidden'),a=new VoiceFailureTracker(randomUUID(),()=>{}),b=new VoiceFailureTracker(randomUUID(),()=>{});
 const first=a.capture(shared,'inference'),second=a.capture(Error('other'),'synthesis');b.capture(shared,'recognition');
 assert.equal(a.origin(first).stage,'inference');assert.equal(a.origin(second).stage,'synthesis');assert.equal(b.origin(shared).stage,'recognition');
});
test('throwing logger cannot replace failure; untrusted enums and traces never enter diagnostics',()=>{
 const tracker=new VoiceFailureTracker(randomUUID(),()=>{throw Error('logging unavailable');});assert.deepEqual(tracker.report(Error('hidden')),{stage:'unknown',code:'failed'});
 const records=[],other=new VoiceFailureTracker('private-invalid-trace',r=>records.push(r));other.report(other.capture(Error('hidden'),'PRIVATE_STAGE','PRIVATE_CODE'));assert.equal(records.length,0);
 const closed=new VoiceFailureTracker(randomUUID(),r=>records.push(r));assert.deepEqual(closed.report(closed.capture(Error('hidden'),'PRIVATE_STAGE','PRIVATE_CODE')),{stage:'unknown',code:'failed'});assert.equal(JSON.stringify(records).includes('PRIVATE'),false);
});
test('async provider throws keep typed origin and provider codes are bounded',async()=>{
 const tracker=new VoiceFailureTracker(randomUUID(),()=>{});
 async function* source(){yield 1;throw Error('private provider payload');}
 await assert.rejects(async()=>{for await(const item of tracker.stream('synthesis',source))assert.equal(item,1);},e=>{assert.equal(tracker.origin(e).stage,'synthesis');return true;});
 for(const [code,want] of [['timedOut','provider_timeout'],['providerUnavailable','provider_unavailable'],['malformed_provider_event','provider_protocol'],['response_limit','output_limit'],['PRIVATE_TEXT','provider_failed']])assert.equal(providerFailureCode(code),want);
});
