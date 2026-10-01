import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {crc32} from 'node:zlib';
import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type {GameHelpItem} from '@lifestream/contracts/game-activity';

export type TelegramGameHelpAttachmentResult=Readonly<{
 status:'notStarted'|'accepted'|'rejected'|'unknown';
 messageId:number|null;attachmentStatus:'queued'|'sent'|'failed'|'unknown';
 deliveryStatus:'unknown';capturedAt:string|null;ageAtSendMs:number|null;
}>;
type Options={botId:string;token:()=>string|undefined;enabled?:()=>boolean;fetch?:typeof fetch;now?:()=>number;timeoutMs?:number};
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/GameHelpItem';
const id=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const lineEndings=(v:string)=>v.replace(/\r\n|\r/gu,'\n');
const object=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const frozen=<T>(v:T):T=>{if(v&&typeof v==='object'){for(const x of Object.values(v))frozen(x);Object.freeze(v);}return v;};
const typedPrototype=Object.getPrototypeOf(Uint8Array.prototype);
const arrayLength=Object.getOwnPropertyDescriptor(typedPrototype,'byteLength')!.get!;
const arrayBuffer=Object.getOwnPropertyDescriptor(typedPrototype,'buffer')!.get!;
const result=(status:TelegramGameHelpAttachmentResult['status'],capturedAt:string|null=null,ageAtSendMs:number|null=null,messageId:number|null=null):TelegramGameHelpAttachmentResult=>Object.freeze({status,messageId,attachmentStatus:status==='accepted'?'sent':status==='notStarted'?'queued':status==='rejected'?'failed':'unknown',deliveryStatus:'unknown',capturedAt,ageAtSendMs});

/** Structural PNG validation only, not pixel decoding or framebuffer provenance.
 * Accept image chunks only; do not transmit text, EXIF or arbitrary metadata. */
function pngDimensions(bytes:Uint8Array):{width:number;height:number}|null{
 if(bytes.length<57||![137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))return null;
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let offset=8,width=0,height=0,data=false,endedData=false,palette=false,transparency=false;
 while(offset+12<=bytes.length){const size=view.getUint32(offset),end=offset+12+size;if(end>bytes.length)return null;const type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
  if(!['IHDR','PLTE','tRNS','IDAT','IEND'].includes(type)||crc32(bytes.subarray(offset+4,end-4))!==view.getUint32(end-4))return null;
  if(type==='IHDR'){if(offset!==8||size!==13)return null;width=view.getUint32(offset+8);height=view.getUint32(offset+12);const bit=bytes[offset+16]!,color=bytes[offset+17]!;
   if(!({0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]} as Record<number,number[]>)[color]?.includes(bit)||bytes[offset+18]!==0||bytes[offset+19]!==0||bytes[offset+20]!>1||width<1||height<1||Math.max(width,height)>1280||Math.max(width,height)/Math.min(width,height)>20)return null;
  }else if(!width)return null;
  if(type==='PLTE'){if(palette||data||size===0||size>768||size%3!==0)return null;palette=true;}
  if(type==='tRNS'){if(transparency||data||size===0||size>256)return null;transparency=true;}
  if(type==='IDAT'){if(endedData)return null;data=true;}else if(data)endedData=true;
  if(type==='IEND')return size===0&&data&&end===bytes.length?{width,height}:null;offset=end;
 }return null;
}

/** Optional low-level adapter for an ALREADY governed image-bearing help dispatch.
 * No default activation/root wiring, grants, scheduling, persistent attachments,
 * retries, arbitrary URLs, new contacts or authenticated-reply inference.
 * The trusted host must durably reserve the existing delivery attempt and provide
 * current owner/source/native pause/recipient/hours/privacy/image authority.
 * Callback truth and schema validity are not independent evidence of those facts. */
