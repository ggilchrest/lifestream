import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {createContractValidator} from '../src/validator.ts';
test('audio playback settlement has a closed trace-bound bounded contract',()=>{
 const validator=createContractValidator(),id='https://lifestream.dev/contracts/runtime-api/1.0.0#/$defs/AudioClientMessage';
 const value={type:'playbackSettled',interactionTraceId:randomUUID(),outcome:'completed',receivedSamples:4800};
 assert.equal(validator.validate(id,value).valid,true);assert.equal(validator.validate(id,{...value,outcome:'stopped',receivedSamples:0}).valid,true);
 for(const patch of [{receivedSamples:-1},{receivedSamples:8640001},{receivedSamples:1.2},{receivedSamples:'4800'},{interactionTraceId:'foreign'},{outcome:'heard'},{heardByHuman:true}])assert.equal(validator.validate(id,{...value,...patch}).valid,false);
});
