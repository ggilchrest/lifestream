// Run after the normal public build. Only disposable SQLite state is used.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Database,ConversationHistoryRepository} from '@lifestream/storage-sqlite';
import {unifiedDesktopContractPin} from '@lifestream/contracts/unified-desktop-contracts';
import {bindDurableConversation,executeConversationHistory} from '../dist/runtime/conversation-history.js';
import {ConversationHistory,observeConversation} from '../dist/runtime/conversation.js';
import {ConversationRecoveryJournal} from '../dist/admin/conversation-recovery-journal.js';

test('canonical adapter enforces its native envelope and lifecycle ownership without a retention grant or changes to volatile dialogue',()=>{
 const root=mkdtempSync(join(tmpdir(),'canonical-history-adapter-'));
 let database:Database|undefined;const volatile=new ConversationHistory(()=>1000);
 try{
  database=new Database({path:join(root,'state.sqlite')});database.migrate();
  let current=true,now=Date.now();const actor=randomUUID(),assistantId=randomUUID();
  const scope={actorId:actor,effectiveUserId:actor,contextGeneration:1,authorityCurrent:()=>current};
  const repository=new ConversationHistoryRepository(database,{now:()=>now});
  const journal=new ConversationRecoveryJournal(repository,join(root,'safety'));assert.equal(journal.current(),true);
  const producerPin=unifiedDesktopContractPin('conversation-history');
  const request={schemaVersion:'1.0.0',operation:'create',operationId:randomUUID(),idempotencyKey:randomUUID(),payload:{assistantId,title:'Synthetic canonical chat'}};
  const envelope={producerPin,request};
  assert.equal(executeConversationHistory(repository,scope,{...envelope,extra:true},()=>true).status,422);
  assert.equal(executeConversationHistory(repository,scope,{...envelope,producerPin:{...producerPin,digest:'0'.repeat(64)}},()=>true).status,409);
  assert.equal(executeConversationHistory(repository,scope,{...envelope,request:{...request,schemaVersion:'0.0.0'}},()=>true).status,422);
  assert.equal(executeConversationHistory(repository,scope,envelope,()=>false).status,403);
  const created=executeConversationHistory(repository,scope,envelope,id=>id===assistantId);assert.equal(created.status,200);
  const conversationId=String((created.body.result as {conversationId:string}).conversationId);
  const port={...volatile.bind({principalId:actor,sessionId:randomUUID(),assistantId,conversationId,relationshipId:null},()=>current,5000),observe:bindDurableConversation(repository,scope,assistantId,conversationId,()=>current,()=>++now)};
  const human=randomUUID(),assistant=randomUUID();
  port.remember({interactionId:human,role:'user',text:'Accepted volatile text'});
  observeConversation(port,{interactionId:human,role:'user',modality:'text',state:'accepted',text:'Synthetic typed body without consent'});
  observeConversation(port,{interactionId:human,role:'user',modality:'text',state:'completed'});
  observeConversation(port,{interactionId:assistant,role:'assistant',modality:'text',state:'generating',text:'Synthetic partial reply without consent'});
  assert.equal(JSON.parse(port.read())[0].text,'Accepted volatile text');
  let page=repository.page(scope,conversationId,'older',50);
  assert.equal(page.entries.length,2);assert.ok(page.entries.every(entry=>entry.content.state==='unavailable'));
  assert.equal(page.entries.find(entry=>entry.turnId===human)?.state,'completed');
  assert.throws(()=>repository.read({...scope,actorId:randomUUID(),effectiveUserId:randomUUID()},conversationId));
  current=false;
  observeConversation(port,{interactionId:assistant,role:'assistant',modality:'text',state:'completed',text:'Late private reply must not enter history'});
  observeConversation(port,{interactionId:randomUUID(),role:'user',modality:'text',state:'accepted',text:'Denied new entry'});
  assert.equal(port.read(),'[]');
  assert.equal(database.connection.prepare('SELECT COUNT(*) AS n FROM conversation_timeline').get()!.n,2);
  assert.equal(database.connection.prepare('SELECT state FROM conversation_timeline WHERE turn_id=? AND speaker=?').get(assistant,'assistant')!.state,'interrupted');
  assert.equal(database.connection.prepare('SELECT COUNT(*) AS n FROM conversation_timeline WHERE retained_text IS NOT NULL').get()!.n,0);
  current=true;port.remember({interactionId:randomUUID(),role:'user',text:'Retired volatile owner cannot revive'});assert.equal(port.read(),'[]');
  assert.doesNotThrow(()=>observeConversation({read:()=>'',remember:()=>{},observe:()=>{throw Error('Synthetic bookkeeping failure');}},{interactionId:randomUUID(),role:'assistant',modality:'text',state:'failed'}));
  const denied={producerPin,request:{schemaVersion:'1.0.0',operation:'read',operationId:randomUUID(),payload:{conversationId}}};
  assert.equal(executeConversationHistory(repository,scope,denied,()=>false).status,403);
 }finally{volatile.clear();database?.close();rmSync(root,{recursive:true,force:true});}
});