export class TelegramGameHelpAttachmentTransport{
 private readonly options:Readonly<Options>;private readonly timeout:number;
 private readonly attempted=new Set<string>();private active=false;private closed=false;private controller:AbortController|null=null;
 constructor(options:Options){if(!id(options.botId)||options.timeoutMs!==undefined&&(!integer(options.timeoutMs)||options.timeoutMs>15000))throw Error('Telegram image transport unavailable');this.options=Object.freeze({...options});this.timeout=options.timeoutMs??15000;}
 close(){this.closed=true;this.controller?.abort();this.attempted.clear();}
 async send(rawItem:GameHelpItem,chatId:string,rawBytes:Uint8Array,signal:AbortSignal,current:(item:Readonly<GameHelpItem>,chatId:string)=>boolean):Promise<TelegramGameHelpAttachmentResult>{
  if(this.closed||this.active||signal.aborted||!id(chatId))return result('notStarted');
  // Reserve before invoking any trusted setup callback; reentrant calls cannot
  // obtain a second slot even when no network work has started yet.
  this.active=true;let item:GameHelpItem|null=null,bytes:Uint8Array|null=null,started=false,work:Promise<TelegramGameHelpAttachmentResult>|null=null;
  const controller=new AbortController();this.controller=controller;let timer:ReturnType<typeof setTimeout>|undefined,guard:ReturnType<typeof setInterval>|undefined,stop:(()=>void)|undefined;
  let capturedAt:string|null=null,age:number|null=null;
  try{
   item=boundedGameDataSnapshot(rawItem,32768) as GameHelpItem|null;
   if(!item||!validator.validate(schema,item).valid||!['queued','deferred'].includes(item.status)||item.screenshotStatus!=='ready'||!item.screenshot||item.imageTransportSupported!==true||item.attachmentStatus!=='queued'||[item.sentAt,item.messageSentEvidenceRef,item.attachmentSentEvidenceRef,item.deliveryEvidenceRef,item.replyAdviceRef,item.authenticatedReplyEvidenceRef,item.attachmentTransferredEvidenceRef,item.attachmentDeliveryEvidenceRef].some(v=>v!==null)||this.attempted.has(item.helpId)||this.attempted.size>=128)return result('notStarted');
   frozen(item);const selected=item,screenshot=selected.screenshot!,clock=this.options.now??Date.now;let last=clock();
   if(!Number.isSafeInteger(last)||last<0||!Number.isFinite(new Date(last).getTime())||Date.parse(screenshot.capturedAt)>last||Date.parse(selected.queuedAt)>last||Date.parse(screenshot.expiresAt)<=last||screenshot.ageAtSendMs!==null||screenshot.captureTimeDisclosed!==false||screenshot.activityId!==selected.scope.activityId||screenshot.runId!==selected.scope.runId||screenshot.timelineId!==selected.scope.timelineId||!selected.sourceObservationIds.includes(screenshot.observationId)||screenshot.attachmentArtifact.sha256!==screenshot.sha256||screenshot.attachmentArtifact.byteLength!==screenshot.byteLength||screenshot.attachmentArtifact.mediaType!==screenshot.mediaType)return result('notStarted');
   const monotonicEnd=performance.now()+Math.min(this.timeout,Date.parse(screenshot.expiresAt)-last);
   const valid=()=>{try{const now=clock();if(this.closed||signal.aborted||controller.signal.aborted||!Number.isSafeInteger(now)||now<last||now>=Date.parse(screenshot.expiresAt)||performance.now()>=monotonicEnd||this.options.enabled?.()!==true||current(selected,chatId)!==true)return false;last=now;const after=clock();if(!Number.isSafeInteger(after)||after<now||after>=Date.parse(screenshot.expiresAt)||performance.now()>=monotonicEnd||this.closed||signal.aborted||controller.signal.aborted||this.options.enabled?.()!==true)return false;last=after;return true;}catch{return false;}};
   if(!valid()||types.isProxy(rawBytes)||!types.isUint8Array(rawBytes)||Object.getPrototypeOf(rawBytes)!==Uint8Array.prototype&&Object.getPrototypeOf(rawBytes)!==Buffer.prototype||arrayBuffer.call(rawBytes) instanceof SharedArrayBuffer)return result('notStarted');
   const length=arrayLength.call(rawBytes) as number;if(length<57||length>2097152)return result('notStarted');
   bytes=new Uint8Array(length);Uint8Array.prototype.set.call(bytes,rawBytes);const dimensions=pngDimensions(bytes);
   if(!dimensions||dimensions.width!==screenshot.width||dimensions.height!==screenshot.height||bytes.byteLength!==screenshot.byteLength||createHash('sha256').update(bytes).digest('hex')!==screenshot.sha256||!valid())return result('notStarted');
   const token=this.options.token();if(typeof token!=='string'||!new RegExp('^'+this.options.botId+':[A-Za-z0-9_-]{20,}$','u').test(token)||!valid())return result('notStarted');
   const body=new FormData();body.set('chat_id',chatId);body.set('protect_content','true');body.set('allow_paid_broadcast','false');body.set('photo',new Blob([bytes as Uint8Array<ArrayBuffer>],{type:'image/png'}),'game-frame.png');bytes.fill(0);bytes=null;
   if(!valid())return result('notStarted');
   capturedAt=screenshot.capturedAt;age=last-Date.parse(capturedAt);
   const caption=lineEndings(`Game capture ${capturedAt}; age at dispatch ${age} ms.\nRecorded attempts: ${selected.attemptsSummary}\nQuestion: ${selected.question}`);
   // Do not truncate a question or silently omit its capture moment.
   if(caption.length>1024||Buffer.byteLength(caption)>4096)return result('notStarted');
   body.set('caption',caption);
   // This in-process fence is deliberately finite, not restart idempotency.
   // Durable existing delivery authority remains mandatory at the host.
   this.attempted.add(selected.helpId);started=true;
   const canceled=new Promise<TelegramGameHelpAttachmentResult>(resolve=>{stop=()=>{controller.abort();resolve(result('unknown',capturedAt,age));};signal.addEventListener('abort',stop,{once:true});controller.signal.addEventListener('abort',()=>resolve(result('unknown',capturedAt,age)),{once:true});});
   timer=setTimeout(()=>stop?.(),Math.max(1,monotonicEnd-performance.now()));guard=setInterval(()=>{if(!valid())stop?.();},50);
   work=(async()=>{try{
    const response=await (this.options.fetch??globalThis.fetch)(`https://api.telegram.org/bot${token}/sendPhoto`,{method:'POST',redirect:'error',body,signal:controller.signal});
    if(!response.body||!valid())return result('unknown',capturedAt,age);
    const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
    try{for(;;){const {done,value}=await reader.read();if(!valid())return result('unknown',capturedAt,age);if(done)break;size+=value.length;if(size>65536)return result('unknown',capturedAt,age);chunks.push(value);}}finally{void reader.cancel().catch(()=>{});}
    const data=object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));
    if(!data||typeof data.ok!=='boolean'||response.ok!==data.ok||!valid())return result('unknown',capturedAt,age);
    if(!data.ok)return result('rejected',capturedAt,age);
    const m=object(data.result),chat=object(m?.chat),photos=m?.photo;
    if(!m||!integer(m.message_id)||chat?.type!=='private'||!integer(chat.id)||String(chat.id)!==chatId||typeof m.caption!=='string'||lineEndings(m.caption)!==caption||!Array.isArray(photos)||photos.length<1||photos.length>16||photos.some(p=>{const photo=object(p);return !photo||typeof photo.file_id!=='string'||photo.file_id.length<1||photo.file_id.length>1024||!integer(photo.width)||!integer(photo.height);})||['business_connection_id','sender_chat','message_thread_id','is_topic_message','forward_origin'].some(k=>k in m)||!valid())return result('unknown',capturedAt,age);
    return result('accepted',capturedAt,age,m.message_id);
   }catch{return result('unknown',capturedAt,age);}})();
   return await Promise.race([work,canceled]);
  }catch{return result(started?'unknown':'notStarted',started?capturedAt:null,started?age:null);}
  finally{
   bytes?.fill(0);if(timer)clearTimeout(timer);if(guard)clearInterval(guard);if(stop)signal.removeEventListener('abort',stop);controller.abort();
   // A fetch that ignores abort keeps the slot quarantined until actual return.
   const release=()=>{this.active=false;if(this.controller===controller)this.controller=null;};
   if(work)void work.then(release,release);else release();
  }
 }
}
