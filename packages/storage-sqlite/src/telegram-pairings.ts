import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {Database} from './database.ts';
import {ChannelSubscriptionRepository,type ChannelSubscription} from './channel-subscriptions.ts';

type PairingRow={subscription_id:string;subscription_revision:number;bot_id:string;state:'challenge'|'claimed'|'paired'|'revoked';revision:number;challenge_digest:string|null;issued_at:number;expires_at:number;chat_id:string|null;user_id:string|null;claim_id:string|null;conversations_enabled:number;alerts_enabled:number;updated_at:number};
export type TelegramPairingView={subscriptionId:string;revision:number;state:PairingRow['state']|'unpaired'|'expired';botId:string|null;expiresAt:number|null;claimId:string|null;chatId:string|null;userId:string|null;conversationsEnabled:boolean;alertsEnabled:boolean};
export type TelegramBinding={subscriptionId:string;assistantId:string;principalId:string;botId:string;chatId:string;userId:string;revision:number;subscriptionRevision:number;activatedAt:number;conversationsEnabled:boolean;alertsEnabled:boolean};
export class TelegramPairingError extends Error{constructor(){super('Telegram pairing unavailable or changed');}}
const positiveId=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/.test(v)&&Number.isSafeInteger(Number(v));
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
/** Pairing proves control of a local account and one private Telegram chat.
 * It does not grant administration, evidence access, or enable delivery. */
