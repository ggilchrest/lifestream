import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '../src/database.ts';
import {GameStartRepository,type GameStartOptions} from '../src/game-starts.ts';
import {gameCampaignFixture} from '../../runtime/test/fixtures/game-campaign.ts';
import {scriptedGameBounds,scriptedGamePolicy} from '../../runtime/test/fixtures/game-policy.ts';
function fixture(path=':memory:'){
 let now=Date.parse('2026-10-20T12:00:00Z'),current=true,terminal=false;
 const scope=gameCampaignFixture().input.expectedScope,policy=scriptedGamePolicy(now),bounds=structuredClone(scriptedGameBounds);
 const input={scope,policy,bounds,expiresAtMs:now+90000};
 policy.schedule={enabled:false,timeZone:null,windows:[],validatedPolicyRevision:null,validatedAt:null,policyCurrent:false,unavailableReason:'notConfigured'};
 const limits={enabled:false,revision:1,rollingPeriodMs:86400000,rollingStartLimit:4,startsPerWindow:1};
 const options:GameStartOptions={maxClaims:8,maxAssistantSlots:2,limitsFor:()=>limits,quarantined:()=>false,admissionCurrent:()=>current,inspectionCurrent:()=>true,dispositionCurrent:()=>terminal,now:()=>now};
 let db=new Database({path});db.migrate();let starts=new GameStartRepository(db,options);
 return {input,limits,options,get db(){return db;},get starts(){return starts;},get now(){return now;},clock:(value:number)=>{now=value;},withdraw:()=>{current=false;},terminal:()=>{terminal=true;},reopen(){db.close();db=new Database({path});db.migrate();starts=new GameStartRepository(db,options);}};
}
const next=(f:ReturnType<typeof fixture>)=>({...f.input,scope:{...f.input.scope,runId:randomUUID(),activityEpoch:f.input.scope.activityEpoch+1,timelineId:randomUUID()},expiresAtMs:f.now+90000});
const finish=(f:ReturnType<typeof fixture>)=>{f.terminal();assert.equal(f.starts.noteDisposition(f.input.scope,'stopped',1,'fixture:exact-old-native-termination'),true);};
const counts=(f:ReturnType<typeof fixture>)=>[f.db.connection.prepare('SELECT count(*) AS n FROM game_start_claims').get()!.n,f.db.connection.prepare('SELECT count(*) AS n FROM game_controller_slots').get()!.n];
test('explicit finite manual start retains disabled automatic limits and calendar while consuming the shared ledger once',t=>{
 const f=fixture();t.after(()=>f.db.close());f.limits.enabled=false;const before=structuredClone({policy:f.input.policy,limits:f.limits});
 assert.equal(f.starts.claimManual(f.input,()=>true),true);assert.deepEqual(counts(f),[1,1]);
 assert.deepEqual({policy:f.input.policy,limits:f.limits},before);assert.equal(f.starts.claimManual(f.input,()=>true),false);
 finish(f);assert.deepEqual(counts(f),[1,0]);assert.equal(f.starts.claimManual(f.input,()=>true),false);
});
test('manual claim persists once in existing SQLite ledger and slot while unattended stays disabled',t=>{
 const f=fixture();t.after(()=>f.db.close());const before=structuredClone(f.input.policy);
 assert.equal(f.starts.claimManual(f.input,()=>true),true);assert.deepEqual(counts(f),[1,1]);assert.equal(f.starts.claimManual(f.input,()=>true),false);
 assert.deepEqual(f.input.policy,before);const row=f.db.connection.prepare('SELECT * FROM game_start_claims').get()!;
 assert.equal(row.run_id,f.input.scope.runId);assert.equal(Object.hasOwn(row,'scope_json'),false);assert.equal(f.starts.inspect(f.input.scope)!.continuationAuthority,false);
 finish(f);assert.deepEqual(counts(f),[1,0]);assert.equal(f.starts.claimManual(f.input,()=>true),false,'Terminal evidence never unconsumes the original run');
});
test('manual claims and unknown ownership survive reopen and block successor manual and calendar starts',t=>{
 const root=mkdtempSync(join(tmpdir(),'manual-start-')),f=fixture(join(root,'metadata.sqlite'));t.after(()=>{f.db.close();rmSync(root,{recursive:true,force:true});});
 assert.equal(f.starts.claimManual(f.input,()=>true),true);f.reopen();assert.equal(f.starts.claimManual(next(f),()=>true),false);
 const scheduled=calendar(next(f),f.now);f.limits.enabled=true;assert.equal(f.starts.claim(scheduled,()=>true),false);assert.deepEqual(counts(f),[1,1]);
 f.limits.enabled=false;
 f.terminal();assert.equal(f.starts.noteDisposition(f.input.scope,'paused',1,'fixture:paused'),true);f.reopen();assert.equal(f.starts.claimManual(next(f),()=>true),false);assert.deepEqual(counts(f),[1,1]);
});
function calendar(input:ReturnType<typeof fixture>['input'],now:number){
 const policy=scriptedGamePolicy(now),localDate=new Date(now).toISOString().slice(0,10),windowId=policy.schedule.windows[0]!.windowId,s=input.scope;
 const occurrenceKey=createHash('sha256').update(JSON.stringify([s.assistantId,s.principalId,s.relationshipId,s.environmentId,s.activityId,'play',policy.revision,policy.schedule.timeZone,localDate,windowId])).digest('hex');
 return {scope:s,policy,bounds:input.bounds,localDate,windowId,occurrenceKey};
}
test('manual and calendar starts share global rolling budget in either direction',async t=>{
 for(const first of ['manual','calendar'])await t.test(first,()=>{
  const f=fixture();try{f.limits.rollingStartLimit=1;f.limits.enabled=first==='calendar';
   assert.equal(first==='manual'?f.starts.claimManual(f.input,()=>true):f.starts.claim(calendar(f.input,f.now),()=>true),true);finish(f);
   f.limits.enabled=first==='manual';
   const successor=next(f);assert.equal(first==='manual'?f.starts.claim(calendar(successor,f.now),()=>true):f.starts.claimManual(successor,()=>true),false);
   assert.deepEqual(counts(f),[1,0]);f.clock(f.now+f.limits.rollingPeriodMs);const eligible=next(f);assert.equal(first==='manual'?f.starts.claim(calendar(eligible,f.now),()=>true):f.starts.claimManual(eligible,()=>true),true);
  }finally{f.db.close();}
 });
});
test('final manual expiry, consent withdrawal and changed limits atomically roll back claim plus slot',async t=>{
 for(const mode of ['expiry','consent','limits','enrollment'])await t.test(mode,()=>{
  const f=fixture();try{let checks=0;f.options.admissionCurrent=()=>{if(++checks===3){if(mode==='expiry')f.clock(f.input.expiresAtMs);if(mode==='consent')return false;if(mode==='limits')f.limits.rollingStartLimit++;}return true;};
   if(mode==='enrollment')f.options.admissionCurrent=()=>{if(++checks===3)f.limits.enabled=true;return true;};
   assert.throws(()=>f.starts.claimManual(f.input,()=>true),/unavailable/);assert.deepEqual(counts(f),[0,0]);
  }finally{f.db.close();}
 });
});
test('manual starts reject missing currentness, expiry, rollback, nonfinite policy and unbounded lifetime',async t=>{
 for(const mode of ['denied','expired','tooLong','fractional','missingLimits','nonBooleanEnabled','wrongRevision','zeroRollingLimit','zeroWindowLimit','rollback','accessor','extra'])await t.test(mode,()=>{
  const f=fixture();try{let reads=0;
   if(mode==='expired')f.input.expiresAtMs=f.now;
   if(mode==='tooLong')f.input.expiresAtMs=f.now+120001;
   if(mode==='fractional')f.input.expiresAtMs+=.5;
   if(mode==='missingLimits')f.options.limitsFor=()=>null;
   if(mode==='nonBooleanEnabled')(f.limits as any).enabled='false';
   if(mode==='wrongRevision')f.limits.revision++;
   if(mode==='zeroRollingLimit')f.limits.rollingStartLimit=0;
   if(mode==='zeroWindowLimit')f.limits.startsPerWindow=0;
   if(mode==='rollback'){f.starts.inspect(f.input.scope);f.clock(f.now-1);}
   if(mode==='accessor')Object.defineProperty(f.input,'policy',{enumerable:true,get(){reads++;return {};}});
   if(mode==='extra')(f.input as any).automatic=true;
   const invoke=()=>f.starts.claimManual(f.input,()=>mode!=='denied');
   if(['fractional','missingLimits','nonBooleanEnabled','wrongRevision','zeroRollingLimit','zeroWindowLimit','rollback','accessor','extra'].includes(mode))assert.throws(invoke,/unavailable/);else assert.equal(invoke(),false);
   assert.equal(reads,0);assert.deepEqual(counts(f),[0,0]);
  }finally{f.db.close();}
 });
});
test('disabled automatic limits still reject valid calendar claims and do not authorize a withdrawn manual start',t=>{
 const f=fixture();t.after(()=>f.db.close());
 assert.throws(()=>f.starts.claim(calendar(f.input,f.now),()=>true),/unavailable/);assert.deepEqual(counts(f),[0,0]);
 assert.throws(()=>f.starts.claim({...calendar(f.input,f.now),expiresAtMs:f.input.expiresAtMs} as any,()=>true),/unavailable/);
 assert.equal(f.starts.claimManual(f.input,()=>false),false);assert.deepEqual(counts(f),[0,0]);
 f.withdraw();assert.equal(f.starts.claimManual(f.input,()=>true),false);assert.deepEqual(counts(f),[0,0]);
});
test('inherited manual expiry cannot admit a calendar claim when automatic starts are disabled',t=>{
 const f=fixture();t.after(()=>f.db.close());const input=calendar(f.input,f.now);
 assert.equal(Object.hasOwn(Object.prototype,'expiresAtMs'),false);
 try{
  Object.defineProperty(Object.prototype,'expiresAtMs',{value:f.input.expiresAtMs,configurable:true});
  assert.equal(Object.hasOwn(input,'expiresAtMs'),false);assert.equal('expiresAtMs' in input,true);
  assert.throws(()=>f.starts.claim(input,()=>true),/unavailable/);assert.deepEqual(counts(f),[0,0]);
 }finally{Reflect.deleteProperty(Object.prototype,'expiresAtMs');}
});
