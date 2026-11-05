// Source-import actual stream + original Auth/DB/Policy/Journal/History owners.
// Only owned disposable synthetic state; no host/provider/model/media calls.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, chmodSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database, AssistantProfileRepository, ConversationHistoryRepository} from '@lifestream/storage-sqlite';
import {streamMessage} from '../src/runtime/inference.ts';
import {LocalAuthentication} from '../src/auth/local-auth.ts';
import {ConversationRetentionOwner} from '../src/runtime/conversation-retention-owner.ts';
import {ConversationRecoveryJournal} from '../src/admin/conversation-recovery-journal.ts';
import {bindDurableConversation} from '../src/runtime/conversation-history.ts';
import {ConversationHistory} from '../src/runtime/conversation.ts';
class Response extends EventEmitter {
  destroyed=false;writableEnded=false;output='';status=0;
  writeHead(status){this.status=status;}
  write(value){this.output+=value;return true;}
  end(){this.writableEnded=true;}
}
async function fixture(){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'text-lifecycle-source-'));chmodSync(root,0o700);const mask=process.umask(0o077);
  let database,authentication,owner,volatile;let now=Date.now();
  try {
    database=new Database({path:join(root,'test.sqlite')});database.migrate();const token=randomBytes(32).toString('hex');
    authentication=new LocalAuthentication(database,{stateDirectory:join(root,'auth'),installerToken:token,now:()=>now});
    owner=new ConversationRetentionOwner({database,authentication,authDirectory:join(root,'auth'),stateRoot:root,configuration:{mode:'syntheticOnly',retention:'untilDeletion'},now:()=>now});
    const login=await authentication.setup('synthetic-owner',randomBytes(32).toString('hex'),token,'http://127.0.0.1:43180');const context=authentication.hostSessionContext(login.session.sessionId),assistantId=randomUUID();
    new AssistantProfileRepository(database).create({schemaVersion:'2.0.0',assistantId,profileId:randomUUID(),revision:1,status:'draft',createdBy:context.principalId,createdAt:new Date().toISOString()});
    const current=()=>{try{authentication.assertCurrent(context,false);return true;}catch{return false;}};
    const scope={actorId:context.principalId,effectiveUserId:context.principalId,contextGeneration:context.effectiveContext.generation,authorityCurrent:current};
    now=Date.now()+1;owner.set(context,scope,{schemaVersion:'1.0.0',operation:'set',assistantId,expectedRevision:0,enabled:true,retention:'untilDeletion',bodyScope:'textAndTranscripts'});
    const repository=new ConversationHistoryRepository(database,{retention:owner,now:()=>++now});new ConversationRecoveryJournal(repository,join(root,'safety'));
    const conversationId=repository.mutate(scope,{schemaVersion:'1.0.0',operation:'create',operationId:randomUUID(),idempotencyKey:randomUUID(),payload:{assistantId,title:'Synthetic lifecycle'}}).conversationId;
    volatile=new ConversationHistory();const events=[],durable=bindDurableConversation(repository,scope,assistantId,conversationId,current,()=>++now);
    const port={...volatile.bind({principalId:context.principalId,sessionId:context.sessionId,conversationId,assistantId,relationshipId:null},current,Date.now()+30000),observe:event=>{events.push({...event});durable(event);}};
    const host={assistantId,isCurrent:current,conversation:port};
    return {database,authentication,context,owner,repository,scope,conversationId,events,port,host,current,run:async(provider,body={},response=new Response(),signal=new AbortController().signal)=>{await streamMessage(response,provider,{assistantId,userInput:'Synthetic request',...body},context.sessionId,signal,undefined,undefined,host);return response;},page:()=>repository.page(scope,conversationId,'older',50).entries,rows:()=>database.connection.prepare('SELECT speaker,state,content_state,retained_text FROM conversation_timeline ORDER BY ordinal').all(),close:()=>{volatile.clear();owner.close();database.close();process.umask(mask);rmSync(root,{recursive:true,force:true});}};
  } catch(error){volatile?.clear();owner?.close();database?.close();process.umask(mask);rmSync(root,{recursive:true,force:true});throw error;}
}

