import assert from 'node:assert/strict';import{test}from'node:test';import{externalFailureOutcome,lostInvalidationOutcome,readinessOutcome,restoreOutcome}from'../src/authority/scenarios.ts';
test('LS-AUTH-T013 lost invalidation requires refresh',()=>assert.equal(lostInvalidationOutcome(false,2,1),'refreshRequired'));
test('LS-AUTH-T014 external failure never falls back',()=>assert.equal(externalFailureOutcome(false),'denyNoFallback'));
test('LS-AUTH-T016 restore remains quarantined until reconciliation',()=>assert.equal(restoreOutcome(false),'quarantined'));
test('LS-AUTH-T023 fixture readiness allowed while unavailable non-fixture blocked',()=>{assert.equal(readinessOutcome({configured:true,available:true,fixtureProfile:true,decisionResolved:false}),'ready');assert.equal(readinessOutcome({configured:true,available:true,fixtureProfile:false,decisionResolved:false}),'blocked')});
