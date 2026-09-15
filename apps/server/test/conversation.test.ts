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
