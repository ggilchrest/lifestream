import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {resolveInitiativePolicy,initiativePreset,initiativeSettingsError,type InitiativeFacts} from '../src/admin/initiative-policy.ts';
import {extensionSettings} from '../../../tests/fixtures/extension-settings.ts';

function sample(){
 const scope={assistantId:randomUUID(),userId:randomUUID(),relationshipId:randomUUID(),deploymentId:randomUUID()},endpointId=randomUUID(),now=Date.now();
 const profile={assistantId:scope.assistantId,profileId:randomUUID(),revision:1,status:'active',adaptivePersonaPolicy:{dimensions:[] as Record<string,unknown>[]}};
 const id=randomUUID(),configuration={...structuredClone(extensionSettings.initiative),...scope,schemaVersion:'1.0.0',recordType:'configuration',configurationId:id,revision:1,parentConfigurationRevision:`${id}:1`,lifecycle:'active',preset:'friendly',proactiveness:5,dimensions:initiativePreset(5),allowedContexts:['privateAvailable'],endpointIds:[endpointId],allowedModalities:['text','speech'],allowedKinds:['arrivalReturn','availableCheckIn','groundedFollowUp'],consentRefs:['approved-consent:synthetic'],tuning:{...extensionSettings.initiative.tuning,openingsPerHour:2,openingsPerDay:8,checkInIntervalSeconds:1800}};
 const facts:InitiativeFacts={sessionId:randomUUID(),endpointId,modality:'text',kind:'availableCheckIn',context:'privateAvailable',authorized:true,identityQualified:true,privateAudience:true,consentCurrent:true,sourceQualified:true,sourceExpiresAt:now+120000,outputReady:true,leaseAvailable:true};
 return {scope,configuration,profile,facts,now};
}

test('Initiative policy defaults quiet and keeps advanced dimensions independent of the basic value',()=>{
 const input=sample(),before=structuredClone(input);assert.equal(resolveInitiativePolicy(input).allowed,true);assert.deepEqual(input,before);
 const base=resolveInitiativePolicy({...input,configuration:undefined});assert.equal(base.allowed,false);assert.equal(base.dimensions.initiative,0);assert.ok(base.reasons.includes('defaultReactive'));assert.ok(base.sources.some(s=>s.sourceRef==='assistant-disposition:undeclared:initiative'));
 input.configuration.preset='custom';input.configuration.proactiveness=2;input.configuration.dimensions.curiosity=11;input.configuration.dimensions.persistence=0;
 const custom=resolveInitiativePolicy(input);assert.equal(custom.allowed,true);assert.equal(custom.dimensions.initiative,5);assert.equal(custom.dimensions.curiosity,11);assert.equal(custom.dimensions.persistence,0);
 input.configuration.dimensions.initiative=0;input.configuration.dimensions.warmth=11;input.configuration.tuning.openingsPerHour=0;input.configuration.tuning.openingsPerDay=0;
 const warm=resolveInitiativePolicy(input);assert.equal(warm.allowed,false);assert.ok(warm.reasons.includes('defaultReactive'));assert.equal(warm.expressionWarmth,1);
});

test('Initiative policy applies scoped temporary dimensions and restores settings without mutating consent or ceilings',()=>{
 const input=sample(),before=structuredClone(input.configuration),mode={kind:'companionship' as const,sessionId:input.facts.sessionId,configurationId:input.configuration.configurationId,createdAt:input.now,expiresAt:input.now+7200000,dimensions:initiativePreset(11)};
 const high=resolveInitiativePolicy({...input,temporary:mode});assert.equal(high.allowed,true);assert.equal(high.dimensions.initiative,11);assert.deepEqual(input.configuration,before);
 const expired=resolveInitiativePolicy({...input,now:mode.expiresAt!,temporary:mode});assert.equal(expired.dimensions.initiative,5);
 assert.ok(resolveInitiativePolicy({...input,temporary:{...mode,sessionId:randomUUID()}}).reasons.includes('invalidScope'));
 assert.ok(resolveInitiativePolicy({...input,temporary:{...mode,expiresAt:null}}).reasons.includes('invalidScope'));
 assert.ok(resolveInitiativePolicy({...input,temporary:{...mode,expiresAt:input.now+299999}}).reasons.includes('invalidScope'));
 assert.ok(resolveInitiativePolicy({...input,temporary:{...mode,expiresAt:input.now+28800001}}).reasons.includes('invalidScope'));
 assert.ok(resolveInitiativePolicy({...input,temporary:mode,facts:{...input.facts,consentCurrent:false}}).reasons.includes('consentRevoked'));
 assert.ok(resolveInitiativePolicy({...input,temporary:mode,facts:{...input.facts,endpointId:randomUUID()}}).reasons.includes('contextRestricted'));
 const quiet=resolveInitiativePolicy({...input,temporary:{...mode,kind:'quiet',expiresAt:null}});assert.equal(quiet.allowed,false);assert.ok(quiet.reasons.includes('quiet'));assert.equal(quiet.dimensions.initiative,5);
 assert.ok(resolveInitiativePolicy({...input,temporary:mode,facts:{...input.facts,context:'quiet'}}).reasons.includes('quiet'));
});

