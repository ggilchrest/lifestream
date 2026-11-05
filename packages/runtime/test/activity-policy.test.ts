import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {selectGameWindow,gameWindowCurrent,selectManualGameStart,manualGameStartCurrent,type GameWindowInput} from '../src/activity/policy.ts';
import {gameCampaignFixture} from './fixtures/game-campaign.ts';
import {scriptedGameBounds,scriptedGamePolicy} from './fixtures/game-policy.ts';
function fixture(at='2026-09-30T12:00:00Z'){
 const now=Date.parse(at),input:GameWindowInput={scope:gameCampaignFixture().input.expectedScope,policy:scriptedGamePolicy(now),bounds:structuredClone(scriptedGameBounds),purpose:'play',nowMs:now};let clock=now,current=true;
 const boundary={policyCurrent:()=>current,now:()=>clock};return {input,boundary,clock:(n:number)=>{clock=n;},deny:()=>{current=false;},permit:()=>{current=true;}};
}
test('explicit configured hours select an authentic bounded calendar occurrence without creating any start or authority',()=>{
 const f=fixture(),view=selectGameWindow(f.input,f.boundary);assert.equal(view.status,'inside');assert.equal(view.authority,false);assert.equal(view.localDate,'2026-09-30');assert.equal(view.windowId,f.input.policy.schedule.windows[0]!.windowId);assert.match(view.occurrenceKey!,/^[a-f0-9]{64}$/);assert.equal(gameWindowCurrent(view,f.input.scope),true);assert.ok(Object.isFrozen(view));assert.equal(gameWindowCurrent({...view},f.input.scope),false);assert.equal(gameWindowCurrent({...view,isCurrent:()=>true},f.input.scope),false);
});
test('no actual setup is invented for a disabled schedule or separately disabled contact channel',()=>{
 const f=fixture();f.input.policy.schedule={enabled:false,timeZone:null,windows:[],validatedPolicyRevision:null,validatedAt:null,policyCurrent:false,unavailableReason:'notConfigured'};assert.equal(selectGameWindow(f.input,f.boundary).reason,'disabled');f.input.purpose='contact';assert.equal(selectGameWindow(f.input,f.boundary).reason,'disabled');
});
test('selected product choices do not permit invalid or stale timezone/window/policy/finite-bound setup',async t=>{
 for(const mode of ['emptyWindows','noZone','invalidZone','offset','revision','futureValidation','notCurrent','missingBounds','infiniteBudget','fastForward','unknownPurpose'])await t.test(mode,()=>{
  const f=fixture(),raw:any=f.input,s=raw.policy.schedule;if(mode==='emptyWindows')s.windows=[];if(mode==='noZone')s.timeZone=null;if(mode==='invalidZone')s.timeZone='NoSuch/Zone';if(mode==='offset')s.timeZone='+03:00';if(mode==='revision')s.validatedPolicyRevision=2;if(mode==='futureValidation')s.validatedAt=new Date(raw.nowMs+1).toISOString();if(mode==='notCurrent')s.policyCurrent=false;if(mode==='missingBounds')delete raw.bounds;if(mode==='infiniteBudget')raw.bounds.modelCallBudget=Infinity;if(mode==='fastForward')raw.bounds.fastForwardEnabled=true;if(mode==='unknownPurpose')raw.purpose='autoPlay';assert.equal(selectGameWindow(raw,f.boundary).status,'unavailable');
 });
});
test('half-open local-day windows include start, exclude end and allow adjacency without an overnight shorthand',async t=>{
 for(const [at,status] of [['2026-09-30T08:59:59Z','outside'],['2026-09-30T09:00:00Z','inside'],['2026-09-30T09:59:59Z','inside'],['2026-09-30T10:00:00Z','outside']] as const)await t.test(at,()=>{const f=fixture(at),w=f.input.policy.schedule.windows[0]!;w.startMinute=540;w.endMinute=600;assert.equal(selectGameWindow(f.input,f.boundary).status,status);});
 const f=fixture();f.input.policy.schedule.windows[0]!.startMinute=1300;f.input.policy.schedule.windows[0]!.endMinute=100;assert.equal(selectGameWindow(f.input,f.boundary).reason,'invalidWindows');
 const a=fixture('2026-09-30T10:00:00Z'),w=a.input.policy.schedule.windows[0]!;w.startMinute=540;w.endMinute=600;a.input.policy.schedule.windows.push({...w,windowId:randomUUID(),startMinute:600,endMinute:660});assert.equal(selectGameWindow(a.input,a.boundary).windowId,a.input.policy.schedule.windows[1]!.windowId);
});
test('overlap, duplicate window IDs and equal endpoints are invalid while same-clock windows on different weekdays remain distinct',async t=>{
 for(const mode of ['overlap','duplicate','equal','differentDay'])await t.test(mode,()=>{const f=fixture(),w=f.input.policy.schedule.windows[0]!;w.daysOfWeek=['wednesday'];w.startMinute=540;w.endMinute=800;if(mode==='equal')w.endMinute=w.startMinute;else f.input.policy.schedule.windows.push({...w,windowId:mode==='duplicate'?w.windowId:randomUUID(),daysOfWeek:mode==='differentDay'?['thursday']:['wednesday'],startMinute:600,endMinute:700});const result=selectGameWindow(f.input,f.boundary);assert.equal(result.status,mode==='differentDay'?'inside':'unavailable');});
});
test('DST fall-back repeats one local occurrence across actual UTC instants and changed run/epoch IDs, while the next local date differs',()=>{
 const f=fixture('2026-11-01T05:30:00Z');f.input.policy.schedule.timeZone='America/New_York';f.input.policy.schedule.windows[0]!.startMinute=60;f.input.policy.schedule.windows[0]!.endMinute=120;
 const first=selectGameWindow(f.input,f.boundary);assert.equal(first.status,'inside');f.clock(Date.parse('2026-11-01T06:30:00Z'));const secondInput={...f.input,scope:{...f.input.scope,runId:randomUUID(),activityEpoch:3,timelineId:randomUUID()},nowMs:Date.parse('2026-11-01T06:30:00Z')},second=selectGameWindow(secondInput,f.boundary);assert.equal(second.status,'inside');assert.equal(second.occurrenceKey,first.occurrenceKey);assert.equal(first.isCurrent(),true);
 const thirdTime=Date.parse('2026-11-02T06:30:00Z');f.clock(thirdTime);const third=selectGameWindow({...secondInput,nowMs:thirdTime},f.boundary);assert.equal(third.status,'inside');assert.notEqual(third.occurrenceKey,first.occurrenceKey);assert.equal(first.isCurrent(),false);
});
test('DST spring-forward cannot manufacture an occurrence for a nonexistent local hour',()=>{
 const f=fixture('2026-03-08T06:59:00Z');f.input.policy.schedule.timeZone='America/New_York';f.input.policy.schedule.windows[0]!.startMinute=120;f.input.policy.schedule.windows[0]!.endMinute=180;assert.equal(selectGameWindow(f.input,f.boundary).status,'outside');const after=Date.parse('2026-03-08T07:00:00Z');f.clock(after);assert.equal(selectGameWindow({...f.input,nowMs:after},f.boundary).status,'outside');
});
test('explicit IANA timezone rather than the host workspace timezone selects the correct local date and weekday',()=>{
 const f=fixture('2026-09-30T15:30:00Z');f.input.policy.schedule.timeZone='Asia/Tokyo';f.input.policy.schedule.windows[0]!.daysOfWeek=['thursday'];f.input.policy.schedule.windows[0]!.startMinute=0;f.input.policy.schedule.windows[0]!.endMinute=60;const view=selectGameWindow(f.input,f.boundary);assert.equal(view.status,'inside');assert.equal(view.localDate,'2026-10-01');
});
test('policy withdrawal, clock rollback, end-of-window and later calendar changes retire held selections permanently',async t=>{
 for(const mode of ['policy','rollback','end'])await t.test(mode,()=>{const f=fixture(),view=selectGameWindow(f.input,f.boundary);if(mode==='policy')f.deny();if(mode==='rollback')f.clock(f.input.nowMs-1);if(mode==='end')f.clock(Date.parse('2026-10-01T00:00:00Z'));assert.equal(view.isCurrent(),false);f.permit();f.clock(f.input.nowMs);assert.equal(view.isCurrent(),false);});
});
test('a schema-valid policy cannot self-certify live current setup and source callbacks cannot mutate the supplied snapshot',()=>{
 const f=fixture();f.deny();assert.equal(selectGameWindow(f.input,f.boundary).reason,'policyUnavailable');f.permit();f.boundary.policyCurrent=(scope?:any,policy?:any,bounds?:any)=>{assert.ok(Object.isFrozen(scope)&&Object.isFrozen(policy.schedule.windows[0])&&Object.isFrozen(bounds));return true;};assert.equal(selectGameWindow(f.input,f.boundary).status,'inside');
});
test('calendar-source mutation in a later clock callback is rechecked before accepting a held window',()=>{
 const f=fixture();let calls=0;f.boundary.now=()=>{if(++calls===2)f.deny();return f.input.nowMs;};assert.equal(selectGameWindow(f.input,f.boundary).status,'unavailable');
});
test('changed live policy bytes retire an authentic held window even when the submitted revision was not increased',()=>{
 const f=fixture();f.boundary.policyCurrent=(_scope?:any,policy?:any,bounds?:any)=>isDeepStrictEqual(policy,f.input.policy)&&isDeepStrictEqual(bounds,f.input.bounds);const view=selectGameWindow(f.input,f.boundary);assert.equal(view.status,'inside');f.input.policy.schedule.windows[0]!.endMinute=800;assert.equal(view.isCurrent(),false);f.input.policy.schedule.windows[0]!.endMinute=1440;assert.equal(view.isCurrent(),false);
});
test('contact hours require exact separately configured channel/recipient policy and remain permission-free temporal metadata',()=>{
 const f=fixture();f.input.purpose='contact';f.input.policy.contactConfiguration={...f.input.policy.schedule,channelRef:'scripted-channel',recipientRef:'scripted-recipient'};const contact=selectGameWindow(f.input,f.boundary);assert.equal(contact.status,'inside');assert.equal(contact.authority,false);const play=selectGameWindow({...f.input,purpose:'play'},f.boundary);assert.notEqual(contact.occurrenceKey,play.occurrenceKey);f.input.policy.contactConfiguration.recipientRef=null;assert.equal(selectGameWindow(f.input,f.boundary).status,'unavailable');
});
test('foreign owner/relationship/environment/activity or hostile accessors cannot donate current-window eligibility',async t=>{
 for(const key of ['assistantId','principalId','relationshipId','environmentId','activityId'] as const)await t.test(key,()=>{const f=fixture(),view=selectGameWindow(f.input,f.boundary);assert.equal(gameWindowCurrent(view,{...f.input.scope,[key]:randomUUID()}),false);});
 const f=fixture();let reads=0;const raw:any={...f.input};Object.defineProperty(raw,'policy',{enumerable:true,get(){reads++;return f.input.policy;}});assert.equal(selectGameWindow(raw,f.boundary).reason,'invalidInput');assert.equal(reads,0);
});

