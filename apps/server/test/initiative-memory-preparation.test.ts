import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{type TestContext} from 'node:test';
import {Database} from '@lifestream/storage-sqlite';
import {compileRelationshipContext} from '@lifestream/runtime/context';
import type {InferenceRequest} from '@lifestream/runtime/inference';
import {InitiativeHost,type InitiativeOwner,type QualifiedInitiativeEvent} from '../src/runtime/initiative-host.ts';
import type {HostRuntimeInput} from '../src/runtime/inference.ts';
import {attachConversationMemoryRecall} from '../src/runtime/conversation-memory-context.ts';
import {initiativePreset} from '../src/admin/initiative-policy.ts';
import {extensionSettings} from '../../../tests/fixtures/extension-settings.ts';

// A trusted synthetic source and local SQLite exercise the actual Initiative
// orchestrator. No camera, recognition, real provider or external output exists.
function fixture(t:TestContext){
 const db=new Database({path:':memory:'});db.migrate();
 db.exec('CREATE TABLE assistant_relationship_idempotency (idempotency_key TEXT PRIMARY KEY, relationship_id TEXT NOT NULL, operation TEXT NOT NULL, response_json TEXT NOT NULL)');
 let now=Date.now(),sourceCurrent=true,authorized=true,leaseCurrent=true;
 const scope={assistantId:randomUUID(),userId:randomUUID(),relationshipId:randomUUID(),deploymentId:randomUUID()};
 const sessionId=randomUUID(),endpointId=randomUUID(),configurationId=randomUUID();
 const configuration={...structuredClone(extensionSettings.initiative),...scope,schemaVersion:'1.0.0',recordType:'configuration',configurationId,revision:1,parentConfigurationRevision:`${configurationId}:1`,lifecycle:'active',preset:'friendly',proactiveness:5,dimensions:initiativePreset(5),allowedContexts:['privateAvailable'],endpointIds:[endpointId],allowedModalities:['text'],allowedKinds:['availableCheckIn'],consentRefs:['synthetic:explicit'],tuning:{...extensionSettings.initiative.tuning,openingsPerHour:2,openingsPerDay:8,checkInIntervalSeconds:300}};
 const owner:InitiativeOwner={scope,configuration,profile:{assistantId:scope.assistantId,profileId:randomUUID(),revision:1,status:'active',adaptivePersonaPolicy:{dimensions:[]}},boundary:'synthetic:owner:1',consentCurrent:true,evidenceRefs:[]};
 const event:QualifiedInitiativeEvent={...scope,scope,userId:scope.userId,sessionId,endpointId,sourceEventId:'synthetic:current-event',sourceId:'synthetic:qualified-source',sourceRevision:1,evidenceRef:'synthetic:current-evidence',identityQualified:true,privateAudience:true,kind:'availableCheckIn',topicRef:null,observedAt:now,expiresAt:now+60000,context:'privateAvailable',modality:'text'};
 const host=new InitiativeHost(db,undefined,()=>now,{sourceId:event.sourceId,resolve:()=>sourceCurrent?event:undefined});
 t.after(()=>{host.close();db.close();});
 const controller=new AbortController(),order:string[]=[],requests:InferenceRequest[]=[],outputs:string[]=[];
 const view=(label:string)=>compileRelationshipContext({records:[{id:`synthetic:${label}`,content:label,revision:1,sourceFamily:'synthetic:owner',status:'approved',use:'correction',personalization:true,mention:true}],userInput:'',audienceScope:'authenticatedSession',profileRevision:'synthetic:profile:1',relationshipRevision:`${scope.relationshipId}:1`,configurationRevision:`${configurationId}:1`,now});
 const prepared:HostRuntimeInput={assistantId:scope.assistantId,endpointId,isCurrent:()=>authorized,profileProjection:{sourceRef:'synthetic:profile',sourceRevision:'synthetic:profile:1',corePersona:'Synthetic fixed persona.',adaptivePersona:'Fixed.'},preparedRelationshipContext:view('BEFORE_PREPARATION'),runtimeSelfContext:{sourceRevision:'synthetic:runtime:1',runtimeStatus:'ready',endpointId,endpointScope:'sessionEndpoint',audienceScope:'authenticatedSession',permissionState:'authenticatedSession',inputModalities:{text:'active',microphone:'inactive',visual:'notConfigured'},outputModalities:{text:'active',speechGeneration:'unavailable',speechDelivery:'notObserved',presentation:'notConfigured'},limitations:['Synthetic ports; no physical identity or delivery.']}};
 const context:Parameters<InitiativeHost['receiveQualified']>[1]={owner:()=>owner,session:()=>({sessionId,conversationId:sessionId,revision:1,endpoint:{schemaVersion:'1.0.0',endpointId,endpointClass:'testHarness',locationRef:null,ownership:'fixture',inputModalities:['text'],outputModalities:['text'],privacyClass:'personal',presenceCapabilities:[],rendererCapabilities:null,handoffSupport:'none',speakerIdentity:'unavailable',health:'healthy',configurationRevision:1}}),authorized:()=>authorized,signal:controller.signal,prepare:()=>{order.push('prepare');return prepared;},provider:{async *generate(request){order.push('generate');requests.push(request);yield {kind:'text',text:'Synthetic opening.'};yield {kind:'done'};}},emit:(prefix,suffix)=>{outputs.push(prefix+suffix());order.push('emit');}};
 const ready=()=>host.handle({schemaVersion:'1.0.0',operation:'outputReadiness',sessionId,modality:'text',ready:true},context);
 const deliver=()=>host.receiveQualified(event.sourceEventId,context);
 const installLease=()=>{prepared.preparedRelationshipContext=view('AFTER_PREPARATION');prepared.isCurrent=()=>authorized&&leaseCurrent;};
 const invalidate=(cause:string)=>{if(cause==='consent')owner.consentCurrent=false;else if(cause==='source')sourceCurrent=false;else if(cause==='owner')authorized=false;else if(cause==='expiry')now+=60001;else if(cause==='abort')controller.abort();else leaseCurrent=false;};
 return {db,host,scope,sessionId,owner,event,context,prepared,view,order,requests,outputs,ready,deliver,installLease,invalidate};
}