test('complete 32768-character reply uses original durable owner while original volatile dialogue stays16000',async()=>{
  const f=await fixture();try {
    const text='a'.repeat(16000)+'b'.repeat(16768);let iteratorClosed=false,metadataCalled=0;
    f.host.onReplyCompleted=async()=>{metadataCalled++;assert.equal(iteratorClosed,true);assert.equal(f.page().find(row=>row.speaker==='assistant').state,'completed');};
    const response=await f.run({async*generate(){try{yield{kind:'text',text:text.slice(0,16000)};yield{kind:'text',text:text.slice(16000)};yield{kind:'done'};}finally{iteratorClosed=true;}}});
    assert.match(response.output,/event: interaction.completed/);assert.doesNotMatch(response.output,/event: interaction.error/);assert.equal(metadataCalled,1);
    const rows=f.page();assert.equal(rows.length,2);const saved=rows.find(row=>row.speaker==='assistant');assert.equal(saved.state,'completed');assert.equal(saved.content.state,'retained');assert.equal(saved.content.text,text);
    const volatile=JSON.parse(f.port.read()).find(row=>row.role==='assistant');assert.equal(volatile.text.length,16000);assert.equal(volatile.truncated,true);
    assert.equal(f.events.filter(row=>row.role==='assistant'&&row.state==='completed').length,1);
  } finally {f.close();}
});

test('overflow after a retained partial and oversized user input become unavailable rather than completed retained prefixes',async()=>{
  const f=await fixture();try {
    const response=await f.run({async*generate(){yield{kind:'text',text:'p'.repeat(16000)};yield{kind:'text',text:'q'.repeat(16769)};yield{kind:'done'};}},{userInput:'u'.repeat(32769)});
    assert.match(response.output,/event: interaction.completed/);assert.doesNotMatch(response.output,/event: interaction.error/);
    const rows=f.page();assert.equal(rows.length,2);assert.ok(rows.every(row=>row.state==='completed'&&row.content.state==='unavailable'));
    assert.ok(f.rows().every(row=>row.retained_text===null));assert.equal(f.repository.privacyInventory().fences.length,1,'Original adapter permanently fences the former retained assistant prefix');
    assert.ok(f.events.filter(row=>row.text!==undefined).every(row=>row.text.length<=32768));assert.equal(f.events.find(row=>row.role==='user').text,undefined);
    const lastGenerating=f.events.filter(row=>row.state==='generating').at(-1);assert.equal(lastGenerating.text,undefined);assert.equal(JSON.parse(f.port.read()).find(row=>row.role==='assistant').text.length,16000);
  } finally {f.close();}
});

test('actual provider terminal controls one durable terminal: duplicate done completes once, missing/error/thrown provider does not',async()=>{
  for(const mode of ['duplicate','missing','error','throw']){
    const f=await fixture();try {
      const response=await f.run({async*generate(){yield{kind:'text',text:'Synthetic partial'};if(mode==='throw')throw Error('PRIVATE_TEST_DIAGNOSTIC');if(mode==='error')yield{kind:'error',error:{code:'fixture_failed',message:'Synthetic provider failure'}};if(mode==='duplicate'){yield{kind:'done'};yield{kind:'text',text:'PRIVATE_LATE'};yield{kind:'done'};}}});
      const row=f.page().find(value=>value.speaker==='assistant');assert.equal(row.state,mode==='duplicate'?'completed':'failed');assert.equal(row.content.text,'Synthetic partial');assert.doesNotMatch(response.output,/PRIVATE_TEST_DIAGNOSTIC|PRIVATE_LATE/);
      assert.equal([...response.output.matchAll(/event: interaction\.(completed|error)/g)].length,1);assert.match(response.output,mode==='duplicate'?/event: interaction.completed/:/event: interaction.error/);
      assert.equal(f.events.filter(value=>value.role==='assistant'&&['completed','failed','interrupted'].includes(value.state)).length,1);
    } finally {f.close();}
  }
});

