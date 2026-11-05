import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarBasicBackendOptions} from '../src/runtime/calendar-basic-composition.ts';
const denied=()=>({allowed:()=>false,retention:()=>null,capturePolicy:()=>null,invalidate:()=>{}});
const profile=(createGovernance:any=denied)=>({maximumRecordsPerHuman:100,maximumControlOperationsPerHuman:20,createGovernance});
test('policy owner opt-in captures closed configuration without creating decisions or invoking accessors',()=>{
 const owner={finite:{allowedDurationDays:[2],allowedAnchors:['firstAuthoritativeImport' as const]}},o=calendarBasicBackendOptions({...profile(),policyOwner:owner})!;
 assert.equal(o.schemaPlan,'calendar-policy/1');owner.finite.allowedDurationDays.push(90);assert.deepEqual(o.calendarPolicyOwner?.finite?.allowedDurationDays,[2]);
 let reads=0;assert.throws(()=>calendarBasicBackendOptions({...profile(),policyOwner:{get finite(){reads++;return {};}}} as any));assert.equal(reads,0);
 assert.throws(()=>calendarBasicBackendOptions({...profile(),policyOwner:{approved:true}} as any));assert.throws(()=>calendarBasicBackendOptions({...profile(),policyOwner:new Proxy({},{})} as any));
});
test('Calendar-only opt-in requires the actual original factory and does not seed a Health policy owner',()=>{
 assert.equal(calendarBasicBackendOptions(undefined),undefined);
 assert.equal(calendarBasicBackendOptions({...profile(),createGovernance:undefined}),undefined);
 const o=calendarBasicBackendOptions(profile())!;
 assert.equal(o.schemaPlan,'calendar-basic/1');assert.equal(o.sourceSafetyInitialization,'requireExisting');assert.equal(o.createGovernance,undefined);assert.equal(o.policyOwner,undefined);assert.equal(o.conversation,undefined);assert.equal(o.calendarConversation,undefined);
 assert.ok(Object.isFrozen(o));
});
test('closed profile rejects accessor, proxy, invented authority and invalid bounds without invoking getters',()=>{
 let reads=0;const value={...profile(),get maximumRecordsPerHuman(){reads++;return 100;}};
 assert.throws(()=>calendarBasicBackendOptions(value));assert.equal(reads,0);
 assert.throws(()=>calendarBasicBackendOptions(new Proxy(profile(),{})));
 assert.throws(()=>calendarBasicBackendOptions({...profile(),approved:true} as any));
 for(const n of [0,-1,100001,NaN,1.5,true])assert.throws(()=>calendarBasicBackendOptions({...profile(),maximumControlOperationsPerHuman:n} as any));
});
test('missing or exceptional original owner never becomes a synthetic grant',()=>{
 for(const factory of [()=>null,()=>({allowed:()=>true}),()=>{throw Error('synthetic unavailable');}])assert.equal(calendarBasicBackendOptions(profile(factory))!.createCalendarGovernance!({} as any,{} as any),null);
});
test('observed original method replacement permanently revokes the captured authority',()=>{
 const allowed=()=>true,owner={...denied(),allowed},o=calendarBasicBackendOptions(profile(()=>owner))!,p=o.createCalendarGovernance!({} as any,{} as any)!;
 assert.equal(p.allowed({} as any,{} as any,'collect'),true);
 owner.allowed=()=>false;assert.equal(p.allowed({} as any,{} as any,'collect'),false);
 owner.allowed=allowed;assert.equal(p.allowed({} as any,{} as any,'collect'),false);
 assert.equal(p.capturePolicy!({} as any,{} as any),null);assert.throws(()=>p.invalidate({} as any,'e','settingsChanged'));
});
test('factory capture ignores later profile replacement; callback-time owner mutation denies its result',()=>{
 const owner={...denied(),allowed:()=>{owner.retention=()=>({policyRef:'invented',expiresAt:null});return true;}},p=profile(()=>owner),o=calendarBasicBackendOptions(p)!;
 p.createGovernance=()=>{throw Error('replacement must not run');};
 assert.equal(o.createCalendarGovernance!({} as any,{} as any)!.allowed({} as any,{} as any,'collect'),false);
});

test('production availability has closed explicit trusted bindings/bounds and no grant provider; undefined remains off',async()=>{
 const {calendarProductionBackendOptions:compose}=await import('../src/runtime/calendar-production-composition.ts');assert.equal(compose(undefined),undefined);const profile={environmentId:'synthetic-environment',destinationId:'synthetic-server',maximumRecordsPerHuman:100,maximumControlOperationsPerHuman:20};const p=compose(profile)!;assert.equal(p.schemaPlan,'calendar-consent/1');assert.equal(p.sourceSafetyInitialization,'requireExisting');assert.equal(p.createCalendarGovernance,undefined);assert.equal(p.createGovernance,undefined);assert.equal(p.calendarPolicyOwner,undefined);assert.deepEqual(p.calendarProduction,{environmentId:profile.environmentId,destinationId:profile.destinationId});
 for(const bad of [{...profile,allowed:true},{...profile,createGovernance:()=>({allowed:()=>true})},{...profile,sourceSafetyInitialization:'initializeEmpty'},{...profile,destinationId:''},{...profile,maximumRecordsPerHuman:0},new Proxy(profile,{})])assert.throws(()=>compose(bad as any));let reads=0;assert.throws(()=>compose({...profile,get finite(){reads++;return {};}} as any));assert.equal(reads,0);
});