test('Initiative policy honors declared numeric bounds and maps existing warmth into one expression value',()=>{
 const input=sample();input.profile.adaptivePersonaPolicy.dimensions=[{key:'warmth',valueType:'number',baseline:.5,minimum:.2,maximum:.8},{key:'initiative',valueType:'number',baseline:2,minimum:0,maximum:6}];
 const policy=resolveInitiativePolicy(input);assert.equal(policy.allowed,true);assert.equal(policy.expressionWarmth,7/11);assert.ok(policy.sources.some(s=>s.dimension==='warmth'&&s.value===6&&s.sourceRef.includes(input.profile.profileId)));
 input.configuration.preset='custom';input.configuration.dimensions.warmth=10;assert.ok(resolveInitiativePolicy(input).reasons.includes('contextRestricted'));assert.ok(resolveInitiativePolicy(input).limitations.some(text=>text.includes('bounds 3–8')));
 input.configuration.dimensions.warmth=7;input.configuration.dimensions.initiative=11;assert.ok(resolveInitiativePolicy(input).reasons.includes('contextRestricted'));
 input.profile.adaptivePersonaPolicy.dimensions.push({key:'warmth',valueType:'number',baseline:.5,minimum:0,maximum:1});assert.ok(resolveInitiativePolicy(input).reasons.includes('invalidScope'));
 assert.ok(resolveInitiativePolicy({...sample(),profile:{...input.profile,assistantId:randomUUID()}}).reasons.includes('invalidScope'));
});

test('Initiative policy reports stable denial precedence and checks current source, audience and output facts',()=>{
 const input=sample();const denied=resolveInitiativePolicy({...input,facts:{...input.facts,authorized:false,consentCurrent:false,sourceQualified:false,context:'quiet',privateAudience:false,leaseAvailable:false,outputReady:false}});
 assert.deepEqual(denied.reasons,['invalidScope','consentRevoked','staleSource','quiet','privacyInsufficient','contextRestricted','leaseLost','endpointUnavailable']);
 for(const facts of [{...input.facts,identityQualified:false},{...input.facts,sourceExpiresAt:input.now},{...input.facts,context:'focused' as const},{...input.facts,context:'shared' as const},{...input.facts,outputReady:false},{...input.facts,leaseAvailable:false},{...input.facts,kind:'groundedFollowUp' as const},{...input.facts,kind:'arrivalReturn' as const,dwellSeconds:9,absenceSeconds:600},{...input.facts,kind:'arrivalReturn' as const,dwellSeconds:10,absenceSeconds:599}])assert.equal(resolveInitiativePolicy({...input,facts}).allowed,false);
 assert.equal(resolveInitiativePolicy({...input,facts:{...input.facts,kind:'arrivalReturn',dwellSeconds:10,absenceSeconds:600}}).allowed,true);
 assert.equal(resolveInitiativePolicy({...input,facts:{...input.facts,kind:'groundedFollowUp',unfinishedEvidenceCurrent:true}}).allowed,true);
 input.configuration.tuning.checkInIntervalSeconds=0;assert.ok(resolveInitiativePolicy(input).reasons.includes('contextRestricted'));
});

test('Initiative presets cannot mislabel independent values and preview never asserts runtime readiness',()=>{
 for(let level=0;level<=11;level++){const preset=level===0?'reactive':level<=3?'reserved':level<=6?'friendly':level<=9?'engaged':'highlyEngaged';assert.equal(initiativeSettingsError({preset,proactiveness:level,dimensions:initiativePreset(level)}),undefined);}
 assert.match(initiativeSettingsError({preset:'friendly',proactiveness:5,dimensions:{...initiativePreset(5),curiosity:9}})!,/Custom/);
 assert.equal(resolveInitiativePolicy({...sample(),preview:true}).allowed,false);
 const input=sample();input.configuration.lifecycle='draft';const preview=resolveInitiativePolicy({...input,facts:undefined,preview:true,previewConsentCurrent:true});assert.equal(preview.allowed,false);assert.ok(preview.reasons.includes('unavailable'));assert.equal(preview.reasons.includes('consentRevoked'),false);assert.equal(preview.dimensions.initiative,5);
 assert.ok(resolveInitiativePolicy(input).reasons.includes('configurationChanged'));assert.ok(resolveInitiativePolicy({...sample(),now:NaN}).reasons.includes('invalidScope'));
});
