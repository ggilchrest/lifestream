import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {createContractValidator} from '../src/validator.ts';

test('local handoff authorization is closed and cannot become a capability decision',()=>{
 const validator=createContractValidator(),ref='https://lifestream.dev/contracts/runtime-api/1.0.0#/$defs/SessionHandoffAuthorization';
 const value={schemaVersion:'1.0.0',kind:'authenticatedSessionHandoff',disposition:'authorized',grantsTransferred:false,decisionId:randomUUID(),principalId:randomUUID(),assistantId:randomUUID(),sourceSessionId:randomUUID(),destinationSessionId:randomUUID(),sourceEndpointId:randomUUID(),destinationEndpointId:randomUUID(),sourceReviewId:randomUUID(),destinationReadinessId:randomUUID(),sourceRevision:1,destinationRevision:1,inputDigest:'a'.repeat(64),scopeDigest:'b'.repeat(64),evaluatedAt:new Date().toISOString()};
 assert.equal(validator.validate(ref,value).valid,true);
 for(const change of [{grantsTransferred:true},{kind:'dispatch'},{destinationReadinessId:null},{sourceRevision:0},{inputDigest:'unbound'},{capability:'invoke'}, {credential:'token'}])assert.equal(validator.validate(ref,{...value,...change}).valid,false);
 assert.equal(validator.validate('https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/AuthorityDecision',value).valid,false);
});
