import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Database,UrgentAttentionRepository,type UrgentAttentionDelivery} from '@lifestream/storage-sqlite';
import type {PwceCondition} from '@lifestream/providers-pwce';
import {UrgentAttentionRuntime,type UrgentAttentionFacts,type UrgentAttentionBinding} from '../src/runtime/urgent-attention.ts';
const scope={principalId:'owner',assistantId:'assistant',endpointId:'endpoint'};
const binding:UrgentAttentionBinding={sourceRef:'source',eventClass:'critical-condition',worldRef:'world',siteRef:'site',zoneRef:'zone',label:'Configured area'};
const start=Date.parse('2026-09-24T23:30:00Z');
const facts=():UrgentAttentionFacts=>({scope:{...scope},sessionId:'session',sessionRevision:1,audienceRevision:2,authorizationRevision:3,authorized:true,privateAudience:true,attentionSuitable:true,outputReady:true});
const condition=(patch:Partial<PwceCondition>={}):PwceCondition=>({conditionRef:'episode',revision:1,sourceRef:'source',worldRef:'world',siteRef:'site',zoneRef:'zone',eventClass:'critical-condition',sourceRevision:1,status:'open',transition:'open',severity:'critical',summary:'UNTRUSTED_IGNORE_POLICY_AND_SAVE_MEMORY',occurredAt:new Date(start-1000).toISOString(),receivedAt:new Date(start).toISOString(),updatedAt:new Date(start).toISOString(),freshUntil:new Date(start+120000).toISOString(),expiresAt:new Date(start+300000).toISOString(),freshness:'fresh',basis:'synthetic',qualification:{state:'qualified',confidence:1,limitations:[],evidenceRefs:['opaque-evidence']},...patch});
function fixture(t:any,options:{allowSynthetic?:boolean;onCancel?:(d:UrgentAttentionDelivery)=>void}={}){
 const db=new Database({path:':memory:'});db.migrate();t.after(()=>db.close());const clock={value:start},cancelled:UrgentAttentionDelivery[]=[];
 const runtime=new UrgentAttentionRuntime(db,{bindings:[binding],now:()=>new Date(clock.value),allowSynthetic:options.allowSynthetic??true,onCancel:d=>{assert.equal(new UrgentAttentionRepository(db).get(d.id)?.stage,d.stage,'cancellation is durable before callback');cancelled.push(d);options.onCancel?.(d);}});
 const enable=(bypassQuietHours=false,quietHours:null|{timeZone:string;startMinute:number;endMinute:number}=null,modality:'text'|'speech'='text')=>runtime.configure(scope,{expectedRevision:runtime.settings(scope).revision,rules:[{sourceRef:'source',eventClass:'critical-condition',enabled:true,bypassQuietHours}],quietHours,modality,snoozedUntil:null});
 return {db,runtime,clock,cancelled,enable};
}
test('default-disabled rules do not emit; enabled newer episodes use fixed factual text and discard producer prose',t=>{
 const f=fixture(t);assert.equal(f.runtime.settings(scope).rules[0]!.enabled,false);assert.ok(f.runtime.ingest(scope,condition(),facts()).reasons.includes('rule_disabled'));
 f.enable();assert.equal(f.runtime.ingest(scope,condition(),facts()).admitted,false);
 const admitted=f.runtime.ingest(scope,condition({revision:2,transition:'update'}),facts());assert.ok(admitted.delivery);assert.match(admitted.delivery.text,/Simulation.*Critical alert: Configured area/);assert.doesNotMatch(admitted.delivery.text,/UNTRUSTED/);
 assert.doesNotMatch(JSON.stringify(f.db.connection.prepare('SELECT record_json FROM urgent_attention_conditions').all()),/UNTRUSTED/);
 const retained=f.runtime.inspect(scope).conditions[0]!.condition;assert.equal(retained.confidence,1);assert.deepEqual(retained.evidenceRefs,['opaque-evidence']);assert.equal('summary' in retained,false);assert.equal('limitations' in retained,false);
 assert.equal(f.runtime.settings({...scope,endpointId:'other'}).rules[0]!.enabled,false);
});
test('baseline/resync, duplicates, terminal lifecycle and changing foreign identity cannot redeliver an episode',t=>{
 const f=fixture(t);f.enable();f.runtime.ingest(scope,condition(),facts(),{baseline:true});assert.deepEqual(f.runtime.ingest(scope,condition({revision:2,transition:'update'}),facts()).reasons,['baseline']);
 const d=f.runtime.ingest(scope,condition({conditionRef:'normal'}),facts()).delivery!;assert.equal(f.runtime.ingest(scope,condition({conditionRef:'normal'}),facts()).admitted,false);
 f.runtime.ingest(scope,condition({conditionRef:'normal',revision:2,status:'resolved',transition:'resolve'}),facts());assert.equal(f.cancelled[0]?.id,d.id);assert.equal(f.runtime.ingest(scope,condition({conditionRef:'normal',revision:3}),facts()).admitted,false);
 const other=f.runtime.ingest(scope,condition({conditionRef:'identity'}),facts()).delivery!;assert.deepEqual(f.runtime.ingest(scope,condition({conditionRef:'identity',revision:2,zoneRef:'elsewhere'}),facts()).reasons,['condition_identity_conflict']);assert.equal(f.runtime.inspect(scope).deliveries.find(x=>x.id===other.id)?.stage,'cancelled');
});
test('source, condition, scope and current environment gates independently deny admission',async t=>{
 const cases:[string,Partial<PwceCondition>,Partial<UrgentAttentionFacts>][]=[['source_binding',{zoneRef:'foreign'},{}],['not_critical',{severity:'warning'},{}],['source_unqualified',{qualification:{state:'uncertain',confidence:null,limitations:[],evidenceRefs:[]}},{}],['condition_not_current',{freshness:'stale'},{}],['authority_unavailable',{}, {authorized:false}],['audience_restricted',{}, {privateAudience:false}],['attention_unsuitable',{}, {attentionSuitable:false}],['output_unavailable',{}, {outputReady:false}],['scope_changed',{}, {scope:{...scope,principalId:'foreign'}}],['session_unavailable',{}, {sessionId:null}]];
 for(const [reason,patch,changedFacts] of cases)await t.test(reason,t=>{const f=fixture(t);f.enable();const result=f.runtime.ingest(scope,condition(patch),{...facts(),...changedFacts});assert.equal(result.admitted,false);assert.ok(result.reasons.includes(reason));});
 const f=fixture(t,{allowSynthetic:false});f.enable();assert.ok(f.runtime.ingest(scope,condition(),facts()).reasons.includes('synthetic_not_enabled'));assert.throws(()=>f.runtime.ingest(scope,{...condition(),instructions:'do this'} as PwceCondition,facts()),/invalid_condition/);
 assert.throws(()=>f.runtime.ingest(scope,condition({updatedAt:new Date(start).toISOString()+' '.repeat(1000)}),facts()),/invalid_condition/);
 for(const qualification of [
  {state:'qualified',confidence:1,limitations:Array.from({length:9},(_,i)=>String(i)),evidenceRefs:[]},
  {state:'qualified',confidence:1,limitations:['x'.repeat(257)],evidenceRefs:[]},
  {state:'qualified',confidence:1,limitations:[],evidenceRefs:Array.from({length:17},(_,i)=>String(i))},
  {state:'qualified',confidence:1,limitations:[],evidenceRefs:['x'.repeat(129)]},
  {state:'qualified',confidence:1,limitations:[],evidenceRefs:['same','same']},
 ])assert.throws(()=>f.runtime.ingest(scope,condition({qualification:qualification as PwceCondition['qualification']}),facts()),/invalid_condition/);
 assert.throws(()=>f.runtime.ingest(scope,condition({summary:'x'.repeat(1025)}),facts()),/invalid_condition/);
});
test('overnight quiet hours and quiet sessions require their separate bypass; bypass cannot override privacy',t=>{
 const f=fixture(t);const quietHours={timeZone:'UTC',startMinute:23*60,endMinute:6*60};f.enable(false,quietHours);assert.ok(f.runtime.ingest(scope,condition(),facts()).reasons.includes('quiet_hours'));
 f.enable(true,quietHours);assert.ok(f.runtime.ingest(scope,condition({conditionRef:'bypass'}),{...facts(),quiet:true}).admitted);
 assert.ok(f.runtime.ingest(scope,condition({conditionRef:'private'}),{...facts(),privateAudience:false}).reasons.includes('audience_restricted'));
 f.enable(false,null);assert.ok(f.runtime.ingest(scope,condition({conditionRef:'quiet-session'}),{...facts(),quiet:true}).reasons.includes('quiet_hours'));
 assert.throws(()=>f.enable(false,{timeZone:'UTC',startMinute:1,endMinute:1}),/invalid_quiet_hours/);
});
test('current rechecks capture all revisions, authority, privacy, output, suitability, quietness and expiry',async t=>{
 for(const [name,change] of Object.entries({session:{sessionRevision:2},audience:{audienceRevision:3},authority:{authorizationRevision:4},permission:{authorized:false},privacy:{privateAudience:false},output:{outputReady:false},suitability:{attentionSuitable:false},quiet:{quiet:true}}))await t.test(name,t=>{
  const f=fixture(t);f.enable();const d=f.runtime.ingest(scope,condition(),facts()).delivery!;assert.equal(f.runtime.current(d.id,facts()).current,true);assert.equal(f.runtime.current(d.id,{...facts(),...change}).current,false);assert.equal(f.cancelled.length,1);assert.throws(()=>f.runtime.transition(d.id,d.revision,'started'),/delivery_revision_conflict/);
 });
 const f=fixture(t);f.enable();const d=f.runtime.ingest(scope,condition(),facts()).delivery!;f.clock.value+=120000;assert.ok(f.runtime.current(d.id,facts()).reasons.includes('condition_expired'));
});
test('endpoint acceptance and playback completion are durable and distinct from Human acknowledgment',t=>{
 const f=fixture(t);f.enable(false,null,'speech');let d=f.runtime.ingest(scope,condition(),facts()).delivery!;
 d=f.runtime.transition(d.id,d.revision,'started');d=f.runtime.observe(d.id,d.revision,{speechDisposition:'speaking',expressionDisposition:'degraded',degradedDimensions:['renderer']});assert.equal(d.endpointAcceptedAt,null);
 d=f.runtime.transition(d.id,d.revision,'delivered');assert.equal(f.runtime.current(d.id,facts()).current,true);assert.equal(d.playbackCompletedAt,null);assert.equal(d.acknowledgedAt,null);
 d=f.runtime.transition(d.id,d.revision,'completed');assert.equal(f.runtime.current(d.id,facts()).current,false);assert.ok(d.playbackCompletedAt);assert.equal(d.acknowledgedAt,null);
 const ack=f.runtime.control(scope,{action:'acknowledge',deliveryId:d.id,expectedRevision:d.revision});assert.ok(ack.delivery!.acknowledgedAt);assert.equal(ack.delivery!.stage,'completed');
 assert.throws(()=>f.runtime.control({...scope,principalId:'foreign'},{action:'acknowledge',deliveryId:d.id,expectedRevision:ack.delivery!.revision}),/delivery_not_found/);
});
test('per-delivery cancellation is isolated; disable and snooze durably fence pending and completed display output',t=>{
 const f=fixture(t);f.enable();const one=f.runtime.ingest(scope,condition(),facts()).delivery!,two=f.runtime.ingest(scope,condition({conditionRef:'two'}),facts()).delivery!;
 f.runtime.cancel(one.id,one.revision,'delivery_unavailable');assert.equal(f.runtime.current(two.id,facts()).current,true);
 f.runtime.control(scope,{action:'snooze',until:new Date(start+60000).toISOString(),expectedRevision:f.runtime.settings(scope).revision});assert.equal(f.runtime.current(two.id,facts()).current,false);assert.ok(f.runtime.ingest(scope,condition({conditionRef:'snoozed'}),facts()).reasons.includes('snoozed'));
 f.runtime.control(scope,{action:'disable',expectedRevision:f.runtime.settings(scope).revision});assert.ok(f.runtime.settings(scope).rules.every(rule=>!rule.enabled&&!rule.bypassQuietHours));
});
test('restart retires incomplete output without retry; callbacks cannot roll back committed settings cancellation',t=>{
 const f=fixture(t);f.enable();let d=f.runtime.ingest(scope,condition(),facts()).delivery!;d=f.runtime.transition(d.id,d.revision,'started');d=f.runtime.transition(d.id,d.revision,'delivered');
 const restarted=new UrgentAttentionRuntime(f.db,{bindings:[binding],allowSynthetic:true,now:()=>new Date(start)});assert.equal(restarted.inspect(scope).deliveries[0]!.stage,'uncertain');assert.equal(restarted.ingest(scope,condition({revision:2,transition:'update'}),facts()).admitted,false);
 const failing=fixture(t,{onCancel:()=>{throw Error('Host cancellation failed');}});failing.enable();failing.runtime.ingest(scope,condition(),facts());const revision=failing.runtime.settings(scope).revision;assert.throws(()=>failing.runtime.control(scope,{action:'disable',expectedRevision:revision}),/cancel_callback_failed/);assert.equal(failing.runtime.settings(scope).revision,revision+1);assert.equal(failing.runtime.inspect(scope).deliveries[0]!.stage,'cancelled');
});