function manualFixture(){
 const f=fixture(),{purpose:_purpose,...base}=f.input,input={...base,expiresAtMs:base.nowMs+90000};
 input.policy.schedule={enabled:false,timeZone:null,windows:[],validatedPolicyRevision:null,validatedAt:null,policyCurrent:false,unavailableReason:'notConfigured'};
 const boundary={explicitStartCurrent:()=>true,now:()=>input.nowMs};return {input,boundary};
}
test('explicit manual selection is finite, exact-run metadata and leaves disabled unattended schedule untouched',()=>{
 const f=manualFixture(),before=structuredClone(f.input.policy),view=selectManualGameStart(f.input,f.boundary);
 assert.equal(view.status,'selected');assert.equal(view.authority,false);assert.equal(view.expiresAtMs,f.input.expiresAtMs);assert.ok(Object.isFrozen(view));
 assert.equal(manualGameStartCurrent(view,f.input.scope,{policy:f.input.policy,bounds:f.input.bounds}),true);
 assert.deepEqual(f.input.policy,before);
 const {expiresAtMs:_expires,...calendar}=f.input;assert.equal(selectGameWindow({...calendar,purpose:'play'},{policyCurrent:()=>true}).reason,'disabled');
});
test('manual selection rejects clones, full-scope changes and extra configuration keys without invoking getters',()=>{
 const f=manualFixture(),view=selectManualGameStart(f.input,f.boundary),config={policy:f.input.policy,bounds:f.input.bounds};
 assert.equal(manualGameStartCurrent({...view},f.input.scope,config),false);
 for(const key of ['runId','activityId','campaignId','timelineId','environmentId','principalId','assistantId','relationshipId'] as const)assert.equal(manualGameStartCurrent(view,{...f.input.scope,[key]:randomUUID()},config),false,key);
 for(const key of ['activityEpoch','timelineRevision'] as const)assert.equal(manualGameStartCurrent(view,{...f.input.scope,[key]:f.input.scope[key]+1},config),false,key);
 assert.equal(manualGameStartCurrent(view,{...f.input.scope,contextBinding:{...f.input.scope.contextBinding,sessionId:randomUUID()}},config),false);
 assert.equal(manualGameStartCurrent(view,{...f.input.scope,runId:randomUUID()},{...config,scope:f.input.scope} as any),false);
 let reads=0;const hostile={...config};Object.defineProperty(hostile,'policy',{enumerable:true,get(){reads++;return f.input.policy;}});assert.equal(manualGameStartCurrent(view,f.input.scope,hostile),false);assert.equal(reads,0);
});
test('manual selection never survives expiry, rollback, consent withdrawal, callback mutation or reentrant eligibility',async t=>{
 for(const mode of ['expiry','rollback','consent','callback','clock','reentrant'])await t.test(mode,()=>{
  const f=manualFixture();let clock=f.input.nowMs,allowed=true,recursive=false;let view:ReturnType<typeof selectManualGameStart>;
  f.boundary.now=()=>clock;f.boundary.explicitStartCurrent=()=>{if(recursive)view.isCurrent();return allowed;};view=selectManualGameStart(f.input,f.boundary);assert.equal(view.status,'selected');
  if(mode==='expiry')clock=f.input.expiresAtMs;if(mode==='rollback')clock--;if(mode==='consent')allowed=false;if(mode==='callback')f.boundary.explicitStartCurrent=()=>true;if(mode==='clock')f.boundary.now=()=>clock;if(mode==='reentrant')recursive=true;
  assert.equal(view.isCurrent(),false);clock=f.input.nowMs;allowed=true;recursive=false;assert.equal(view.isCurrent(),false,'No renewal after first refusal');
 });
});
test('manual selection requires explicit current consent and a finite original deadline within bounds',async t=>{
 for(const mode of ['missingConsent','expired','tooLong','wallBudget','fractional','infinite','extra','accessor','changedPolicy'])await t.test(mode,()=>{
  const f=manualFixture();let reads=0;
  if(mode==='missingConsent')f.boundary.explicitStartCurrent=()=>false;
  if(mode==='expired')f.input.expiresAtMs=f.input.nowMs;
  if(mode==='tooLong')f.input.expiresAtMs=f.input.nowMs+120001;
  if(mode==='wallBudget')f.input.bounds.wallBudgetMs=100;
  if(mode==='fractional')f.input.expiresAtMs+=.5;
  if(mode==='infinite')f.input.expiresAtMs=Infinity;
  if(mode==='extra')(f.input as any).mode='backgroundP2';
  if(mode==='accessor')Object.defineProperty(f.input,'scope',{enumerable:true,get(){reads++;return {};}});
  if(mode==='changedPolicy'){const expected=structuredClone(f.input.policy);f.boundary.explicitStartCurrent=(_scope?:any,policy?:any)=>isDeepStrictEqual(policy,expected);const held=selectManualGameStart(f.input,f.boundary);expected.playWindowRef='changed';assert.equal(held.isCurrent(),false);return;}
  assert.equal(selectManualGameStart(f.input,f.boundary).status,'unavailable');assert.equal(reads,0);
 });
});
