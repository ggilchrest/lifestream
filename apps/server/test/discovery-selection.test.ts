import assert from 'node:assert/strict';
import test from 'node:test';
import type {UnderstandingRepository} from '@lifestream/storage-sqlite';
import {selectDiscoveryContext} from '../src/admin/discovery-selection.ts';

const scope={assistantId:'synthetic-assistant',userId:'synthetic-user',relationshipId:'synthetic-relationship',deploymentId:'synthetic-deployment'};

test('Discovery measures lookup and inner selection inside the same unchanged total deadline',()=>{
 for(const [lookupMs,innerMs,disposition]of [[6,2,'included'],[9,1,'deadline'],[11,0,'deadline']] as const){
  let clock=100,checks=0;
  const repository={select(){clock+=lookupMs;return [{id:'synthetic-source',content:'Synthetic contextual detail.',rank:0,freshUntil:Date.now()+60000}];}} as unknown as UnderstandingRepository;
  const result=selectDiscoveryContext({repository,scope,boundary:'synthetic-boundary',input:'synthetic detail',audience:'authenticatedSession',remainingBytes:1024,settings:{enabled:true,budget:{enrichmentTokens:512,selectedItems:4,optionalSelectionDeadlineMs:10}},current:()=>{if(checks++===0)clock+=innerMs;return true;},now:()=>clock});
  assert.equal(result.lookupElapsedMs,lookupMs);
  assert.equal(result.selectionElapsedMs,innerMs);
  assert.equal(result.elapsedMs,lookupMs+innerMs);
  assert.equal(result.disposition,disposition);
  if(disposition==='included')assert.match(result.content,/Synthetic contextual detail/);
  else {assert.equal(result.content,'');assert.deepEqual(result.items,[]);assert.equal(result.tokenUpperBound,0);}
 }
});

test('Discovery timing never releases context after a lookup clock reversal or scope revocation',()=>{
 for(const fault of ['clockReversal','scopeRevocation'] as const){
  let clock=100,current=true;
  const repository={select(){if(fault==='clockReversal')clock=99;else current=false;return [{id:'synthetic-source',content:'Withheld synthetic detail.',rank:0,freshUntil:Date.now()+60000}];}} as unknown as UnderstandingRepository;
  const result=selectDiscoveryContext({repository,scope,boundary:'synthetic-boundary',input:'synthetic detail',audience:'authenticatedSession',remainingBytes:1024,settings:{enabled:true,budget:{enrichmentTokens:512,selectedItems:4,optionalSelectionDeadlineMs:10}},current:()=>current,now:()=>clock});
  assert.equal(result.disposition,fault==='clockReversal'?'deadline':'boundaryChanged');
  assert.equal(result.content,'');assert.deepEqual(result.items,[]);assert.equal(result.tokenUpperBound,0);
 }
});
