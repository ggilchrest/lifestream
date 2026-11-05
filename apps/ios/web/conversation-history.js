import {admitUnifiedDesktopProducer,unifiedDesktopConsumerPins} from '../../daily-web/owners/unified-desktop-contracts.js';
const pin=unifiedDesktopConsumerPins['conversation-history'];
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const stale=()=>Error('Conversation or privacy state changed.');

// All authority and retention decisions belong to the server. This owner holds
// only bounded, foreground presentation state; it never retries an unknown write.
export function createMobileHistory({api,owner,current,afterSelect=async()=>{},id=()=>crypto.randomUUID()}){
 let generation=0,pending=null;
 const invalidate=()=>{generation++;};
 const ticket=()=>{const value=owner();if(!value||!uuid(value.assistantId)||!uuid(value.principalId))throw stale();return {generation,value};};
 const valid=t=>t.generation===generation&&current(t.value);
 const check=t=>{if(!valid(t))throw stale();};
 const envelope=(operation,payload,write=false)=>({producerPin:pin,request:{schemaVersion:'1.0.0',operation,operationId:id(),...(write?{idempotencyKey:id()}:{}),payload}});
 const call=async(body,t)=>{const response=await api('/api/runtime/v1/conversations',body);check(t);if(!admitUnifiedDesktopProducer('conversation-history',response?.producerPin))throw Error('Conversation history is incompatible.');if(response.error)throw Error('Conversation history is unavailable.');return response.result;};
 const summary=(v,t)=>v&&uuid(v.conversationId)&&v.assistantId===t.value.assistantId&&v.effectiveUserId===t.value.principalId&&typeof v.title==='string'&&v.title.length<=160;
 async function timeline(conversationId,cursor,t){
  const page=await call(envelope('page',{conversationId,direction:'older',pageSize:50,...(cursor?{cursor}:{})}),t);
  if(page?.conversationId!==conversationId||!Array.isArray(page.entries)||page.entries.length>50||page.entries.some(e=>e.conversationId!==conversationId||e.effectiveUserId!==t.value.principalId||!uuid(e.entryId)||!['human','assistant','system'].includes(e.speaker)||!['text','voice'].includes(e.modality)||!['retained','redacted','unavailable'].includes(e.content?.state)||e.content.state==='retained'&&(typeof e.content.text!=='string'||e.content.text.length>32768)))throw Error('Invalid conversation history.');
  const next=page.nextCursor??null;if(next!==null&&(typeof next!=='string'||next.length>2048||next===cursor))throw Error('Invalid history cursor.');return {entries:page.entries,cursor:next};
 }
 async function older(conversationId,cursor){const t=ticket();if(!uuid(conversationId)||typeof cursor!=='string'||!cursor||cursor.length>2048)throw Error('No older messages are available.');const session=await api('/api/runtime/v1/session-context');check(t);if(session.selectedConversation?.conversationId!==conversationId||!summary(session.selectedConversation,t))throw stale();return timeline(conversationId,cursor,t);}
 async function listAll(){
  const t=ticket(),items=[],ids=new Set();
  for(const filter of ['pinned','recent','archived']){let cursor=null;const cursors=new Set();do{const result=await call(envelope('list',{assistantId:t.value.assistantId,filter,pageSize:50,...(cursor?{cursor}:{})}),t);if(!Array.isArray(result?.conversations)||result.conversations.length>50||!result.conversations.every(v=>summary(v,t)))throw Error('Invalid conversation list.');for(const item of result.conversations)if(!ids.has(item.conversationId)){ids.add(item.conversationId);items.push(item);if(items.length>1000)throw Error('Conversation list is too large.');}cursor=result.nextCursor??null;if(cursor!==null&&(typeof cursor!=='string'||cursor.length>2048||cursors.has(cursor)))throw Error('Invalid history cursor.');if(cursor)cursors.add(cursor);}while(cursor);}
  return items;
 }
 async function view(){
  const t=ticket(),session=await api('/api/runtime/v1/session-context');check(t);
  if(session.ended||!Number.isSafeInteger(session.revision))throw stale();
  const conversations=[],seen=new Set();let cursor=null;
  do{const list=await call(envelope('list',{assistantId:t.value.assistantId,filter:'recent',pageSize:50,...(cursor?{cursor}:{})}),t);
   if(!Array.isArray(list?.conversations)||list.conversations.length>50||!list.conversations.every(v=>summary(v,t))||conversations.length+list.conversations.length>1000)throw Error('Invalid conversation list.');
   conversations.push(...list.conversations);cursor=list.nextCursor??null;if(cursor!==null&&(typeof cursor!=='string'||cursor.length>2048||seen.has(cursor)))throw Error('Invalid conversation list cursor.');if(cursor)seen.add(cursor);
  }while(cursor);
  const candidate=session.selectedConversation,selected=candidate&&summary(candidate,t)?candidate:null;
  if(candidate&&candidate.effectiveUserId!==t.value.principalId)throw Error('The selected conversation belongs to a different account.');
  const page=selected?await timeline(selected.conversationId,null,t):{entries:[],cursor:null};
  let reconciliation=null,reconciledConversationId=null;
  if(pending?.kind==='creation'){
   const result=await call(envelope('getOperation',{targetOperationId:pending.operationId}),t);
   if(result?.operationId!==pending.operationId||!['completed','rejected','accepted','unknown'].includes(result.status))throw Error('Conversation creation status could not be confirmed.');
   if(result.status==='completed'){
    if(!uuid(result.conversationId)||!conversations.some(item=>item.conversationId===result.conversationId))throw Error('Created conversation could not be confirmed.');
    reconciliation='created';reconciledConversationId=result.conversationId;pending=null;
   }else if(result.status==='rejected'||result.status==='unknown'&&pending.definitiveResponse){reconciliation='not_created';pending=null;}
   else reconciliation='pending';
  }else if(pending?.kind==='selection'){
   if(selected?.conversationId===pending.conversationId){reconciliation='selected';pending=null;}
   else if(pending.definitiveResponse){reconciliation='not_selected';pending=null;}
   else reconciliation='pending';
  }
  return {session,list:conversations,selected,entries:page.entries,cursor:page.cursor,reconciliation,reconciledConversationId};
 }
 async function select(conversationId){
  if(pending)throw Error('Reopen conversations to confirm the previous change.');const t=ticket();if(!uuid(conversationId))throw Error('Choose a conversation.');
  const session=await api('/api/runtime/v1/session-context');check(t);if(!Number.isSafeInteger(session.revision)||session.ended)throw stale();
  pending={kind:'selection',conversationId};
  let result;try{result=await api('/api/runtime/v1/conversations/select',{producerPin:pin,conversationId,assistantId:t.value.assistantId,expectedSessionRevision:session.revision});}catch(error){if(pending?.kind==='selection'&&Number.isInteger(error.status)&&error.status>=400&&error.status<500&&![408,425].includes(error.status))pending.definitiveResponse=true;throw error;}check(t);
  if(!admitUnifiedDesktopProducer('conversation-history',result?.producerPin)||result.conversationId!==conversationId||!Number.isSafeInteger(result.sessionRevision)||result.sessionRevision<session.revision||(!result.audienceRenewalRequired&&!summary(result.conversation,t)))throw Error('Conversation selection could not be confirmed.');
  await afterSelect();check(t);const state=await view();if(state.selected?.conversationId!==conversationId){pending={kind:'selection',conversationId};throw Error('The selected conversation could not be confirmed.');}pending=null;return state;
 }
 async function create(title){
  if(pending)throw Error('Reopen conversations to confirm the previous change.');const t=ticket();title=title.trim();if(!title||title.length>160)throw Error('Enter a conversation name.');
  const body=envelope('create',{assistantId:t.value.assistantId,title},true);pending={kind:'creation',operationId:body.request.operationId};
  let result;try{result=await call(body,t);}catch(error){if(pending?.kind==='creation'&&Number.isInteger(error.status)&&error.status>=400&&error.status<500&&![408,425].includes(error.status))pending.definitiveResponse=true;throw error;}if(result?.status!=='completed'||!uuid(result.conversationId))throw Error('Conversation creation could not be confirmed.');
  pending=null;return select(result.conversationId);
 }
 return {view,listAll,select,create,older,invalidate,isPending:()=>!!pending};
}
