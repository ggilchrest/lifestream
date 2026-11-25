import test from 'node:test';
import assert from 'node:assert/strict';
import {enableHealthSharing, stopHealthSharing, disableAssistantSharing} from '../web/health-sharing.js';

const context = {endpointId:'phone', revision:7, assistantId:'assistant'};
test('turning sharing off uses the current saved preference while the choice list is empty', async () => {
  const requests=[];
  await stopHealthSharing(async (_,input) => {
    requests.push(input.operation);
    return {persistence:input.operation==='stopCurrent'?'savedDisabled':'savedEnabled',choices:[]};
  });
  assert.deepEqual(requests,['status','stopCurrent']);
});
function fixture() {
  const calls = [], grants = new Set();
  let enrollment, source, action, consent, pendingApproval, prepared = false, sharing = false;
  async function call(name, input = {}) {
    calls.push(name);
    switch (name) {
      case 'healthReleaseSharingProfile': prepared=false;return {ready:true};
      case 'healthAssistantSharing':
        assert.equal(input.assistantId,context.assistantId);
        if(input.action==='allowCategory')return {approved:true};
        return {enabled:input.action==='enable'};
      case 'healthChooseRecords': return {completed:true};
      case 'healthSetupChoices': return prepared ? {state:'available',catalogId:'local',choices:[{choice:'device'}]} : {choices:[]};
      case 'healthInventory': return {sources:source ? [source] : []};
      case 'healthRemoteSetupOptions': return input.close ? {reason:'closed'} :
        {state:'options',catalogId:'server',destination:'fixture',enrollments:enrollment ? [enrollment] : []};
      case 'healthReviewRemoteSetup':
        action = input;
        return {state:'review',reviewId:'review',summary:{kind:action.kind,destination:'fixture'}};
      case 'healthApplyRemoteSetup':
        assert.equal(input.humanConfirmed,true);
        if (action.kind === 'enroll') enrollment = {choice:'enrolled',bound:false};
        if (action.kind === 'bindSource') {
          enrollment.bound = true;
          source = {collector:'healthKit',sourceNamespace:'source',currentEnrollmentId:'id',policyRevision:1,
            categories:[],uses:[],assistantIds:[],usePaused:true,collectionPaused:true};
        }
        if (action.kind === 'configure') {
          assert.deepEqual(action.configuration.uses, []);
          assert.deepEqual(action.configuration.assistantIds, []);
          Object.assign(source, action.configuration, {currentState:'active'});
        }
        return {state:'recorded',kind:action.kind,outcome:'applied',currentness:'current'};
      case 'healthLoadSourceConsent':
        consent = {...input};
        return {state:'review',source:input,reviewId:'consent',statuses:['collection','transmission'].map(purpose =>
          ({purpose,consentState:grants.has(input.category + purpose) ? 'valid' : 'absent'}))};
      case 'healthRequestSourceConsent':
        consent.purpose = input.purpose;
        return {state:'review',reviewId:'reserved',approvalAvailable:true,request:{scope:consent}};
      case 'healthConfirmSourceConsent':
        assert.equal(pendingApproval, undefined, 'a pending approval must be checked before another write');
        grants.add(consent.category + consent.purpose);
        pendingApproval = {state:'recorded',decision:'approved',category:consent.category,purpose:consent.purpose};
        // The server acknowledges the write. The native bridge holds it until
        // reconciliation returns the original operation's final receipt.
        return {state:'held',reason:'original_result_unconfirmed'};
      case 'healthRecoverSourceConsent': {
        assert.ok(pendingApproval);
        const receipt = pendingApproval;
        pendingApproval = undefined;
        return receipt;
      }
      case 'healthPreparePhoneStorage':
        assert.ok(grants.has(input.category + 'transmission'));
        return {ready:true};
      case 'healthPrepareExistingSource':
        assert.equal(input.localSetup,'shareOnThisPhone');
        assert.equal(input.endpointId,context.endpointId);
        assert.equal(grants.size,10);
        prepared = true;
        return {state:'prepared'};
      case 'healthSetupChoice': return {setupOutcome:'prepared'};
      case 'healthRememberedChoice': sharing = true; return {persistence:'savedEnabled',updatesEnabled:true};
      case 'healthSavedRecoveryChoice':
        if (input.operation === 'stop') sharing = false;
        return {choices:[{choice:'mine',updatesEnabled:sharing}],persistence:sharing ? 'savedEnabled':'savedDisabled'};
      default: throw Error('Unexpected call ' + name);
    }
  }
  return {call,calls};
}
test('one switch opens Apple first, sets up a new phone and stops its saved updates', async () => {
  const {call,calls} = fixture();
  await enableHealthSharing(call,context,()=>{});
  assert.equal(calls[0],'healthChooseRecords');
  assert.equal(calls.filter(c=>c==='healthApplyRemoteSetup').length,3);
  assert.equal(calls.filter(c=>c==='healthConfirmSourceConsent').length,10);
  assert.equal(calls.filter(c=>c==='healthRecoverSourceConsent').length,10);
  assert.equal(calls.at(-1),'healthRememberedChoice');
  await stopHealthSharing(call);
  assert.equal((await call('healthSavedRecoveryChoice')).persistence,'savedDisabled');
  const offset=calls.length;
  await enableHealthSharing(call,context,()=>{});
  assert.ok(!calls.slice(offset).includes('healthApplyRemoteSetup'));
});
test('failed Apple prompt cannot start server setup', async () => {
  const calls=[];
  await assert.rejects(enableHealthSharing(async name=>{calls.push(name);return {completed:false}},context,()=>{}),/Apple Health/);
  assert.deepEqual(calls,['healthChooseRecords']);
});
test('failed server confirmation leaves sharing off', async () => {
  const {call,calls}=fixture();
  await assert.rejects(enableHealthSharing((name,input)=>name==='healthApplyRemoteSetup' ?
    {state:'recorded',kind:'enroll',outcome:'rejected'} : call(name,input),context,()=>{}),/did not confirm/);
  assert.ok(!calls.includes('healthRememberedChoice'));
});
test('an unconfirmed permission stops setup without repeating the approval', async () => {
  const {call,calls} = fixture();
  await assert.rejects(enableHealthSharing((name,input)=>name==='healthRecoverSourceConsent' ?
    {state:'held',reason:'transport_or_context'} : call(name,input),context,()=>{}),/permission/i);
  assert.equal(calls.filter(c=>c==='healthConfirmSourceConsent').length,1);
  assert.ok(!calls.includes('healthPreparePhoneStorage'));
  assert.ok(!calls.includes('healthRememberedChoice'));
});
test('retry checks an approval left pending by the previous build', async () => {
  const {call,calls} = fixture();
  let interrupted = false;
  await assert.rejects(enableHealthSharing(async (name,input) => {
    const result = await call(name,input);
    if (name === 'healthConfirmSourceConsent') { interrupted = true; throw Error('App closed'); }
    return result;
  },context,()=>{}), /App closed/);
  const offset = calls.length;
  await enableHealthSharing(async (name,input) => {
    if (interrupted && name === 'healthLoadSourceConsent') {
      interrupted = false;
      return {state:'held',reason:'original_pending'};
    }
    return call(name,input);
  },context,()=>{});
  assert.equal(calls.slice(offset).filter(name=>name==='healthConfirmSourceConsent').length,9);
  assert.equal(calls.filter(name=>name==='healthRecoverSourceConsent').length,10);
  assert.equal(calls.at(-1),'healthRememberedChoice');
});

