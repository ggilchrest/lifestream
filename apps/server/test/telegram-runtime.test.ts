import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Database,ChannelSubscriptionRepository,TelegramPairingRepository} from '@lifestream/storage-sqlite';
import {TelegramChannelRuntime,type TelegramConversation} from '../src/channels/telegram-runtime.ts';
import type {TelegramMessage} from '../src/channels/telegram-api.ts';
function fixture(){
 const db=new Database({path:':memory:'});db.migrate();const owner=randomUUID(),person=randomUUID(),assistant=randomUUID();for(const [id,name,isOwner] of [[owner,'owner',1],[person,'person',0]] as const)db.connection.prepare('INSERT INTO local_accounts(principal_id,username,owner,password_verifier,created_at) VALUES (?,?,?,?,?)').run(id,name,isOwner,'synthetic',Date.now());const subscriptions=new ChannelSubscriptionRepository(db),pairs=new TelegramPairingRepository(db);
 const pair=(who:string,chat:string)=>{const s=subscriptions.apply(assistant,owner,{operation:'create',principalId:who,channel:'telegram',label:'Synthetic',requestedConversations:true,requestedAlerts:true});const i=pairs.issue(assistant,s.id,who,1,'9999');pairs.claim('9999',i.challenge,{chatId:chat,userId:chat,privateChat:true,isBot:false,sentAt:Date.now()});const c=pairs.inspect(assistant,s.id,who),p=pairs.confirm(assistant,s.id,who,c.revision,c.claimId!);pairs.enable(assistant,s.id,who,p.revision,true,false);return s;};
 const one=pair(owner,'1234'),two=pair(person,'5678');let batch:TelegramMessage[]=[],enabled=true,unknown=false;let sends:{chat:string;text:string}[]=[];const calls:string[]=[],inputs:{principal:string;text:string}[]=[];
 const api={verify:async()=>{calls.push('verify');},updates:async(offset:number)=>{calls.push('poll');const messages=batch;batch=[];return {messages,nextOffset:Math.max(offset,...messages.map(m=>m.updateId+1))};},send:async(chat:string,text:string)=>{sends.push({chat,text});return unknown?{status:'unknown' as const}:{status:'accepted' as const,messageId:42};}};
 const conversation:TelegramConversation=async(b,m)=>{inputs.push({principal:b.principalId,text:m.text});return {text:'Synthetic reply',current:()=>true};};
 const message=(n:number,chat='1234',text='Synthetic question'):TelegramMessage=>({updateId:n,messageId:n+1,chatId:chat,userId:chat,sentAt:Date.now(),text});
 return {db,pairs,subscriptions,one,two,owner,person,assistant,api,conversation,inputs,calls,message,get sends(){return sends;},setBatch:(b:TelegramMessage[])=>batch=b,enable:(v:boolean)=>enabled=v,unknown:()=>unknown=true,options:()=>({database:db,botId:'9999',api,enabled:()=>enabled,conversation}),states:()=>db.connection.prepare('SELECT update_id,state,receipt_id FROM telegram_deliveries ORDER BY update_id').all(),clearSends:()=>sends=[]};
}
test('paired private messages route to each subscriber without admin grants; durable cursor and ledger prevent replay',async()=>{
 const f=fixture(),runtime=new TelegramChannelRuntime(f.options());try{assert.deepEqual(f.calls,[]);f.enable(false);assert.equal(await runtime.pollOnce(),false);assert.deepEqual(f.calls,[]);f.enable(true);f.setBatch([f.message(1),f.message(2,'5678'),f.message(3,'7777'),{...f.message(4),sentAt:Date.now()-10_000}]);assert.equal(await runtime.pollOnce(),true);await runtime.drain();assert.deepEqual(f.inputs.map(i=>i.principal).sort(),[f.owner,f.person].sort());assert.deepEqual(f.sends.map(s=>s.chat).sort(),['1234','5678']);assert.equal(f.states()[2]!.state,'ignored');assert.equal(f.states()[3]!.state,'ignored');assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM local_assistant_permissions').get()!.n,0);await runtime.close();
 const restarted=new TelegramChannelRuntime(f.options());try{f.setBatch([f.message(1)]);assert.equal(await restarted.pollOnce(),false);await restarted.drain();assert.equal(f.sends.length,2);}finally{await restarted.close();}
 }finally{await runtime.close();f.db.close();}
});
test('stop and permission revocation cancel in-flight generation; another subscriber remains independent',async()=>{
 const f=fixture();const started:string[]=[],aborted:string[]=[];const conversation:TelegramConversation=(b,_m,signal)=>new Promise(resolve=>{started.push(b.principalId);signal.addEventListener('abort',()=>{aborted.push(b.principalId);resolve({text:'Never deliver after cancel',current:()=>true});},{once:true});});const runtime=new TelegramChannelRuntime({...f.options(),conversation});try{
 f.setBatch([f.message(1),f.message(2,'5678')]);await runtime.pollOnce();assert.equal(started.length,2);f.setBatch([f.message(3,'1234','/stop')]);await runtime.pollOnce();await new Promise(r=>setImmediate(r));assert.deepEqual(aborted,[f.owner]);f.subscriptions.apply(f.assistant,f.owner,{operation:'disable',id:f.two.id,expectedRevision:1});runtime.reconcile();await runtime.drain();assert.equal(aborted.length,2);assert.deepEqual(f.sends,[]);assert.ok(f.states().every(s=>s.state==='cancelled'));
 }finally{await runtime.close();f.db.close();}
});
test('uncertain output and interrupted sends never automatically retry after restart',async()=>{
 const f=fixture(),runtime=new TelegramChannelRuntime(f.options());try{f.unknown();f.setBatch([f.message(1)]);await runtime.pollOnce();await runtime.drain();assert.equal(f.states()[0]!.state,'unknown');assert.equal(f.sends.length,1);await runtime.close();f.db.connection.prepare("INSERT INTO telegram_deliveries VALUES('9999',2,?,'sending',NULL,?)").run(f.one.id,Date.now());const restarted=new TelegramChannelRuntime(f.options());try{assert.equal(f.states()[1]!.state,'unknown');f.setBatch([f.message(2)]);await restarted.pollOnce();await restarted.drain();assert.equal(f.sends.length,1);}finally{await restarted.close();}
 }finally{await runtime.close();f.db.close();}
});
test('replacement host fences previous generation and private pairing claims send no chat acknowledgment',async()=>{
 const f=fixture();let abort=false;const runtime=new TelegramChannelRuntime({...f.options(),conversation:async(_b,_m,signal)=>new Promise(resolve=>signal.addEventListener('abort',()=>{abort=true;resolve(undefined);},{once:true}))});try{f.setBatch([f.message(1)]);await runtime.pollOnce();const replacement=new TelegramChannelRuntime(f.options());try{runtime.reconcile();await runtime.drain();assert.equal(abort,true);assert.deepEqual(f.sends,[]);
 const d=f.subscriptions.apply(f.assistant,f.owner,{operation:'create',principalId:f.person,channel:'telegram',label:'Synthetic next chat',requestedConversations:true,requestedAlerts:true}),issued=f.pairs.issue(f.assistant,d.id,f.person,1,'9999');f.setBatch([f.message(2,'7777','/start '+issued.challenge)]);await replacement.pollOnce();assert.equal(f.pairs.inspect(f.assistant,d.id,f.person).state,'claimed');assert.deepEqual(f.sends,[]);assert.equal(f.states().at(-1)!.state,'claimed');
 }finally{await replacement.close();}
 }finally{await runtime.close();f.db.close();}
});

