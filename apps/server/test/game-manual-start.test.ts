import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Database,GameStartRepository} from '@lifestream/storage-sqlite';
import {selectManualGameStart,selectGameWindow} from '@lifestream/runtime/activity/policy';
import {claimManualGameStart,claimConfiguredGameStart} from '../src/runtime/game-activity.ts';
import {gameCampaignFixture} from '../../../packages/runtime/test/fixtures/game-campaign.ts';
import {scriptedGameBounds,scriptedGamePolicy} from '../../../packages/runtime/test/fixtures/game-policy.ts';
function fixture(){
 const now=Date.now(),input={scope:gameCampaignFixture().input.expectedScope,policy:scriptedGamePolicy(now),bounds:structuredClone(scriptedGameBounds)};
 input.policy.schedule={enabled:false,timeZone:null,windows:[],validatedPolicyRevision:null,validatedAt:null,policyCurrent:false,unavailableReason:'notConfigured'};
 const db=new Database({path:':memory:'});db.migrate();
 const repository=new GameStartRepository(db,{maxClaims:8,maxAssistantSlots:2,limitsFor:()=>({enabled:true,revision:1,rollingPeriodMs:86400000,rollingStartLimit:4,startsPerWindow:1}),quarantined:()=>false,admissionCurrent:()=>true,inspectionCurrent:()=>true,dispositionCurrent:()=>false});
 const view=selectManualGameStart({...input,nowMs:now,expiresAtMs:now+90000},{explicitStartCurrent:()=>true});return {input,db,repository,view,now};
}
test('server manual admission accepts only original scope/configuration selection; copied and foreign-run input never claims',async t=>{
 for(const mode of ['copy','wrongRun','changedBounds','extraScope','accessor'])await t.test(mode,()=>{
  const f=fixture();try{let input:any=f.input,view:any=f.view,reads=0;
   if(mode==='copy')view={...view};if(mode==='wrongRun')input={...input,scope:{...input.scope,runId:randomUUID()}};
   if(mode==='changedBounds')input={...input,bounds:{...input.bounds,wallBudgetMs:input.bounds.wallBudgetMs+1}};
   if(mode==='extraScope')input={...input,unexpectedAuthority:true};
   if(mode==='accessor'){input={...input};Object.defineProperty(input,'scope',{enumerable:true,get(){reads++;return f.input.scope;}});}
   assert.equal(claimManualGameStart(f.repository,input,view),false);assert.equal(reads,0);assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM game_start_claims').get()!.n,0);
   assert.equal(claimManualGameStart(f.repository,f.input,f.view),true);assert.equal(claimManualGameStart(f.repository,f.input,f.view),false);
  }finally{f.db.close();}
 });
});
test('manual selection cannot be used as configured calendar admission or enable unattended starts',t=>{
 const f=fixture();t.after(()=>f.db.close());
 assert.equal(claimConfiguredGameStart(f.repository,f.input,f.view as any),false);
 const window=selectGameWindow({...f.input,nowMs:f.now,purpose:'play'},{policyCurrent:()=>true});assert.equal(window.reason,'disabled');
 assert.equal(claimConfiguredGameStart(f.repository,f.input,window),false);assert.equal(claimManualGameStart(f.repository,f.input,window as any),false);
 assert.equal(claimManualGameStart(f.repository,f.input,f.view),true);assert.equal(f.input.policy.schedule.enabled,false);
});