test('real Auth loss retires existing assistant metadata only, never appends late text or erases until-deletion content',async()=>{
  const f=await fixture();try {
    const response=await f.run({async*generate(){yield{kind:'text',text:'Synthetic accepted partial'};f.authentication.logout(f.context);yield{kind:'text',text:'PRIVATE_LATE_AFTER_LOGOUT'};yield{kind:'done'};}});
    assert.match(response.output,/runtime_input_stale/);assert.doesNotMatch(response.output,/PRIVATE_LATE_AFTER_LOGOUT|event: interaction.completed/);
    const row=f.rows().find(value=>value.speaker==='assistant');assert.equal(row.state,'interrupted');assert.equal(row.retained_text,'Synthetic accepted partial');assert.equal(f.port.read(),'[]');
    f.port.observe({interactionId:randomUUID(),role:'assistant',modality:'text',state:'completed',text:'Denied new content'});assert.equal(f.rows().length,2);
  } finally {f.close();}
});

test('explicit cancellation keeps observed partial interrupted and never fabricates completed delivery',async()=>{
  const f=await fixture(),controller=new AbortController();try {
    const response=await f.run({async*generate(){yield{kind:'text',text:'Synthetic partial before abort'};controller.abort();yield{kind:'done'};}},{},new Response(),controller.signal);
    assert.match(response.output,/cancelled/);assert.doesNotMatch(response.output,/event: interaction.completed/);assert.equal(f.page().find(row=>row.speaker==='assistant').state,'interrupted');assert.equal(f.events.filter(row=>row.role==='assistant'&&row.state==='completed').length,0);
  } finally {f.close();}
});

test('completed durable metadata precedes optional metadata expiry/privacy loss and cannot be reclassified afterward',async()=>{
  const f=await fixture();try {
    let closed=false,called=0;
    f.host.onReplyCompleted=async()=>{called++;assert.equal(closed,true);assert.equal(f.page().find(row=>row.speaker==='assistant').state,'completed');f.authentication.logout(f.context);throw Error('Optional metadata expired');};
    const response=await f.run({async*generate(){try{yield{kind:'text',text:'Synthetic complete reply'};yield{kind:'done'};}finally{closed=true;}}});
    assert.equal(called,1);assert.match(response.output,/event: interaction.completed/);assert.doesNotMatch(response.output,/event: interaction.error/);assert.equal(f.rows().find(row=>row.speaker==='assistant').state,'completed');assert.equal(f.events.filter(row=>row.role==='assistant'&&row.state==='completed').length,1);assert.equal(f.events.filter(row=>row.role==='assistant'&&row.state==='interrupted').length,0);
  } finally {f.close();}
});

test('optional observer failures preserve primary delivery; sink closure cannot record unwritten text or completion',async()=>{
  const f=await fixture();try {
    f.host.conversation={...f.port,observe:()=>{throw Error('Owned unavailable observer');}};
    const response=await f.run({async*generate(){yield{kind:'text',text:'Original delivery survives bookkeeping'};yield{kind:'done'};}});assert.match(response.output,/event: interaction.completed/);assert.doesNotMatch(response.output,/event: interaction.error/);assert.equal(f.rows().length,0);
  } finally {f.close();}
  const g=await fixture();try {
    class ClosedSink extends Response{write(value){if(value.startsWith('event: message.delta')){this.destroyed=true;return false;}return super.write(value);}}
    const response=await g.run({async*generate(){yield{kind:'text',text:'NOT_WRITTEN_TO_SINK'};yield{kind:'done'};}},{},new ClosedSink());assert.doesNotMatch(response.output,/NOT_WRITTEN_TO_SINK|event: interaction.completed/);const row=g.rows().find(value=>value.speaker==='assistant');assert.equal(row.state,'interrupted');assert.equal(row.retained_text,null);assert.equal(g.events.filter(row=>row.state==='generating').length,0);
  } finally {g.close();}
});