test('the switch shares every selected category with the same Assistant and revokes access on stop', async () => {
  const fixtureState = fixture(), requests = [];
  const call = async (name,input) => {
    if (name === 'healthAssistantSharing') {
      requests.push(input);
      if (input.action === 'disable') return {enabled:false};
    }
    return fixtureState.call(name,input);
  };
  await enableHealthSharing(call,context,()=>{});
  assert.deepEqual(requests.filter(r=>r.action==='allowCategory').map(r=>r.category),
    ['SleepSegment','heartRate','restingHeartRate','respiratoryRate','hrvSDNN']);
  await disableAssistantSharing(call,context);
  assert.equal(requests.at(-1).action,'disable');
  assert.ok(requests.every(r=>r.assistantId===context.assistantId && r.enrollmentId==='id'));
});
test('a failed category grant cannot complete Assistant sharing', async () => {
  const {call} = fixture();
  let enabled = false;
  await assert.rejects(enableHealthSharing(async (name,input) => {
    if(name==='healthAssistantSharing' && input.category==='heartRate')return {approved:false};
    if(name==='healthAssistantSharing' && input.action==='enable')enabled=true;
    return call(name,input);
  },context,()=>{}), /Could not share/);
  assert.equal(enabled,false);
});

test('a new recipient revision is read before the phone saves its sync configuration', async () => {
  const {call} = fixture();let revision=1,preparedAt,releaseCount=0;
  await enableHealthSharing(async (name,input) => {
    if(name==='healthInventory'){
      const result=await call(name,input);
      return {sources:result.sources.map(s=>({...s,policyRevision:revision}))};
    }
    if(name==='healthAssistantSharing'&&input.action==='enable')revision=2;
    if(name==='healthReleaseSharingProfile')releaseCount++;
    if(name==='healthPrepareExistingSource')preparedAt=input.policyRevision;
    return call(name,input);
  },context,()=>{});
  assert.equal(releaseCount,1);
  assert.equal(preparedAt,2);
});
test('failed local setup withdraws a newly granted Assistant permission', async () => {
  const {call}=fixture();let withdrawn=false;
  await assert.rejects(enableHealthSharing(async(name,input)=>{
    if(name==='healthPrepareExistingSource')return {state:'unavailable'};
    if(name==='healthAssistantSharing'&&input.action==='disable'){withdrawn=true;return {enabled:false};}
    return call(name,input);
  },context,()=>{}),/prepare this phone/);
  assert.equal(withdrawn,true);
});
