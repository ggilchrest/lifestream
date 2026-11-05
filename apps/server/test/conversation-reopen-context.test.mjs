import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rmSync,writeFileSync} from 'node:fs';
import {fixture,wait,settle,auditFixtureRoot,isolatedAudit} from './fixtures/personal-phone-host.mjs';
import {SglangInferenceProvider} from '../../../packages/providers-sglang/src/provider.ts';
import {boundedConversationContext,conversationLimits} from '../src/runtime/conversation.ts';
import {unifiedDesktopContractPin} from '../../../packages/contracts/dist/unified-desktop-contracts.js';
const summaries=[];
after(()=>{isolatedAudit.close();rmSync(auditFixtureRoot,{recursive:true,force:true});if(process.env.CONTEXT_SHAPE_EXPORT)writeFileSync(process.env.CONTEXT_SHAPE_EXPORT,JSON.stringify({syntheticOnly:true,noRealProviderRequests:true,summaries},null,2)+'\n');});
test('actual Auth/selection/voice assembly retains framing across blank and rich Markdown history',async()=>{
 const f=await fixture({endpointClass:'personalCompanion',personalPhoneAccess:{mode:'authenticatedSession',authenticatedAfterMs:0}});const mapper=new SglangInferenceProvider({endpoint:'http://synthetic.invalid',model:'synthetic'});let malformed=false,typedPrior=false;
 try{
  const retention=await f.request('/api/runtime/v1/conversation-retention',{assistantId:f.assistantId,schemaVersion:'1.0.0',operation:'set',expectedRevision:0,enabled:true,retention:'untilDeletion',bodyScope:'textAndTranscripts'});assert.equal(retention.status,200);
  f.app.providers.inference={async*generate(request){
   const body=mapper.chatBody(request),policy=request.sections.find(s=>s.kind==='policy'),conversation=request.sections.find(s=>s.kind==='conversation');
   if(policy?.sourceRef!=='policy:spoken-v1')typedPrior=conversation.content.includes('**Synthetic heading**')&&!conversation.content.includes(request.scope.interactionId);
   if(policy?.sourceRef==='policy:spoken-v1')summaries.push({scenario:malformed?'synthetic-unframed-output':summaries.length===0?'initial-blank':summaries.length===1?'new-selected-blank':'selected-rich-history',policyRef:policy.sourceRef,voiceFramingPresent:policy.content.includes('voice-response/1 JSON lines only'),headerInstructionPresent:policy.content.includes('First emit {"version":"voice-response/1"}'),policyTrusted:policy.trusted,systemPolicyPresent:body.messages[0].content.includes('voice-response/1 JSON lines only'),messageRoles:body.messages.map(x=>x.role),disableThinking:body.chat_template_kwargs?.enable_thinking===false,responseFormat:body.response_format===undefined?'absent':'present',conversationBytes:Buffer.byteLength(conversation.content),containsSyntheticMarkdownHistory:conversation.content.includes('**Synthetic heading**'),assistantScopeMatches:request.scope.assistantId===f.assistantId,currentInputAppearsInPriorContext:conversation.content.includes(request.scope.interactionId)});
   yield {kind:'text',text:malformed?'**Synthetic unframed heading**\nSynthetic suggestion.':JSON.stringify({version:'voice-response/1'})+'\n'+JSON.stringify({channel:'speech',text:'A safe synthetic spoken sentence.'})+'\n'+JSON.stringify({channel:'display',text:'**Synthetic heading**\n\nA synthetic Markdown supplement.'})+'\n'};yield {kind:'done'};
  }};
  const run=async()=>{const voice=await f.connect(f.owner.contextRef,{continuationMode:'ordered-v1'});await voice.start();voice.turn();await voice.complete();voice.socket.close();await settle();};
  await run();
  const created=await f.request('/api/runtime/v1/conversations',{producerPin:unifiedDesktopContractPin('conversation-history'),request:{schemaVersion:'1.0.0',operation:'create',operationId:randomUUID(),idempotencyKey:randomUUID(),payload:{assistantId:f.assistantId,title:'Synthetic blank selection'}}});assert.equal(created.status,200);const blank=(await created.json()).result.conversationId;await f.select(blank);await run();await f.select(f.conversationId);await run();
  assert.equal(summaries.length,3);for(const row of summaries){assert.equal(row.voiceFramingPresent,true);assert.equal(row.headerInstructionPresent,true);assert.equal(row.systemPolicyPresent,true);assert.equal(row.policyTrusted,true);assert.equal(row.disableThinking,true);assert.equal(row.assistantScopeMatches,true);assert.equal(row.currentInputAppearsInPriorContext,false);assert.deepEqual(row.messageRoles,['system','user']);}
  assert.equal(summaries[1].containsSyntheticMarkdownHistory,false);assert.equal(summaries[2].containsSyntheticMarkdownHistory,true);
  await f.restart();await run();assert.equal(summaries.at(-1).containsSyntheticMarkdownHistory,true);assert.equal(summaries.at(-1).currentInputAppearsInPriorContext,false);
  const typed=await f.request('/api/runtime/v1/messages',{assistantId:f.assistantId,conversationId:f.conversationId,userInput:'Synthetic current input exactly once'});assert.equal(typed.status,200,await typed.clone().text());await typed.text();assert.equal(typedPrior,true);assert.equal(f.rows().filter(x=>x.speaker==='human'&&x.retained_text==='Synthetic current input exactly once').length,1);
  const beforeTts=f.calls.tts;malformed=true;const bad=await f.connect(f.owner.contextRef,{continuationMode:'ordered-v1'});await bad.start();bad.turn();await wait(()=>bad.events.some(x=>x.event?.payload.type==='terminal'));const terminal=bad.events.find(x=>x.event?.payload.type==='terminal').event.payload;assert.equal(terminal.state,'failed');assert.deepEqual(terminal.failureOrigin,{stage:'framing',code:'invalid_response'});assert.equal(f.calls.tts,beforeTts);assert.ok(!bad.events.some(x=>x.type==='audio'));summaries.push({scenario:'synthetic-rejection',failureOrigin:terminal.failureOrigin,ttsInvoked:false,unframedControlTextSpoken:false});
 }finally{await f.close();}
});

