import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createContractValidator} from '@lifestream/contracts';

const validator=createContractValidator();
const schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';

test('game proposal and decision preserve exact server SHA256 or legacy UUID prepared identity',()=>{
 const fingerprint=createHash('sha256').update('authenticated original prepared context').digest('hex');
 for(const type of ['GameActionProposal','GameDecisionInput']){
  const field=schema+type+'/properties/invalidationKey';
  for(const key of [randomUUID(),fingerprint])assert.equal(validator.validate(field,key).valid,true);
  for(const key of ['', 'unbounded-arbitrary-key', fingerprint.slice(1), fingerprint+'0', fingerprint.toUpperCase(), 'g'.repeat(64), fingerprint+'\n', null, 42]){
   assert.equal(validator.validate(field,key).valid,false);
  }
 }
 assert.equal(validator.validate(schema+'GameActionProposal/properties/preparedViewId',fingerprint).valid,false);
 assert.equal(validator.validate(schema+'GameDecisionInput/properties/viewId',fingerprint).valid,false);
});
