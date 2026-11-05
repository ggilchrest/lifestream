// Original server methods with inert metadata/authority/response ports only.
// No server constructor/start, SQLite instance, external fetch, model or browser.
import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {LifestreamServer} from '../src/index.ts';import {streamMessage} from '../src/runtime/inference.ts';
const id=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`,secret='PRIVATE_CONTEXT_SENTINEL';
function fixture({preparedExpiry=false}={}){
 const reads=[],events=[],control={authorized:true,authorizationThrows:false,state:'ready',health:'ready',sessionRevision:1,audienceRevision:1,persona:undefined,policy:secret,context:secret};
 const read=(name,value)=>{reads.push(name);return value;};
 const endpoint={endpointId:id(7),endpointClass:'desktopCompanion',privacyClass:'personal',ownership:'personal',health:'healthy',configurationRevision:1};
 const relation=preparedExpiry?{selections:[],sourceRevisions:[],relationshipRevision:'1',configurationRevision:'1',freshUntil:new Date(Date.now()+5000).toISOString()}:undefined;
 const owner={config:{providers:{world:'none'}},localAuth:{},
  database:{connection:{prepare(statement){if(statement.startsWith('SELECT s.revision,'))return{get:()=>read('session.endpoint',{revision:control.sessionRevision,profile:JSON.stringify(endpoint),mode:'text',audience:'authenticatedSession',endpointRevision:1})};if(statement.startsWith('SELECT conversation_id AS id FROM sessions'))return{get:()=>read('session.conversation',{id:id(5)})};throw Error('Unapproved fixture metadata surface');}}},
  admin:{conversationRelationshipId:()=>undefined,getActivePersona:()=>read('persona',control.persona),getPreparedRelationshipContext:()=>relation,contextBoundary:()=>read('relationship.context',control.context),initiativeOwner:()=>undefined,noteDiscoveryRequest(){}},
  automaticMemory:{preempt(){}},initiativeHost:{expressionWarmth:()=>read('warmth',undefined)},presentationSelection:{runtimeState:()=>read('presentation',{state:'unavailable',revision:1})},presentationPackages:{},providers:{providers:{}},
  audiencePermits:()=>read('audience.permits',true),audienceFor:()=>({snapshot:()=>read('audience.revision',{revision:control.audienceRevision})}),audienceIdentity:()=>({}),conversationPolicyBoundary:()=>read('retention.policy',control.policy),
  conversationPort:()=>({read:()=> '[]',remember(){},observe:event=>events.push(event)}),
  visualInput:{contextAvailability:()=>null,cameraAudienceConfigured:()=>false,selectContext:()=>({reason:'scope_unavailable',view:null}),turnEvidence:()=>undefined},runtimeSelfContext:LifestreamServer.prototype.runtimeSelfContext
 };
 // The original metadata owner now uses private readGet. Delegate to this
 // fixture's same strict SQL surface, retaining every original predicate.
 owner.database.readGet=(statement,...args)=>owner.database.connection.prepare(statement).get(...args);
 Object.defineProperty(owner,'state',{get:()=>read('lifecycle',control.state)});owner.health={get status(){return read('runtime.health',control.health);}};
 const context={principalId:id(1),sessionId:id(2),expiresAt:'2099-01-01T00:00:00Z'},history={conversationId:id(5),access:{ordinarySelf:()=>true,scope:{actorId:id(1),effectiveUserId:id(1)},repository:{contentBoundary:()=>read('conversation.content',secret)}}};
 const authorized=()=>{reads.push('authorization');if(control.authorizationThrows)throw Error(secret);return control.authorized;};
 const prepared=Reflect.apply(LifestreamServer.prototype.prepareRuntimeInput,owner,[{assistantId:id(4),conversationId:id(5),userInput:'Controlled predicate check'},context,'inactive','none',authorized,'userTurn',history]);
 reads.length=0;return{prepared,reads,events,control};
}
function trackClock(t,reads){const now=Date.now,parse=Date.parse;t.mock.method(Date,'now',()=>{reads.push('clock.now');return now();});t.mock.method(Date,'parse',value=>{reads.push('clock.parse');return parse(value);});}
const cases=[
 ['healthy',true,undefined],['source-expired',false,'turn_source_expiry'],['owner-withdrawn',false,'authorization'],['owner-read-throws',false,'authorization'],['draining',false,'lifecycle'],['session-revision',false,'context_fingerprint'],['audience-revision',false,'context_fingerprint'],['provider-recovery-health',false,'context_fingerprint'],['persona-revision',false,'context_fingerprint'],['policy-revision',false,'context_fingerprint'],['relationship-revision',false,'context_fingerprint'],['prepared-context-expired',false,'prepared_context_expiry']
];
for(const [name,expected,predicate]of cases)test(`original predicate: ${name}`,async t=>{
 const initial=Date.now();t.mock.timers.enable({apis:['Date'],now:initial});const f=fixture({preparedExpiry:name==='prepared-context-expired'});
 if(name==='source-expired')t.mock.timers.tick(30001);
 if(name==='prepared-context-expired')t.mock.timers.tick(5001);
 if(name==='owner-withdrawn')f.control.authorized=false;
 if(name==='owner-read-throws')f.control.authorizationThrows=true;
 if(name==='draining')f.control.state='draining';
 if(name==='session-revision')f.control.sessionRevision=2;
 if(name==='audience-revision')f.control.audienceRevision=2;
 if(name==='provider-recovery-health')f.control.health='degraded';
 if(name==='persona-revision')f.control.persona={sourceRevision:secret+'CHANGED'};
 if(name==='policy-revision')f.control.policy=secret+'CHANGED';
 if(name==='relationship-revision')f.control.context=secret+'CHANGED';
 trackClock(t,f.reads);const accepted=f.prepared.isCurrent(),before=[...f.reads],diagnostic=f.prepared.readCurrentnessDiagnostic?.();
 t.diagnostic(JSON.stringify({scenario:name,accepted,reads:before}));
 assert.equal(accepted,expected);assert.deepEqual(f.reads,before,'Reading a captured diagnostic must not re-read currentness');
 assert.equal(diagnostic?.predicate,predicate);
 if(name==='healthy'){assert.equal(diagnostic,undefined);return;}
 assert.equal(diagnostic.result,name==='owner-read-throws'?'unavailable':'false');assert(Object.isFrozen(diagnostic));
 const serialized=JSON.stringify(diagnostic);assert(!serialized.includes(secret));assert(!serialized.includes(id(1)));assert(!serialized.includes(id(7)));
 if(name==='source-expired'){assert.equal(diagnostic.deadlineMs,initial+30000);assert.equal(diagnostic.checkedAtMs,initial+30001);assert.deepEqual(before,['clock.now','clock.parse']);}
 if(name==='owner-withdrawn'||name==='owner-read-throws')assert.deepEqual(before,['clock.now','clock.parse','authorization'],'Owner failure short-circuits every later mutable read');
 if(name==='draining')assert.deepEqual(before,['clock.now','clock.parse','authorization','lifecycle']);
 if(name==='session-revision'){assert(diagnostic.components.includes('runtime_self_context'));assert(diagnostic.runtimeFields.includes('sessionRevision'));assert.deepEqual(diagnostic.versions,[{field:'sessionRevision',before:1,after:2}]);}
 if(name==='audience-revision')assert.deepEqual(diagnostic.versions,[{field:'audienceRevision',before:1,after:2}]);
 if(name==='provider-recovery-health')assert(diagnostic.runtimeFields.includes('runtimeStatus'));
 if(name==='persona-revision')assert.deepEqual(diagnostic.components,['persona_revision']);
 if(name==='policy-revision')assert.deepEqual(diagnostic.components,['retention_policy']);
 if(name==='relationship-revision')assert.deepEqual(diagnostic.components,['relationship_context']);
 if(name==='prepared-context-expired'){assert.equal(diagnostic.deadlineMs,initial+5000);assert.equal(diagnostic.checkedAtMs,initial+5001);assert.deepEqual(before.slice(-2),['clock.parse','clock.now'],'Prepared expiry retains parse-before-clock order');}
});
test('first real owner failure cannot be relabelled as a later clock expiry',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=fixture();f.control.authorized=false;assert.equal(f.prepared.isCurrent(),false);const first=f.prepared.readCurrentnessDiagnostic();t.mock.timers.tick(30001);assert.equal(f.prepared.isCurrent(),false);assert.equal(f.prepared.readCurrentnessDiagnostic(),first);assert.equal(first.predicate,'authorization');
});
class ResponsePort extends EventEmitter{destroyed=false;writableEnded=false;output='';writeHead(){}write(value){this.output+=value;return true;}end(){this.writableEnded=true;}}
for(const mode of ['expiry','owner','revision','broken-diagnostic'])test(`existing stream rejection reports captured ${mode} without changing cancellation or terminal state`,async t=>{
 const initial=Date.now();t.mock.timers.enable({apis:['Date','setTimeout'],now:initial});const f=fixture(),logs=[];t.mock.method(console,'warn',value=>logs.push(value));
 let invoked=0,returned=0;if(mode==='broken-diagnostic')f.prepared.readCurrentnessDiagnostic=()=>{throw Error(secret);};
 const provider={async*generate(_request,context){invoked++;context.signal.addEventListener('abort',()=>{if(mode==='revision')f.control.sessionRevision=99;},{once:true});try{yield{kind:'text',text:'C'};if(mode==='expiry')t.mock.timers.tick(30001);else if(mode==='revision')f.control.sessionRevision=2;else f.control.authorized=false;yield{kind:'done'};}finally{returned++;}}};
 const response=new ResponsePort();await streamMessage(response,provider,{assistantId:id(4),conversationId:id(5),endpointId:f.prepared.endpointId,userInput:'Controlled rejected request'},id(2),new AbortController().signal,undefined,f.prepared.runtimeSelfContext,f.prepared);
 const frame=response.output.split('\n\n').find(s=>s.startsWith('event: interaction.error'));assert(frame);const error=JSON.parse(frame.match(/^data: (.+)$/m)[1]);
 assert.equal(error.code,'runtime_input_stale');assert(!response.output.includes('event: interaction.completed'));assert.equal(f.events.filter(e=>e.role==='assistant'&&e.state==='interrupted').length,1);assert.equal(invoked,1);assert.equal(returned,1);assert.equal(response.destroyed,false);
 if(mode==='broken-diagnostic'){assert.equal(error.currentnessDiagnostic,undefined);assert.equal(logs.length,0);return;}
 assert.equal(logs.length,1);const log=JSON.parse(logs[0]);assert.equal(log.event,'runtime_currentness_failed');assert.deepEqual(error.currentnessDiagnostic,Object.fromEntries(Object.entries(log).filter(([key])=>key!=='event')));
 const text=JSON.stringify({log,error});assert(!text.includes(secret));assert(!text.includes(id(1)));assert(!text.includes(id(7)));
 if(mode==='expiry'){assert.equal(log.predicate,'turn_source_expiry');assert.equal(log.deadlineMs,initial+30000);assert.equal(error.message,'The reply context expired before completion.');}
 if(mode==='owner'){assert.equal(log.predicate,'authorization');assert.equal(error.message,'The interaction context changed. Please retry with the current scope.');}
 if(mode==='revision'){assert.equal(f.control.sessionRevision,99);assert.deepEqual(log.versions,[{field:'sessionRevision',before:1,after:2}],'Abort side effects cannot change the already-captured version');}
});
test('successful original stream has unchanged completion and no failure diagnostic/log',async t=>{
 const f=fixture(),logs=[];t.mock.method(console,'warn',value=>logs.push(value));const response=new ResponsePort();
 await streamMessage(response,{async*generate(){yield{kind:'text',text:'Controlled complete response'};yield{kind:'done'};}},{assistantId:id(4),conversationId:id(5),endpointId:f.prepared.endpointId,userInput:'Controlled successful request'},id(2),new AbortController().signal,undefined,f.prepared.runtimeSelfContext,f.prepared);
 assert(response.output.includes('event: interaction.completed'));assert(!response.output.includes('event: interaction.error'));assert.equal(logs.length,0);assert.equal(f.prepared.readCurrentnessDiagnostic?.(),undefined);assert.equal(f.events.filter(e=>e.role==='assistant'&&e.state==='completed').length,1);
});
