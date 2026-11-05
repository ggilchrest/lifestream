// Controlled time + actual SQLite canonical permission review/approval/evaluation.
// Synthetic authenticated host context only: no HTTP/native/controller/model effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Database,CanonicalGrantRepository} from '@lifestream/storage-sqlite';
import {gameCampaignFixture} from '../../../packages/runtime/test/fixtures/game-campaign.ts';
const entry=process.env.CT_BINDING_ENTRY??'source';if(!['source','compiled'].includes(entry))throw Error('Closed test entry required');
const {createGameControllerAuthority}=await import(entry==='compiled'?'../dist/runtime/game-controller-authority.js':'../src/runtime/game-controller-authority.ts');
const {supervisedSessionBounds}=await import(entry==='compiled'?'../dist/runtime/supervised-game-session.js':'../src/runtime/supervised-game-session.ts');
const command=()=>({requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID()});
function fixture(t,maximumGrantMs){
 const database=new Database({path:':memory:'});database.migrate();t.after(()=>database.close());
 const scope=gameCampaignFixture().input.expectedScope;let allowed=true,startCheck;
 const context={principalId:scope.principalId,providerRef:'local-human',authenticationEvidenceRef:'urn:lifestream:synthetic-controller-host:'+scope.contextBinding.sessionId,now:()=>new Date().toISOString(),assertCurrent(binding){assert(allowed,'Synthetic host context withdrawn');assert.equal(binding.assistantId,scope.assistantId);assert.equal(binding.endpointId,scope.contextBinding.endpointId);assert.equal(binding.environmentId,scope.environmentId);assert.equal(binding.sessionId,scope.contextBinding.sessionId);}};
 const session={authorityOwner:()=>({database,context}),current:()=>allowed,setControllerStartCheck:value=>{startCheck=value;}};
 const configuration={scope,pinsDigest:'a'.repeat(64),bounds:structuredClone(supervisedSessionBounds),policyRevision:1,sessionProfile:'supervised8',...(maximumGrantMs===undefined?{}:{maximumGrantMs})};
 const authority=createGameControllerAuthority(configuration,session),repository=new CanonicalGrantRepository(database,'local-human');
 const pending=authority.review(),prepared=authority.inspectPreparation(pending.invocationId);
 const approval={requestId:pending.requestId,expectedRevision:pending.revision,confirmationDigest:pending.confirmationDigest,grantClass:'allowSession',expiresAt:pending.grantExpiresAt,reviewAfter:pending.reviewAfter};
 assert.throws(()=>repository.approveRequest({...approval,expiresAt:new Date(Date.parse(pending.grantExpiresAt)+1).toISOString()},command(),context),/conflict/,'Exact original review confirmation cannot approve a longer expiry');
 const result=repository.approveRequest(approval,command(),context);
 assert(result.grant);assert.equal(result.grant.grantClass,'allowSession');
 return {database,context,configuration,authority,repository,pending,prepared,grant:result.grant,startCheck:()=>startCheck(),withdraw:()=>{allowed=false;}};
}
test('declared300s grant survives controlled120s startup plus90s gameplay without widening effect bounds, then exact expiry denies',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-20T20:00:00.000Z')});
 const f=fixture(t,300000),legacy=createGameControllerAuthority({...f.configuration,maximumGrantMs:120000},{authorityOwner:()=>({database:f.database,context:f.context})});
 assert.equal(f.prepared.input.maximumGrantMs,300000);
 assert.notDeepEqual(f.authority.operation,legacy.operation,'Declared nondefault duration changes the canonical exact operation target');
 assert.equal(Date.parse(f.pending.grantExpiresAt)-Date.parse(f.grant.issuedAt),300000);assert.equal(f.grant.expiresAt,f.pending.grantExpiresAt);
 assert.deepEqual(f.prepared.input.bounds,supervisedSessionBounds);assert.equal(f.prepared.input.bounds.wallBudgetMs,90000);assert.equal(f.prepared.input.bounds.actionBudget,8);assert.equal(f.prepared.input.bounds.modelCallBudget,8);assert.equal(f.prepared.input.bounds.maxActionWallMs,500);assert.equal(f.prepared.input.bounds.maxActionFrames,12);assert.equal(f.prepared.input.controllerPolicy.allowedButtons.includes('start'),false);
 assert.equal(f.authority.canStart(),true);assert.equal(f.startCheck(),true);
 t.mock.timers.tick(120000);assert.equal(f.authority.canStart(),true,'Actual canonical evaluation after startup');
 t.mock.timers.tick(90000);assert.equal(f.authority.canStart(),true,'Actual canonical evaluation after startup plus full gameplay allowance');
 assert.equal(f.repository.inspectGrant(f.grant.grantId,f.context).expiresAt,f.grant.expiresAt,'No automatic grant renewal/restamp');
 t.mock.timers.tick(89999);assert.equal(f.authority.canStart(),true);
 t.mock.timers.tick(1);assert.equal(f.authority.canStart(),false,'Original issued expiry is authoritative');
 assert.equal(f.database.connection.prepare('SELECT count(*) AS n FROM canonical_grants').get().n,1);assert.equal(f.database.connection.prepare('SELECT count(*) AS n FROM canonical_dispatch_admissions').get().n,0);
});
test('real revocation and original context withdrawal deny the longer grant before its expiry',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-20T20:10:00.000Z')});
 const revoked=fixture(t,300000);t.mock.timers.tick(120000);assert.equal(revoked.authority.canStart(),true);
 revoked.repository.revokeGrant({grantId:revoked.grant.grantId,expectedRevision:revoked.grant.revision},command(),revoked.context);assert.equal(revoked.authority.canStart(),false);assert.equal(revoked.startCheck(),false);
 const withdrawn=fixture(t,300000);assert.equal(withdrawn.authority.canStart(),true);withdrawn.withdraw();assert.equal(withdrawn.authority.canStart(),false);
});
test('default120s permission still expires and review confirmation cannot silently widen duration',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-20T20:20:00.000Z')});
 const f=fixture(t);assert.equal(Object.hasOwn(f.prepared.input,'maximumGrantMs'),false);assert.equal(Date.parse(f.grant.expiresAt)-Date.parse(f.grant.issuedAt),120000);
 t.mock.timers.tick(120000);assert.equal(f.authority.canStart(),false);
 assert.throws(()=>createGameControllerAuthority({...f.configuration,maximumGrantMs:300001},{authorityOwner:()=>({database:f.database,context:f.context})}));
});