function deferred(){let resolve:()=>void=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('Initiative awaits one host callback before copying the updated context and generating',async t=>{
 const f=fixture(t),entered=deferred(),release=deferred();await f.ready();let calls=0;
 f.prepared.prepareMemory=async signal=>{calls++;assert.equal(signal.aborted,false);f.order.push('memory-start');entered.resolve();await release.promise;f.installLease();f.order.push('memory-ready');};
 const pending=f.deliver();t.after(()=>release.resolve());
 await Promise.race([entered.promise,turn()]);
 assert.equal(calls,1,'The actual Initiative host must invoke deferred memory preparation.');
 assert.equal(f.requests.length,0,'No generation while the host memory boundary is pending.');
 assert.equal(f.outputs.length,0);release.resolve();await pending;
 assert.deepEqual(f.order,['prepare','memory-start','memory-ready','generate','emit']);
 assert.equal(f.prepared.prepareMemory,undefined,'The original helper consumes the callback once.');
 assert.equal(f.requests.length,1);assert.equal(f.outputs.length,1);
 const memory=f.requests[0]!.sections.find(section=>section.kind==='preparedMemory')!.content;
 assert.match(memory,/AFTER_PREPARATION/);assert.doesNotMatch(memory,/BEFORE_PREPARATION/);
 const updated=f.view('AFTER_PREPARATION');assert.deepEqual(f.prepared.preparedRelationshipContext,updated);
 assert.ok(updated.sourceRevisions.includes('synthetic:AFTER_PREPARATION:1'));
 assert.equal(f.requests[0]!.sections.find(section=>section.kind==='userInput')!.content,'');
 assert.equal(f.host.ledger.list(f.scope)[0]!.outcome.state,'emitted');
});

for(const cause of ['correction','forget','consent','source','owner','expiry','abort']){
 test(`Initiative denies generation when ${cause} invalidates pending memory preparation`,async t=>{
  const f=fixture(t),entered=deferred(),release=deferred();await f.ready();
  f.prepared.prepareMemory=async()=>{entered.resolve();await release.promise;f.installLease();};
  const pending=f.deliver();t.after(()=>release.resolve());await Promise.race([entered.promise,turn()]);
  f.invalidate(cause);release.resolve();await pending;
  assert.equal(f.requests.length,0);assert.equal(f.outputs.length,0);
  assert.notEqual(f.host.ledger.list(f.scope)[0]!.outcome.state,'emitted');
  assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM initiative_inference_calls').get()!.n,0);
 });
}

test('Initiative rejects a failed host memory callback without charging generation',async t=>{
 const f=fixture(t);await f.ready();let calls=0;
 f.prepared.prepareMemory=async()=>{calls++;throw Error('Synthetic memory preparation failed');};
 await f.deliver();assert.equal(calls,1);assert.equal(f.requests.length,0);assert.equal(f.outputs.length,0);
 assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM initiative_inference_calls').get()!.n,0);
});

for(const cause of ['correction','forget','consent','expiry']){
 test(`Initiative retains the callback-installed lease through generation and stops late ${cause} output`,async t=>{
  const f=fixture(t);await f.ready();f.prepared.prepareMemory=async()=>{f.installLease();};
  let generated=0;f.context.provider={async *generate(request){generated++;assert.match(request.sections.find(s=>s.kind==='preparedMemory')!.content,/AFTER_PREPARATION/);yield {kind:'text',text:'Must never be delivered.'};f.invalidate(cause);yield {kind:'done'};}};
  await f.deliver();assert.equal(f.prepared.prepareMemory,undefined);assert.equal(generated,1);assert.equal(f.outputs.length,0);assert.notEqual(f.host.ledger.list(f.scope)[0]!.outcome.state,'emitted');
 });
}

test('Initiative without a deferred callback preserves the existing context and empty user input',async t=>{
 const f=fixture(t);await f.ready();await f.deliver();assert.equal(f.requests.length,1);assert.equal(f.outputs.length,1);
 assert.match(f.requests[0]!.sections.find(s=>s.kind==='preparedMemory')!.content,/BEFORE_PREPARATION/);
 assert.equal(f.requests[0]!.sections.find(s=>s.kind==='userInput')!.content,'');
});

test('Initiative invokes the original recall attachment with an empty query and preserves its ordinary fallback',async t=>{
 const f=fixture(t);await f.ready();let queries=0,compiled=0,warmed=0;
 attachConversationMemoryRecall(f.prepared,{scope:{assistantId:f.scope.assistantId,principalId:f.scope.userId,relationshipId:f.scope.relationshipId},query:'',options:{mode:'idle',waitBudgetMs:0,fallback:'ordinary-context',warmOnMiss:true},worker:{conversationRecall:async(_scope,query,waitBudgetMs,call)=>{queries++;assert.equal(query,'');assert.equal(waitBudgetMs,0);assert.equal(call.current(),true);assert.equal(call.signal?.aborted,false);return {state:'fallback',coverage:'miss',reason:'no_completed_idle_result'};},precomputeRecall:()=>{warmed++;return true;}},compile:()=>{compiled++;return f.view('UNEXPECTED_RETRIEVAL');}});
 await f.deliver();assert.equal(queries,1);assert.equal(compiled,0);assert.equal(warmed,0,'An unsolicited opening does not invent a completed user turn to warm retrieval.');
 assert.equal(f.prepared.memoryRecall?.state,'fallback');assert.equal(f.prepared.memoryRecall?.providerCalls,0);
 assert.equal(f.requests.length,1);assert.equal(f.outputs.length,1);
 assert.match(f.requests[0]!.sections.find(s=>s.kind==='preparedMemory')!.content,/BEFORE_PREPARATION/);
 assert.equal(f.requests[0]!.sections.find(s=>s.kind==='userInput')!.content,'');
});
