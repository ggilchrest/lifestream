import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileFunction} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {randomUUID} from 'node:crypto';
import {createSelectedCtJobLifecycle,isSelectedCtJobLifecycle} from '../../../integration/ct-launcher/ct-job-lifecycle-owner.mjs';
const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
const reportLine=source.split('\n').find(v=>v.includes('private reportDedicatedCtDiagnostic('));assert(reportLine);
const report=compileFunction('return '+stripTypeScriptTypes('({'+reportLine.replace('private ','')+'})',{mode:'strip'})+'.reportDedicatedCtDiagnostic;')();
function actorFixture(){
 const scope={assistantId:randomUUID(),principalId:randomUUID(),relationshipId:randomUUID(),environmentId:randomUUID(),runId:randomUUID(),contextBinding:{sessionId:randomUUID(),conversationId:randomUUID(),endpointId:randomUUID()}},events=[];let auth=true,effective=true,audience=true,permission=true,session=true,conversation=true,relationship=true,boundary=1,queries=0,currentCalls=0;
 const local={principalId:scope.principalId,sessionId:scope.contextBinding.sessionId,origin:'http://127.0.0.1:32123'};
 const owner={localAuth:{assertCurrent(){currentCalls++;if(!auth)throw Error('Private auth refusal');},effectiveUser:()=>effective?scope.principalId:'other-user'},host:'127.0.0.1',localOrigin:local.origin,state:'ready',restoreQuarantine:false,profileSwitching:false,sessionEnvironmentId:scope.environmentId,ubuntuGameBackend:{},personalContextAllowed:()=>true,audiencePermits:()=>audience,dedicatedCtActorDiagnosticActive:true,dedicatedCtDiagnostic:value=>events.push(value),reportDedicatedCtDiagnostic:report,activeGameRuntimes:new Map(),providers:{inference:{},providers:{inference:{status:'healthy',fixture:false}}},admin:{conversationRelationshipId:()=>scope.relationshipId,contextBoundary:()=>({revision:boundary})},gameRuntimeOptions:{inferenceMode:'supervisedForeground'},database:{connection:{prepare(sql){queries++;if(sql.startsWith('SELECT 1 FROM local_assistant_permissions'))return {get:()=>permission?{}:undefined};if(sql.startsWith('SELECT conversation_id,endpoint_id,revision FROM sessions'))return {get:()=>session?{conversation_id:scope.contextBinding.conversationId,endpoint_id:scope.contextBinding.endpointId,revision:1}:undefined};if(sql.startsWith('SELECT assistant_id,effective_user_id FROM conversation_catalog'))return {get:()=>({assistant_id:conversation?scope.assistantId:'other-assistant',effective_user_id:scope.principalId})};if(sql.startsWith('SELECT payload_json FROM assistant_relationships'))return {get:()=>({payload_json:JSON.stringify({status:relationship?'active':'inactive'})})};throw Error('Undeclared inert query');}}}};
 // Current storage API executes through the same declared fresh query ports.
 owner.database.readGet=(sql,...bindings)=>owner.database.connection.prepare(sql).get(...bindings);
 const a=source.indexOf('  private gameHostActorForContext('),b=source.indexOf('\n  private runtimeAuthorized(',a);assert(a>=0&&b>a);const method=stripTypeScriptTypes('({'+source.slice(a,b).replace('private ','')+'})',{mode:'strip'});
 const args={AuthenticationError:class extends Error{},readSessionEndpoint:()=>({endpoint:{endpointId:scope.contextBinding.endpointId,privacyClass:'personal',health:'healthy'},revision:1}),createAuthenticatedGameRuntime:(_s,_o,_r,ports)=>ports.current()?{isCurrent:ports.current,close(){}}:null};
 const selected=compileFunction('return '+method+'.gameHostActorForContext;',Object.keys(args))(...Object.values(args));
 const actor=selected.call(owner,local,true);
 return {scope,owner,actor,events,queries:()=>queries,currentCalls:()=>currentCalls,change:name=>{if(name==='auth')auth=false;if(name==='effective')effective=false;if(name==='audience')audience=false;if(name==='permission')permission=false;if(name==='session')session=false;if(name==='conversation')conversation=false;if(name==='relationship')relationship=false;if(name==='pinned')boundary++;}};
}
test('original actor return groups retain exact false result and closed code without private values',()=>{
 const cases={auth:'actor_auth_not_current',effective:'actor_effective_user_changed',audience:'actor_context_preconditions_failed',permission:'actor_admin_permission_missing',session:'actor_session_endpoint_not_current',conversation:'actor_conversation_identity_changed',relationship:'actor_relationship_not_current',pinned:'actor_selection_snapshot_changed'};
 for(const [fault,reason]of Object.entries(cases)){
  const f=actorFixture();assert.equal(f.actor.isCurrent(f.scope),true);f.events.length=0;f.change(fault);assert.equal(f.actor.isCurrent(f.scope),false);assert.deepEqual(f.events,[{schemaVersion:'ct-runtime-first-cause/1',source:'runtime',phase:'actor-current',reason}]);assert(!JSON.stringify(f.events).includes(f.scope.principalId));
 }
});
test('reporting actor refusal adds no original query/current calls and pre-Start restoration does not consume first cause',()=>{
 const armed=actorFixture(),unarmed=actorFixture();unarmed.owner.dedicatedCtActorDiagnosticActive=false;armed.change('relationship');unarmed.change('relationship');assert.equal(armed.actor.isCurrent(armed.scope),false);assert.equal(unarmed.actor.isCurrent(unarmed.scope),false);assert.equal(armed.queries(),unarmed.queries());assert.equal(armed.currentCalls(),unarmed.currentCalls());assert.equal(unarmed.events.length,0);
 armed.owner.dedicatedCtDiagnostic=()=>{throw Error('Optional diagnostic refused');};assert.equal(armed.actor.isCurrent(armed.scope),false);
});
test('original runtimeFor and authorized guards retain denial and expose only the first refusing group',()=>{
 const missing=actorFixture();missing.owner.providers.providers.inference.status='unhealthy';assert.equal(missing.actor.runtimeFor(missing.scope,{}),null);assert.equal(missing.events[0].reason,'runtime_provider_unhealthy');assert.equal(missing.queries(),0);
 const ok=actorFixture(),runtime=ok.actor.runtimeFor(ok.scope,{});assert.ok(runtime);assert.equal(runtime.isCurrent(),true);ok.events.length=0;ok.owner.profileSwitching=true;assert.equal(runtime.isCurrent(),false);assert.deepEqual(ok.events,[{schemaVersion:'ct-runtime-first-cause/1',source:'runtime',phase:'runtime-current',reason:'runtime_profile_switching'}]);
});
test('the actual existing owner Start capability arms actor diagnostics before unchanged canonical/start call ordering',()=>{
 const line=source.split('\n').find(v=>v.includes('start:(consent:unknown)=>{this.dedicatedCtActorDiagnosticActive=true;'));assert(line);const order=[],receiver={dedicatedCtActorDiagnosticActive:false},binding={actor:{}};
 const backend={start(actor,consent,context,refresh){assert.equal(receiver.dedicatedCtActorDiagnosticActive,true);order.push('start');assert.equal(actor,binding.actor);assert.equal(consent,true);assert.equal(context,'original-context');assert.equal(refresh(),binding.actor);throw Error('Original Start refuses');}};
 const selected=compileFunction('return '+stripTypeScriptTypes('({'+line+'})',{mode:'strip'})+'.start;',['backend','binding','canonical','current']).call(receiver,backend,binding,()=>{assert.equal(receiver.dedicatedCtActorDiagnosticActive,true);order.push('canonical');return 'original-context';},()=>order.push('current'));
 assert.throws(()=>selected.call(receiver,true),/Original Start refuses/);assert.deepEqual(order,['canonical','start','current']);assert.equal(receiver.dedicatedCtActorDiagnosticActive,true);
});
test('original fixed lifecycle current refusal is recorded before lifecycle abort without reevaluation',async()=>{
 const a=source.indexOf('  prepareDedicatedCtLifecycle('),b=source.indexOf('\n  /** Launcher-owned fixed selection',a);assert(a>=0&&b>a);const method=stripTypeScriptTypes('({'+source.slice(a,b)+'})',{mode:'strip'});
 const prepare=compileFunction('return '+method+'.prepareDedicatedCtLifecycle;',['AuthenticationError','redactedDigest'])(class extends Error{},()=> 'constant-config-digest');const events=[],order=[];
 const owner={state:'ready',localAuth:{},database:{},config:{},providers:{},restoreQuarantine:false,profileSwitching:false,activeGameRuntimes:new Map(),reportDedicatedCtDiagnostic:report};
 const policy={maximumGameplayMs:80000,operationLimits:{owner_prepare:30000,native_prepare:30000,native_start:30000,model:3000,controller:500,settle:5000},cleanupTimeoutMs:10000};
 const life=prepare.call(owner,policy,createSelectedCtJobLifecycle,isSelectedCtJobLifecycle,value=>{events.push(value);order.push(value.source);});life.signal.addEventListener('abort',()=>order.push('abort'));owner.profileSwitching=true;
 assert.equal(life.check(),false);assert.deepEqual(order.slice(0,4),['runtime','lifecycle','lifecycle','abort']);assert.equal(events[0].reason,'lifecycle_profile_switching');assert.equal(events[1].reason,'currentness_lost');assert.equal(events[1].schemaVersion,'ct-runtime-first-cause/1');assert.equal(events[2].schemaVersion,'ct-runtime-terminal-cause/1');assert.equal(events[2].reason,'currentness_lost');await life.completion();
});
