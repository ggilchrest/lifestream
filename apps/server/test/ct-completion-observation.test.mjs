import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {compileFunction} from 'node:vm';

// Compile the original methods with inert collaborators. No server, database,
// provider, native process or alternative observation implementation is used.
const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
const start=source.indexOf('  private openDedicatedCtOwnedSession(');
const end=source.indexOf('\n  private installUbuntuGame(',start);
assert(start>=0&&end>start);
const method=stripTypeScriptTypes('({'+source.slice(start,end).replace('private ','')+'})',{mode:'strip'});

function ownerFixture(){
 let authCurrent=true,actorCurrent=true,observations=0,mutate=()=>{};
 const effects=[],scope={principalId:'fixture-principal',assistantId:'fixture-assistant',contextBinding:{sessionId:'fixture-session'}};
 const local={principalId:scope.principalId,sessionId:scope.contextBinding.sessionId};
 const actor={isCurrent:()=>actorCurrent},binding={local,actor,assertCurrent(){if(!authCurrent)throw Error('Original authentication revoked');}};
 const database={connection:{prepare:()=>({get:()=>({conversation_id:'fixture-conversation'})})}};
 const store={directory:'/fixture-unopened',close(){effects.push('store-close');}};
 const backend={scope,bind(){},timingCurrent:()=>false,
  observeStatus(){observations++;mutate();return Object.freeze({kind:'completed',state:'stopped'});},
  status:()=>assert.fail('Completed observation must not use active status'),
  close:async()=>{effects.push('backend-close');}};
 const receiver={state:'ready',localAuth:{},database,config:{revision:1},providers:{},restoreQuarantine:false,
  profileSwitching:false,sessionEnvironmentId:'fixture-environment',
  installUbuntuGame(){this.ubuntuGameBackend=backend;}};
 const dependencies={AuthenticationError:class extends Error{},redactedDigest:JSON.stringify,
  readSessionEndpoint:()=>({endpoint:{endpointId:'fixture-endpoint'}}),createDedicatedCtStore:()=>store,
  assertDedicatedCtStore(value,db){assert.equal(value,store);assert.equal(db,database);return {};},
  CanonicalAuthorityApi:class {},ubuntuGameAuthorityRouter:()=>({})};
 const open=compileFunction('return '+method+'.openDedicatedCtOwnedSession;',Object.keys(dependencies))(...Object.values(dependencies));
 const owner=open.call(receiver,binding,{profile:{}},'/fixture-unopened',{request(){},response(){}});
 return {owner,receiver,backend,effects,observations:()=>observations,mutateDuring(fn){mutate=fn;},
  revokeAuth(){authCurrent=false;},revokeActor(){actorCurrent=false;}};
}

test('original owner observes completion despite retired execution, without reopening or effects',()=>{
 const f=ownerFixture();assert.equal(f.backend.timingCurrent(),false);
 const value=f.owner.observeStatus();assert.deepEqual(value,{kind:'completed',state:'stopped'});
 assert(Object.isFrozen(value));assert.equal(f.observations(),1);assert.deepEqual(f.effects,[]);
 assert.equal(f.backend.timingCurrent(),false);
});

const changes={
 authentication:f=>f.revokeAuth(),actor:f=>f.revokeActor(),authOwner:f=>{f.receiver.localAuth={};},
 database:f=>{f.receiver.database={};},configuration:f=>{f.receiver.config={revision:1};},
 configurationMutation:f=>{f.receiver.config.revision++;},providers:f=>{f.receiver.providers={};},
 backend:f=>{f.receiver.ubuntuGameBackend={};},store:f=>{f.receiver.dedicatedCtStore={};},
 readiness:f=>{f.receiver.state='draining';},profileSwitch:f=>{f.receiver.profileSwitching=true;},
 quarantine:f=>{f.receiver.restoreQuarantine=true;}
};
for(const [name,change] of Object.entries(changes)){
 test('completion observation rejects original '+name+' drift before reading',()=>{
  const f=ownerFixture();change(f);assert.throws(()=>f.owner.observeStatus());
  assert.equal(f.observations(),0);assert.deepEqual(f.effects,[]);
 });
 test('completion observation rejects '+name+' drift during the synchronous read',()=>{
  const f=ownerFixture();f.mutateDuring(()=>change(f));assert.throws(()=>f.owner.observeStatus());
  assert.equal(f.observations(),1);assert.deepEqual(f.effects,[]);
 });
}

const backendSource=readFileSync(new URL('../src/runtime/ubuntu-game-backend.ts',import.meta.url),'utf8');
const backendStart=backendSource.indexOf('  observeStatus(actor:any){');
const backendEnd=backendSource.indexOf('\n  bind(actor:any,metadata:any){',backendStart);
assert(backendStart>=0&&backendEnd>backendStart);
const backendMethod=stripTypeScriptTypes('({'+backendSource.slice(backendStart,backendEnd)+'})',{mode:'strip'});
function backendFixture({completed=true,clean=true}={}){
 let profileCurrent=true,statusReads=0,checks=0,afterCompletion=()=>{};
 const actor={},session={completed(value){assert.equal(value,actor);afterCompletion();return completed;}},
  composition={cleanupConfirmed:()=>clean};
 const args={check(){checks++;if(!profileCurrent)throw Error('Original profile unavailable');},
  identity:value=>{assert.equal(value,actor);return value;},session,composition,
  status(){statusReads++;return {state:'stopped',frameQualification:'required'};}};
 const observe=compileFunction('return '+backendMethod+'.observeStatus;',Object.keys(args))(...Object.values(args));
 return {read:()=>observe(actor),statusReads:()=>statusReads,checks:()=>checks,
  changeDuring(){afterCompletion=()=>{profileCurrent=false;};}};
}
test('backend completion requires both original session receipt and confirmed cleanup',()=>{
 const ready=backendFixture();assert.deepEqual(ready.read(),{kind:'completed',state:'stopped'});
 assert.equal(ready.checks(),2);assert.equal(ready.statusReads(),0);
 for(const options of [{completed:false},{clean:false}]){
  const f=backendFixture(options);assert.deepEqual(f.read(),{kind:'active',state:'stopped',frameQualification:'required'});
  assert.equal(f.statusReads(),1);
 }
});
test('backend rechecks the original profile after reading completion',()=>{
 const f=backendFixture();f.changeDuring();assert.throws(f.read);assert.equal(f.statusReads(),0);
});