export class TelegramPairingRepository {
 private readonly database:Database;
 private readonly now:()=>number;
 constructor(database:Database,now=Date.now){this.database=database;this.now=now;}
 private row(id:string){return this.database.connection.prepare('SELECT * FROM telegram_pairings WHERE subscription_id=?').get(id) as PairingRow|undefined;}
 private subscription(assistantId:string,id:string,principalId?:string):ChannelSubscription{
  const s=new ChannelSubscriptionRepository(this.database).list(assistantId).find(s=>s.id===id);
  if(!s||s.channel!=='telegram'||s.status!=='unpaired'||principalId!==undefined&&s.principalId!==principalId||!this.database.connection.prepare('SELECT 1 FROM local_accounts WHERE principal_id=? AND disabled=0').get(s.principalId))throw new TelegramPairingError();
  return s;
 }
 private valid(row:PairingRow,s:ChannelSubscription){return row.subscription_revision===s.revision&&row.state!=='revoked'&&(row.state==='paired'||row.expires_at>this.now());}
 inspect(assistantId:string,id:string,principalId:string):TelegramPairingView{
  const s=this.subscription(assistantId,id,principalId),r=this.row(id),valid=r&&this.valid(r,s);
  return {subscriptionId:id,revision:r?.revision??0,state:r?(valid?r.state:r.subscription_revision===s.revision&&r.state!=='revoked'?'expired':'revoked'):'unpaired',botId:r?.bot_id??null,expiresAt:valid&&r.state!=='paired'?r.expires_at:null,claimId:valid?r.claim_id:null,chatId:valid?r.chat_id:null,userId:valid?r.user_id:null,conversationsEnabled:!!valid&&r.conversations_enabled===1&&s.requestedConversations,alertsEnabled:!!valid&&r.alerts_enabled===1&&s.requestedAlerts};
 }
 issue(assistantId:string,id:string,principalId:string,subscriptionRevision:number,botId:string,pairingRevision=0){
  const s=this.subscription(assistantId,id,principalId);if(s.revision!==subscriptionRevision||!positiveId(botId)||!Number.isSafeInteger(pairingRevision)||(this.row(id)?.revision??0)!==pairingRevision)throw new TelegramPairingError();
  const secret=randomBytes(32).toString('base64url'),now=this.now(),revision=(this.row(id)?.revision??0)+1;
  this.database.connection.prepare(`INSERT INTO telegram_pairings(subscription_id,subscription_revision,bot_id,state,revision,challenge_digest,issued_at,expires_at,updated_at) VALUES (?,?,?,'challenge',?,?,?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET subscription_revision=excluded.subscription_revision,bot_id=excluded.bot_id,state='challenge',revision=excluded.revision,challenge_digest=excluded.challenge_digest,issued_at=excluded.issued_at,expires_at=excluded.expires_at,chat_id=NULL,user_id=NULL,claim_id=NULL,conversations_enabled=0,alerts_enabled=0,updated_at=excluded.updated_at`).run(id,s.revision,botId,revision,hash(secret),now,now+600_000,now);
  return {...this.inspect(assistantId,id,principalId),challenge:secret};
 }
 /** Called only by the authenticated Telegram transport, never an HTTP body. */
 claim(botId:string,secret:string,message:{chatId:string;userId:string;privateChat:boolean;isBot:boolean;sentAt:number}):boolean{
  if(!positiveId(botId)||typeof secret!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(secret)||message.privateChat!==true||message.isBot!==false||!positiveId(message.chatId)||message.userId!==message.chatId||!Number.isSafeInteger(message.sentAt))return false;
  const r=this.database.connection.prepare("SELECT * FROM telegram_pairings WHERE challenge_digest=? AND bot_id=? AND state='challenge'").get(hash(secret),botId) as PairingRow|undefined;
  if(!r||message.sentAt<r.issued_at-5000||message.sentAt>this.now()+5000)return false;
  try{const raw=this.database.connection.prepare('SELECT assistant_id FROM channel_subscriptions WHERE id=?').get(r.subscription_id) as {assistant_id:string};const s=this.subscription(raw.assistant_id,r.subscription_id);if(!this.valid(r,s))return false;}catch{return false;}
  return this.database.connection.prepare("UPDATE telegram_pairings SET state='claimed',revision=revision+1,challenge_digest=NULL,chat_id=?,user_id=?,claim_id=?,updated_at=? WHERE subscription_id=? AND revision=? AND state='challenge'").run(message.chatId,message.userId,randomUUID(),this.now(),r.subscription_id,r.revision).changes===1;
 }
 confirm(assistantId:string,id:string,principalId:string,revision:number,claimId:string):TelegramPairingView{
  const s=this.subscription(assistantId,id,principalId),r=this.row(id);if(!r||r.revision!==revision||r.state!=='claimed'||typeof claimId!=='string'||r.claim_id!==claimId||!this.valid(r,s))throw new TelegramPairingError();
  // One private chat has one active route per bot; never guess an Assistant.
  if(this.database.connection.prepare("SELECT 1 FROM telegram_pairings WHERE bot_id=? AND chat_id=? AND state='paired' AND subscription_id!=?").get(r.bot_id,r.chat_id!,id))throw new TelegramPairingError();
  this.database.connection.prepare("UPDATE telegram_pairings SET state='paired',revision=revision+1,updated_at=? WHERE subscription_id=? AND revision=?").run(this.now(),id,revision);
  return this.inspect(assistantId,id,principalId);
 }
 enable(assistantId:string,id:string,principalId:string,revision:number,conversations:boolean,alerts:boolean):TelegramPairingView{
  const s=this.subscription(assistantId,id,principalId),r=this.row(id);if(!r||r.state!=='paired'||r.revision!==revision||!this.valid(r,s)||typeof conversations!=='boolean'||typeof alerts!=='boolean'||conversations&&!s.requestedConversations||alerts&&!s.requestedAlerts)throw new TelegramPairingError();
  this.database.connection.prepare('UPDATE telegram_pairings SET conversations_enabled=?,alerts_enabled=?,revision=revision+1,updated_at=? WHERE subscription_id=? AND revision=?').run(Number(conversations),Number(alerts),this.now(),id,revision);return this.inspect(assistantId,id,principalId);
 }
 revoke(assistantId:string,id:string,principalId:string,revision:number){
  this.subscription(assistantId,id,principalId);const r=this.row(id);if(!r||r.revision!==revision)throw new TelegramPairingError();
  this.database.connection.prepare("UPDATE telegram_pairings SET state='revoked',challenge_digest=NULL,chat_id=NULL,user_id=NULL,claim_id=NULL,conversations_enabled=0,alerts_enabled=0,revision=revision+1,updated_at=? WHERE subscription_id=? AND revision=?").run(this.now(),id,revision);
 }
 binding(botId:string,chatId:string,userId:string):TelegramBinding|undefined{
  if(!positiveId(botId)||!positiveId(chatId)||userId!==chatId)return;
  const r=this.database.connection.prepare("SELECT * FROM telegram_pairings WHERE bot_id=? AND chat_id=? AND user_id=? AND state='paired'").get(botId,chatId,userId) as PairingRow|undefined;if(!r)return;
  const raw=this.database.connection.prepare('SELECT assistant_id FROM channel_subscriptions WHERE id=?').get(r.subscription_id) as {assistant_id:string}|undefined;if(!raw)return;
  try{const s=this.subscription(raw.assistant_id,r.subscription_id);if(!this.valid(r,s))return;return {subscriptionId:s.id,assistantId:s.assistantId,principalId:s.principalId,botId,chatId,userId,revision:r.revision,subscriptionRevision:s.revision,activatedAt:r.updated_at,conversationsEnabled:r.conversations_enabled===1&&s.requestedConversations,alertsEnabled:r.alerts_enabled===1&&s.requestedAlerts};}catch{return;}
 }
 activeBindings(botId:string):TelegramBinding[]{
  if(!positiveId(botId))return [];
  const rows=this.database.connection.prepare("SELECT chat_id,user_id FROM telegram_pairings WHERE bot_id=? AND state='paired' ORDER BY subscription_id").all(botId) as Array<{chat_id:string;user_id:string}>;
  return rows.flatMap(row=>{const binding=this.binding(botId,row.chat_id,row.user_id);return binding?[binding]:[];});
 }
 current(binding:TelegramBinding){return JSON.stringify(this.binding(binding.botId,binding.chatId,binding.userId))===JSON.stringify(binding);}
}