test('prepared privacy context withdrawal aborts a pending send and cannot commit dialogue or replay after restart',async()=>{
 const f=fixture();let valid=true,started=()=>{},signal!:AbortSignal,accepted=0;const entered=new Promise<void>(r=>started=r);
 const api={...f.api,send:async(_chat:string,_text:string,s:AbortSignal)=>{signal=s;started();await new Promise<void>(resolve=>s.addEventListener('abort',()=>resolve(),{once:true}));return {status:'unknown' as const};}},conversation:TelegramConversation=async()=>({text:'Synthetic restricted reply',current:()=>valid,accepted:()=>{accepted++;}}),runtime=new TelegramChannelRuntime({...f.options(),api,conversation});
 try{f.setBatch([f.message(1)]);await runtime.pollOnce();await entered;valid=false;runtime.reconcile();assert.equal(signal.aborted,true);await runtime.drain();assert.equal(accepted,0);assert.equal(f.states()[0]!.state,'unknown');await runtime.close();const restarted=new TelegramChannelRuntime(f.options());try{f.setBatch([f.message(1)]);await restarted.pollOnce();await restarted.drain();assert.deepEqual(f.sends,[]);assert.equal(f.states()[0]!.state,'unknown');}finally{await restarted.close();}}
 finally{await runtime.close();f.db.close();}
});