test('nonself host gate preserves the baseline fork merge and never invokes self history import',async()=>{
 const f=await fixture();try{
  const context=f.app.localAuth.hostSessionContext(f.owner.sessionId),access=f.app.historyReadAccess(context);
  const imported=[{interactionId:randomUUID(),role:'assistant',state:'completed',text:'Synthetic delegated fork context'}];let forkReads=0;
  // Model an already-authorized delegated access at this host boundary. Existing
  // authorization/currentness callbacks stay real; no delegated authority is granted.
  const repository=new Proxy(access.repository,{get(target,key){if(key==='selectedContext')return()=>{throw Error('Self-only import reached for delegated access');};if(key==='forkContext')return()=>{forkReads++;return imported;};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
  const delegated={...access,repository,ordinarySelf:()=>false};
  const port=f.app.conversationPort(f.assistantId,undefined,context,false,{access:delegated,conversationId:f.conversationId});
  const live={interactionId:randomUUID(),role:'user',text:'Synthetic admitted volatile context'};port.remember(live);
  const value=JSON.parse(port.read());assert.deepEqual(value,[...imported,live]);assert.equal(forkReads,1);
 }finally{await f.close();}
});


test('retained context excludes redacted, disabled, unrelated, stale and revoked scope',async()=>{
 const f=await fixture();try{
  const voice=await f.connect(f.owner.contextRef,{continuationMode:'ordered-v1'});await voice.start();voice.turn();await voice.complete();voice.socket.close();await settle();
  const port=()=>{const context=f.app.localAuth.hostSessionContext(f.owner.sessionId),access=f.app.historyReadAccess(context);return {access,value:f.app.conversationPort(f.assistantId,undefined,context,true,{access,conversationId:f.conversationId})};};
  let saved=port();assert.equal(JSON.parse(saved.value.read()).length,2);
  const entries=await f.page(),human=entries.find(x=>x.speaker==='human');saved.access.repository.redact(saved.access.scope,f.conversationId,human.entryId,human.revision,'redacted');
  assert.equal(saved.value.read(),'[]');saved=port();assert.ok(!JSON.parse(saved.value.read()).some(x=>x.interactionId===human.turnId&&x.role==='user'));
  const other=await f.otherConversation();assert.throws(()=>saved.access.repository.selectedContext(saved.access.scope,other.conversationId,f.assistantId));
  assert.throws(()=>saved.access.repository.selectedContext({...saved.access.scope,actorId:randomUUID()},f.conversationId,f.assistantId));
  await f.select(other.conversationId,other.assistantId);assert.equal(saved.value.read(),'[]');await f.select(f.conversationId);
  const disabled=await f.request('/api/runtime/v1/conversation-retention',{assistantId:f.assistantId,schemaVersion:'1.0.0',operation:'set',expectedRevision:1,enabled:false,retention:'untilDeletion',bodyScope:'textAndTranscripts'});assert.equal(disabled.status,200,await disabled.clone().text());
  saved=port();assert.equal(saved.value.read(),'[]');
  const revoked=await f.request('/api/auth/v1/permissions',{principalId:f.owner.principalId,assistantId:f.assistantId,administer:false});assert.equal(revoked.status,200);assert.equal(saved.value.read(),'[]');
 }finally{await f.close();}
});


test('retained and volatile merge deduplicates and enforces character, entry and UTF-8 byte budgets',()=>{
 const turns=Array.from({length:30},(_,i)=>({interactionId:String(i),role:'user',text:'Synthetic '+i}));
 let value=JSON.parse(boundedConversationContext(turns,[{...turns[29],text:'Newest synthetic replacement'}]));assert.equal(value.length,20);assert.equal(value.at(-1).text,'Newest synthetic replacement');assert.equal(value.filter(x=>x.interactionId==='29').length,1);
 const oversized=Array.from({length:20},(_,i)=>({interactionId:String(i),role:'assistant',text:'🌟'.repeat(20000)}));
 const wire=boundedConversationContext(oversized,[],[{kind:'synthetic',value:'bounded feedback'}]);assert.ok(Buffer.byteLength(wire)<=conversationLimits.bytesPerScope);value=JSON.parse(wire).turns;assert.ok(value.length>0);assert.ok(value.every(x=>x.text.length<=conversationLimits.entryCharacters));assert.ok(value.every(x=>x.truncated));
 assert.equal(boundedConversationContext(turns,[],['x'.repeat(70000)]),'[]');
});
