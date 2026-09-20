import assert from 'node:assert/strict';
import test from 'node:test';
import {ConversationHistory,conversationLimits,type ConversationScope} from '../src/runtime/conversation.ts';
const scope:ConversationScope={principalId:'subject',sessionId:'session',conversationId:'conversation',assistantId:'assistant',relationshipId:'relationship'};

test('shared volatile history preserves turn order across bindings and isolates every owning identity',()=>{
 const history=new ConversationHistory(()=>1000),first=history.bind(scope,()=>true,999999);
 first.remember({interactionId:'a',role:'user',text:'Typed message.'});first.remember({interactionId:'a',role:'assistant',text:'Partial'});first.remember({interactionId:'a',role:'assistant',text:'Completed reply.'});
 const next=history.bind({...scope},()=>true,999999);assert.deepEqual(JSON.parse(next.read()).map((t:any)=>t.text),['Typed message.','Completed reply.']);
 next.remember({interactionId:'b',role:'assistant',text:'An emitted opening.',opportunityId:'op',observation:'emitted'});assert.equal(JSON.parse(first.read()).length,3);
 for(const key of Object.keys(scope)){const foreign={...scope,[key]:'other'};assert.equal(history.bind(foreign,()=>true,999999).read(),'[]',key);}
});

test('expired or invalid history cannot return after a clock rollback or a retired binding becomes valid again',()=>{
 let now=1000,current=true;const history=new ConversationHistory(()=>now),port=history.bind(scope,()=>current,999999);
 port.remember({interactionId:'old',role:'assistant',text:'Old private context.'});current=false;history.prune();current=true;port.remember({interactionId:'late',role:'assistant',text:'Late stale output.'});assert.equal(port.read(),'[]');
 const fresh=history.bind(scope,()=>true,1020);fresh.remember({interactionId:'fresh',role:'user',text:'Fresh'});now=1021;assert.equal(fresh.read(),'[]');now=1001;fresh.remember({interactionId:'revive',role:'user',text:'No resurrection'});assert.equal(fresh.read(),'[]');
 const failed=history.bind(scope,()=>{throw new Error('Authority unavailable');},999999);failed.remember({interactionId:'failure',role:'user',text:'Do not retain'});assert.equal(history.diagnostics().entries,0);
});

test('conversation memory remains within scope, entry, runtime and serialized byte ceilings',()=>{
 let now=1000;const history=new ConversationHistory(()=>now);
 for(let owner=0;owner<40;owner++){
  const port=history.bind({...scope,assistantId:String(owner)},()=>true,Number.MAX_SAFE_INTEGER);
  for(let turn=0;turn<24;turn++){now++;port.remember({interactionId:String(turn),role:'assistant',text:'X'.repeat(20000)});}
  assert.ok(JSON.parse(port.read()).length<=conversationLimits.entriesPerScope);assert.ok(Buffer.byteLength(port.read(),'utf8')<=conversationLimits.bytesPerScope);
 }
 const stats=history.diagnostics();assert.ok(stats.scopes<=conversationLimits.scopes);assert.ok(stats.entries<=conversationLimits.entries);assert.ok(stats.bytes<=conversationLimits.totalBytes);
});

test('retention expires without reads extending it and process cleanup removes all payloads',()=>{
 let now=1000;const history=new ConversationHistory(()=>now),port=history.bind(scope,()=>true,Number.MAX_SAFE_INTEGER);port.remember({interactionId:'a',role:'user',text:'Temporary'});
 now+=conversationLimits.ttlMs-1;assert.match(port.read(),/Temporary/);now++;assert.equal(port.read(),'[]');const next=history.bind(scope,()=>true,Number.MAX_SAFE_INTEGER);next.remember({interactionId:'b',role:'user',text:'New'});history.clear();assert.deepEqual(history.diagnostics(),{scopes:0,entries:0,bytes:0});
});

