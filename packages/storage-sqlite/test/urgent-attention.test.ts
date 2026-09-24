import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '../src/database.ts';
import {UrgentAttentionRepository,type UrgentAttentionCondition,type UrgentAttentionScope,type UrgentAttentionConfiguration} from '../src/urgent-attention.ts';
const scope:UrgentAttentionScope={principalId:'owner',assistantId:'assistant',endpointId:'endpoint'};
const now='2026-09-24T12:00:00.000Z';
const configuration:UrgentAttentionConfiguration={rules:[{sourceRef:'source',eventClass:'critical-condition',enabled:true,bypassQuietHours:false}],modality:'text',quietHours:null,snoozedUntil:null};
const condition=(patch:Partial<UrgentAttentionCondition>={}):UrgentAttentionCondition=>({conditionRef:'episode',revision:1,sourceRef:'source',worldRef:'world',siteRef:'site',zoneRef:'zone',eventClass:'critical-condition',sourceRevision:1,status:'open',severity:'critical',freshness:'fresh',basis:'synthetic',qualification:'qualified',confidence:1,evidenceRefs:['synthetic-incident'],freshUntil:'2026-09-24T12:02:00.000Z',expiresAt:'2026-09-24T12:03:00.000Z',updatedAt:now,...patch});
const input={modality:'text' as const,text:'Synthetic factual warning.',expiresAt:'2026-09-24T12:02:00.000Z',settingsRevision:1,sessionId:'session',sessionRevision:1,audienceRevision:2,authorizationRevision:3};
function fixture(t:any){const database=new Database({path:':memory:'});database.migrate();t.after(()=>database.close());return new UrgentAttentionRepository(database);}
test('settings start disabled, compare-and-swap is durable, and scopes do not share policy',t=>{
 const repo=fixture(t);assert.equal(repo.settings(scope).revision,0);assert.deepEqual(repo.settings(scope).rules,[]);
 assert.equal(repo.configure(scope,0,configuration,now).settings.revision,1);assert.throws(()=>repo.configure(scope,0,configuration,now),/settings_revision_conflict/);
 assert.equal(repo.settings({...scope,endpointId:'other'}).revision,0);
 assert.throws(()=>repo.configure(scope,1,{...configuration,rules:[...configuration.rules,...configuration.rules]},now),/duplicate_rule/);
 assert.throws(()=>repo.configure(scope,1,{...configuration,quietHours:{timeZone:'UTC',startMinute:0,endMinute:0}},now),/invalid_quiet_hours/);
 assert.throws(()=>repo.configure(scope,1,{...configuration,quietHours:{timeZone:'NoSuch/Zone',startMinute:0,endMinute:1}},now),/invalid_quiet_hours/);
});
test('episode uniqueness, monotonic conditions, baseline suppression and transaction rollback preserve dedup',t=>{
 const repo=fixture(t);repo.configure(scope,0,configuration,now);
 const first=repo.observeCondition(scope,condition(),false,now,()=>({reasons:[],delivery:input}));assert.equal(first.admitted,true);
 assert.equal(repo.observeCondition(scope,condition(),false,now,()=>{throw Error('Duplicate cannot be considered');}).admitted,false);
 assert.equal(repo.observeCondition(scope,condition({revision:2}),false,now,()=>{throw Error('Lifetime duplicate cannot be considered');}).admitted,false);
 assert.equal(repo.get(first.delivery!.id)?.stage,'cancelled');
 repo.observeCondition(scope,condition({conditionRef:'baseline'}),true,now,()=>{throw Error('Baseline cannot be considered');});
 assert.deepEqual(repo.observeCondition(scope,condition({conditionRef:'baseline',revision:2}),false,now,()=>({reasons:[],delivery:input})).reasons,['baseline']);
 assert.throws(()=>repo.observeCondition(scope,condition({conditionRef:'rollback'}),false,now,()=>{throw Error('Decision failed');}),/Decision failed/);assert.equal(repo.condition(scope,'rollback'),undefined);
});
test('delivery lifecycle records output observations separately from Human acknowledgment and fences old tokens',t=>{
 const repo=fixture(t);repo.configure(scope,0,configuration,now);let d=repo.observeCondition(scope,condition(),false,now,()=>({reasons:[],delivery:{...input,modality:'speech'}})).delivery!;
 assert.throws(()=>repo.transition(d.id,d.revision,'completed',now),/invalid_delivery_transition/);
 d=repo.transition(d.id,d.revision,'started',now);d=repo.observe(d.id,d.revision,{speechDisposition:'speaking',expressionDisposition:'degraded',degradedDimensions:['renderer']},now);
 d=repo.transition(d.id,d.revision,'delivered',now);assert.equal(d.endpointAcceptedAt,now);assert.equal(d.playbackCompletedAt,null);assert.equal(d.acknowledgedAt,null);
 d=repo.transition(d.id,d.revision,'completed',now);assert.equal(d.playbackCompletedAt,now);assert.equal(d.acknowledgedAt,null);
 assert.throws(()=>repo.observe(d.id,d.revision,{speechDisposition:'unavailable',expressionDisposition:'degraded'},now),/invalid_delivery_observation/);
 const old=d.revision;d=repo.acknowledge(scope,d.id,d.revision,now);assert.equal(d.acknowledgedAt,now);assert.throws(()=>repo.transition(d.id,old,'cancelled',now),/delivery_revision_conflict/);
 d=repo.cancelDelivery(d.id,d.revision,'audience_changed',now);assert.equal(d.stage,'cancelled');assert.equal(d.endpointAcceptedAt,now);assert.equal(d.playbackCompletedAt,now);
 assert.throws(()=>repo.observe(d.id,d.revision,{speechDisposition:'speaking'},now),/invalid_delivery_observation/);
 assert.throws(()=>repo.observe(d.id,d.revision,{expressionDisposition:'observed',degradedDimensions:[]},now),/invalid_delivery_observation/);assert.equal(repo.get(d.id)?.speechDisposition,'completed');
});
test('restart and isolated restore preserve tombstones while quarantining permissions and pending output',t=>{
 const directory=mkdtempSync(join(tmpdir(),'urgent-storage-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));let db=new Database({path:join(directory,'state.sqlite')});db.migrate();let repo=new UrgentAttentionRepository(db);repo.configure(scope,0,configuration,now);
 const d=repo.observeCondition(scope,condition(),false,now,()=>({reasons:[],delivery:input})).delivery!;db.close();db=new Database({path:join(directory,'state.sqlite')});t.after(()=>db.close());db.migrate();repo=new UrgentAttentionRepository(db);
 assert.equal(repo.recover(now)[0]?.stage,'uncertain');assert.deepEqual(repo.recover(now),[]);assert.equal(repo.get(d.id)?.reason,'consumer_restarted');
 const second=repo.observeCondition(scope,condition({conditionRef:'second'}),false,now,()=>({reasons:[],delivery:input})).delivery!;
 assert.deepEqual(repo.quarantine(now),{scopes:1,cancelledDeliveries:1});assert.equal(repo.get(second.id)?.stage,'cancelled');assert.ok(repo.settings(scope).rules.every(rule=>!rule.enabled&&!rule.bypassQuietHours));
 assert.deepEqual(repo.observeCondition(scope,condition({revision:3}),false,now,()=>({reasons:[],delivery:input})).reasons,['baseline']);
});
test('inspection is bounded but old episode tombstones still deny repeats',t=>{
 const repo=fixture(t);for(let i=0;i<105;i++)repo.observeCondition(scope,condition({conditionRef:'episode-'+i}),true,now,()=>({reasons:[]}));
 assert.equal(repo.inspect(scope).conditions.length,100);assert.equal(repo.database.connection.prepare('SELECT count(*) AS n FROM urgent_attention_conditions').get()!.n,105);
 assert.equal(repo.observeCondition(scope,condition({conditionRef:'episode-0',revision:2}),false,now,()=>({reasons:[],delivery:input})).admitted,false);
});
