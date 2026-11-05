import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {calendarPolicyOriginal,calendarPolicyEnvelope,calendarPolicyPin} from '../src/mobile-context-calendar-policy-owner.ts';
import {healthPolicyOriginal,healthPolicyPin} from '../src/mobile-context-policy-owner.ts';
test('Calendar decisions are explicit, separately pinned and cannot enter historical Health parser',()=>{
 const r={operationId:randomUUID(),command:'approveMapping',expectedRevision:0,scope:{kind:'classification',category:'CalendarEvent'},classification:'personal'};
 assert.ok(calendarPolicyOriginal(r));assert.equal(healthPolicyOriginal(r),null);
 assert.ok(calendarPolicyEnvelope({producerPin:calendarPolicyPin,operation:'preview',payload:r}));assert.equal(calendarPolicyEnvelope({producerPin:healthPolicyPin,operation:'preview',payload:r}),null);
 assert.equal(calendarPolicyOriginal({...r,scope:{kind:'classification',category:'SleepSegment'}}),null);
 assert.equal(calendarPolicyOriginal({...r,classification:undefined}),null);
});
test('Calendar retention cannot borrow Health categories, collectors or an implicit choice',()=>{
 const r={operationId:randomUUID(),command:'setRawRetention',expectedRevision:0,mappingRevision:1,scope:{kind:'rawRetention',category:'CalendarEvent',principalId:randomUUID(),sourceNamespace:randomUUID(),collector:'eventKit'},choice:{mode:'indefinite'}};
 assert.ok(calendarPolicyOriginal(r));assert.equal(healthPolicyOriginal(r),null);assert.equal(calendarPolicyOriginal({...r,choice:undefined}),null);assert.equal(calendarPolicyOriginal({...r,scope:{...r.scope,collector:'healthKit'}}),null);
 assert.equal(calendarPolicyOriginal({...r,choice:{mode:'finite',durationDays:2}}),null);
});