test('idle payloads are erased at expiry without another read or request',t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=1000;const history=new ConversationHistory(()=>now);history.bind(scope,()=>true,1100).remember({interactionId:'idle',role:'user',text:'Must expire while idle'});assert.equal(history.diagnostics().entries,1);now=1100;t.mock.timers.tick(100);assert.equal(history.diagnostics().entries,0);history.clear();
});

test('prepared handoff preserves dialogue lineage and original expiry without memory admission',()=>{
 let now=1000,sourceCurrent=true,destinationCurrent=true;const history=new ConversationHistory(()=>now),port=history.bind(scope,()=>sourceCurrent,5000),destination={...scope,sessionId:'fresh-session'};
 port.remember({interactionId:'turn',role:'user',text:'Accepted input.'});port.remember({interactionId:'opening',role:'assistant',text:'Observed opening.',opportunityId:'opportunity',observation:'emitted'});
 const boundary=history.prepareTransfer(scope);assert.equal(boundary.entries,2);now=2000;
 history.withTransfer(boundary,destination,10000,install=>{sourceCurrent=false;install(()=>destinationCurrent);});
 const received=history.bind(destination,()=>destinationCurrent,10000);assert.equal(received.read(),boundary.content);assert.equal(port.read(),'[]');assert.equal(history.transferCurrent(boundary),false);assert.throws(()=>history.withTransfer(boundary,destination,10000,()=>{}),/changed/);
 now=5000;assert.equal(received.read(),'[]','transfer cannot renew original retention');history.clear();
});

test('handoff rejects forged, changed, cross-owner and occupied destination boundaries',()=>{
 let current=true;const history=new ConversationHistory(()=>1000),port=history.bind(scope,()=>current,5000),destination={...scope,sessionId:'destination'};port.remember({interactionId:'a',role:'user',text:'Source'});
 const first=history.prepareTransfer(scope);assert.equal(history.transferCurrent({...first}),false);port.remember({interactionId:'b',role:'assistant',text:'Later'});assert.equal(history.transferCurrent(first),false);
 const boundary=history.prepareTransfer(scope);for(const key of ['principalId','assistantId','conversationId','relationshipId'])assert.throws(()=>history.withTransfer(boundary,{...destination,[key]:'foreign'},5000,()=>{}),/scope/);
 history.bind(destination,()=>true,5000).remember({interactionId:'old',role:'user',text:'Existing destination conversation'});assert.throws(()=>history.withTransfer(boundary,destination,5000,()=>{}),/already/);
 current=false;assert.equal(history.transferCurrent(boundary),false);history.prune();current=true;assert.equal(history.transferCurrent(boundary),false);history.clear();
});

test('durable handoff failure restores volatile history without retiring the rolled-back source',()=>{
 let sourceCurrent=true;const history=new ConversationHistory(()=>1000),port=history.bind(scope,()=>sourceCurrent,5000),destination={...scope,sessionId:'destination'};port.remember({interactionId:'a',role:'user',text:'Preserve me'});const boundary=history.prepareTransfer(scope);
 assert.throws(()=>history.withTransfer(boundary,destination,5000,install=>{sourceCurrent=false;install(()=>true);sourceCurrent=true;throw Error('Durable audit write failed');}),/audit/);
 assert.match(port.read(),/Preserve me/);assert.equal(history.bind(destination,()=>true,5000).read(),'[]');assert.equal(history.transferCurrent(boundary),true);
 history.withTransfer(boundary,destination,5000,install=>{sourceCurrent=false;install(()=>true);});assert.match(history.bind(destination,()=>true,5000).read(),/Preserve me/);history.clear();
});

test('history cleanup also invalidates prepared empty handoffs',()=>{
 const history=new ConversationHistory(()=>1000),boundary=history.prepareTransfer(scope);assert.equal(history.transferCurrent(boundary),true);history.clear();assert.equal(history.transferCurrent(boundary),false);
});
