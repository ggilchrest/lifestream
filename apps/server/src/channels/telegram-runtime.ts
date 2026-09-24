import {randomUUID} from 'node:crypto';
import {TelegramPairingRepository,type Database,type TelegramBinding} from '@lifestream/storage-sqlite';
import type {TelegramBotApi,TelegramMessage} from './telegram-api.ts';

export type TelegramReply={text:string;current:()=>boolean;accepted?:()=>void};
export type TelegramConversation=(binding:TelegramBinding,message:TelegramMessage,signal:AbortSignal)=>Promise<TelegramReply|undefined>;
type Job={replyCurrent?:()=>boolean;binding:TelegramBinding;message:TelegramMessage;controller:AbortController;work:Promise<void>;controlReply?:TelegramReply};
type State='reserved'|'sending'|'accepted'|'rejected'|'unknown'|'cancelled'|'ignored'|'claimed';
/** Private chat ingress and delivery accounting. The composition must supply a
 * principal-scoped conversation port; no administrative browser session is minted.
 * Nothing starts until the caller enables and explicitly polls/starts this host. */
export class TelegramChannelRuntime {
 private readonly db:Database;
 private readonly api:Pick<TelegramBotApi,'verify'|'updates'|'send'>;
 private readonly botId:string;
 private readonly enabled:()=>boolean;
 private readonly conversation:TelegramConversation;
 private readonly control:((binding:TelegramBinding,message:TelegramMessage)=>TelegramReply|undefined)|undefined;
 private readonly pairs:TelegramPairingRepository;
 private readonly jobs=new Map<string,Job>();
 private readonly controller=new AbortController();
 private readonly generation=randomUUID();
 private verified=false;private polling=false;private closed=false;
 private timer:ReturnType<typeof setInterval>|undefined;
 private guard:ReturnType<typeof setInterval>|undefined;
 constructor(options:{database:Database;api:Pick<TelegramBotApi,'verify'|'updates'|'send'>;botId:string;enabled:()=>boolean;conversation:TelegramConversation;control?:(binding:TelegramBinding,message:TelegramMessage)=>TelegramReply|undefined}){
  if(!/^[1-9][0-9]{0,15}$/.test(options.botId)||!Number.isSafeInteger(Number(options.botId)))throw Error('Telegram runtime configuration invalid');
  this.db=options.database;this.api=options.api;this.botId=options.botId;this.enabled=options.enabled;this.conversation=options.conversation;this.control=options.control;this.pairs=new TelegramPairingRepository(this.db);
  this.db.connection.prepare('INSERT INTO telegram_poll_state VALUES(?,0,?) ON CONFLICT(bot_id) DO UPDATE SET generation=excluded.generation').run(this.botId,this.generation);
  this.db.connection.prepare("UPDATE telegram_deliveries SET state=CASE WHEN state='sending' THEN 'unknown' ELSE 'cancelled' END,updated_at=? WHERE bot_id=? AND state IN ('reserved','sending')").run(Date.now(),this.botId);
 }
 private available(){try{return !this.closed&&!this.controller.signal.aborted&&this.enabled()&&this.db.connection.prepare('SELECT generation FROM telegram_poll_state WHERE bot_id=?').get(this.botId)?.generation===this.generation;}catch{return false;}}
 get busy(){return this.jobs.size>0;}
 get ready(){return this.verified&&this.available();}
 private current(binding:TelegramBinding){return this.available()&&binding.conversationsEnabled&&this.pairs.current(binding);}
 private settle(message:TelegramMessage,state:State,receipt:number|null=null){this.db.connection.prepare('UPDATE telegram_deliveries SET state=?,receipt_id=?,updated_at=? WHERE bot_id=? AND update_id=?').run(state,receipt,Date.now(),this.botId,message.updateId);}
 private reserve(message:TelegramMessage,subscriptionId:string|null){return this.db.connection.prepare("INSERT OR IGNORE INTO telegram_deliveries(bot_id,update_id,subscription_id,state,updated_at) VALUES(?,?,?,'reserved',?)").run(this.botId,message.updateId,subscriptionId,Date.now()).changes===1;}
 private receive(message:TelegramMessage){
  if(!this.available())return;
  const binding=this.pairs.binding(this.botId,message.chatId,message.userId);
  if(!this.reserve(message,binding?.subscriptionId??null))return;
  const start=/^\/start ([A-Za-z0-9_-]{43})$/.exec(message.text);
  if(start){this.settle(message,this.pairs.claim(this.botId,start[1]!,{...message,privateChat:true,isBot:false})?'claimed':'ignored');return;}
  if(!binding){this.settle(message,'ignored');return;}
  if(message.text.trim()==='/stop'){this.jobs.get(binding.subscriptionId)?.controller.abort();this.settle(message,'cancelled');return;}
  if(message.sentAt<binding.activatedAt-5000||!this.current(binding)){this.settle(message,'ignored');return;}
  let controlReply:TelegramReply|undefined;try{controlReply=this.control?.(binding,message);}catch{this.settle(message,'cancelled');return;}
  if(controlReply)this.jobs.get(binding.subscriptionId)?.controller.abort();
  if(!controlReply&&this.jobs.has(binding.subscriptionId)||!this.jobs.has(binding.subscriptionId)&&this.jobs.size>=4){this.settle(message,'ignored');return;}
  const controller=new AbortController(),job:Job={binding,message,controller,work:Promise.resolve(),...(controlReply?{controlReply}:{})};this.jobs.set(binding.subscriptionId,job);
  job.work=this.respond(job).finally(()=>{if(this.jobs.get(binding.subscriptionId)===job)this.jobs.delete(binding.subscriptionId);if(!this.jobs.size&&this.guard){clearInterval(this.guard);this.guard=undefined;}});
  if(!this.guard){this.guard=setInterval(()=>this.reconcile(),100);this.guard.unref();}
 }
 private async respond(job:Job){
  const signal=AbortSignal.any([job.controller.signal,this.controller.signal,AbortSignal.timeout(30_000)]);let attempted=false;let cancel=()=>{};
  try{
   const reply=await Promise.race([job.controlReply?Promise.resolve(job.controlReply):this.conversation(job.binding,job.message,signal),new Promise<never>((_,reject)=>{cancel=()=>reject(Error('cancelled'));signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();})]);
   if(signal.aborted||!this.current(job.binding)||!reply||!reply.current()||typeof reply.text!=='string'||!reply.text.trim()||reply.text.length>4096){this.settle(job.message,'cancelled');return;}
   job.replyCurrent=reply.current;
   this.settle(job.message,'sending');attempted=true;
   const sent=await this.api.send(job.binding.chatId,reply.text,signal);
   if(sent.status==='accepted'){this.settle(job.message,'accepted',sent.messageId);if(!signal.aborted&&this.current(job.binding)&&reply.current())try{reply.accepted?.();}catch{/* Delivery fact remains accepted; memory bookkeeping cannot resend. */}}
   else this.settle(job.message,sent.status==='unknown'?'unknown':sent.status==='notStarted'?'cancelled':'rejected');
  }catch{this.settle(job.message,attempted?'unknown':'cancelled');}
  finally{signal.removeEventListener('abort',cancel);job.controller.abort();}
 }
 reconcile(){for(const job of this.jobs.values()){let current=false;try{current=this.current(job.binding)&&(!job.replyCurrent||job.replyCurrent());}catch{/* A failed prepared-context check is unavailable. */}if(!current)job.controller.abort();}}
 async pollOnce():Promise<boolean>{
  if(this.polling||!this.available())return false;this.polling=true;
  try{
   if(!this.verified){await this.api.verify(this.controller.signal);if(!this.available())return false;this.verified=true;}
   const offset=Number(this.db.connection.prepare('SELECT next_offset FROM telegram_poll_state WHERE bot_id=?').get(this.botId)?.next_offset??0),batch=await this.api.updates(offset,this.controller.signal);if(!this.available())return false;
   if(!Number.isSafeInteger(batch.nextOffset)||batch.nextOffset<offset)throw Error('Invalid Telegram cursor');
   for(const message of batch.messages){if(message.updateId<offset||message.updateId>=batch.nextOffset)throw Error('Invalid Telegram update');this.receive(message);}
   this.db.transaction(tx=>{tx.run('UPDATE telegram_poll_state SET next_offset=MAX(next_offset,?) WHERE bot_id=? AND generation=?',batch.nextOffset,this.botId,this.generation);tx.run("DELETE FROM telegram_deliveries WHERE bot_id=? AND state NOT IN ('reserved','sending') AND update_id NOT IN (SELECT update_id FROM telegram_deliveries WHERE bot_id=? ORDER BY update_id DESC LIMIT 512)",this.botId,this.botId);});
   return true;
  }catch{return false;}finally{this.polling=false;}
 }
 start(){if(this.closed||this.timer)return;this.timer=setInterval(()=>{this.reconcile();void this.pollOnce();},1000);this.timer.unref();}
 async drain(){await Promise.allSettled([...this.jobs.values()].map(job=>job.work));}
 async close(){if(this.closed)return;this.closed=true;this.controller.abort();if(this.timer)clearInterval(this.timer);if(this.guard)clearInterval(this.guard);await this.drain();}
}
