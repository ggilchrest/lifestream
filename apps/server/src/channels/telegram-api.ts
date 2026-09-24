/** A bounded outbound-only Bot API adapter. Constructing it does no I/O.
 * Activation, token custody, pairing, identity and permissions belong to the host.
 * Never expose token-bearing URLs, raw provider failures or message bodies in logs. */
export type TelegramMessage={updateId:number;messageId:number;chatId:string;userId:string;sentAt:number;text:string};
export type TelegramSendResult={status:'accepted';messageId:number}|{status:'notStarted'|'rejected'|'unknown'};
type Fetch=typeof globalThis.fetch;
const object=(x:unknown):Record<string,unknown>|undefined=>x!==null&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:undefined;
const integer=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>0;
const id=(x:unknown):x is string=>typeof x==='string'&&/^[1-9][0-9]{0,15}$/.test(x)&&Number.isSafeInteger(Number(x));
export function telegramPrivateMessage(raw:unknown,now=Date.now()):TelegramMessage|undefined{
 const u=object(raw),m=object(u?.message),chat=object(m?.chat),from=object(m?.from);
 if(!u||!Number.isSafeInteger(u.update_id)||Number(u.update_id)<0||!m||!integer(m.message_id)||chat?.type!=='private'||!integer(chat.id)||!from||from.is_bot!==false||from.id!==chat.id||!integer(m.date)||Number(m.date)*1000>now+5000||Number(m.date)*1000<now-300_000||typeof m.text!=='string'||!m.text.trim()||m.text.length>4096||['forward_origin','via_bot','sender_chat','business_connection_id','is_automatic_forward','external_reply','is_topic_message','message_thread_id'].some(key=>key in m))return;
 return {updateId:Number(u.update_id),messageId:m.message_id,chatId:String(chat.id),userId:String(from.id),sentAt:Number(m.date)*1000,text:m.text};
}
export class TelegramApiError extends Error{constructor(){super('Telegram transport unavailable');}}
export class TelegramBotApi{
 private readonly token:()=>string|undefined;
 private readonly enabled:()=>boolean;
 private readonly fetcher:Fetch;
 private readonly botId:string;
 constructor(options:{botId:string;token:()=>string|undefined;enabled:()=>boolean;fetch?:Fetch}){
  if(!id(options.botId))throw new TelegramApiError();this.botId=options.botId;this.token=options.token;this.enabled=options.enabled;this.fetcher=options.fetch??globalThis.fetch;
 }
 private async call(method:'getMe'|'getUpdates'|'sendMessage',body:Record<string,unknown>,signal:AbortSignal,timeout:number):Promise<{ok:boolean;result?:unknown}>{
  const token=this.token();if(signal.aborted||!this.enabled()||typeof token!=='string'||!new RegExp('^'+this.botId+':[A-Za-z0-9_-]{20,}$').test(token))throw new TelegramApiError();
  try{
   const response=await this.fetcher(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(timeout)])});
   if(!response.body)throw new TelegramApiError();const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
   try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1_048_576)throw new TelegramApiError();chunks.push(value);}}finally{await reader.cancel();}
   const data=object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
   if(!data||typeof data.ok!=='boolean'||response.ok!==data.ok)throw new TelegramApiError();
   return {ok:data.ok,...(data.ok?{result:data.result}:{})};
  }catch{throw new TelegramApiError();}
 }
 async verify(signal:AbortSignal):Promise<void>{const r=await this.call('getMe',{},signal,10_000),user=object(r.result);if(!r.ok||user?.id!==Number(this.botId)||user.is_bot!==true)throw new TelegramApiError();}
 async updates(offset:number,signal:AbortSignal):Promise<{nextOffset:number;messages:TelegramMessage[]}>{
  if(!Number.isSafeInteger(offset)||offset<0)throw new TelegramApiError();
  const r=await this.call('getUpdates',{offset,limit:100,timeout:20,allowed_updates:['message']},signal,25_000);if(!r.ok||!Array.isArray(r.result)||r.result.length>100)throw new TelegramApiError();
  let nextOffset=offset;const messages:TelegramMessage[]=[];
  for(const raw of r.result){const update=object(raw);if(!update||!Number.isSafeInteger(update.update_id)||Number(update.update_id)<offset||Number(update.update_id)>=Number.MAX_SAFE_INTEGER)throw new TelegramApiError();nextOffset=Math.max(nextOffset,Number(update.update_id)+1);const parsed=telegramPrivateMessage(raw);if(parsed)messages.push(parsed);}
  messages.sort((a,b)=>a.updateId-b.updateId);if(new Set(messages.map(m=>m.updateId)).size!==messages.length)throw new TelegramApiError();return {nextOffset,messages};
 }
 async send(chatId:string,text:string,signal:AbortSignal):Promise<TelegramSendResult>{
  if(signal.aborted||!this.enabled()||!id(chatId)||typeof text!=='string'||!text.trim()||text.length>4096)return {status:'notStarted'};
  try{const r=await this.call('sendMessage',{chat_id:chatId,text,protect_content:true,link_preview_options:{is_disabled:true},allow_paid_broadcast:false},signal,15_000);
   if(!r.ok)return {status:'rejected'};const m=object(r.result),chat=object(m?.chat);if(!m||!integer(m.message_id)||chat?.type!=='private'||String(chat.id)!==chatId)return {status:'unknown'};return {status:'accepted',messageId:m.message_id};
  }catch{return {status:'unknown'};}
 }
}
