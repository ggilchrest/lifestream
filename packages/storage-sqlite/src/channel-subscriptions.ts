import {randomUUID} from 'node:crypto';
import type {Database} from './database.ts';

export type ChannelKind='telegram'|'ios-push'|'android-push';
export type ChannelSubscription={id:string;assistantId:string;principalId:string;channel:ChannelKind;label:string;revision:number;requestedConversations:boolean;requestedAlerts:boolean;status:'unpaired'|'disabled'|'removed';createdAt:string;updatedAt:string};
export class ChannelSubscriptionError extends Error {
 readonly code:'invalid'|'not_found'|'stale'|'limit'|'account_unavailable';
 constructor(code:ChannelSubscriptionError['code']){super('Channel configuration '+code);this.code=code;}
}
type Row={id:string;assistant_id:string;principal_id:string;channel:ChannelKind;label:string;revision:number;requested_conversations:number;requested_alerts:number;status:ChannelSubscription['status'];created_at:string;updated_at:string};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const map=(r:Row):ChannelSubscription=>({id:r.id,assistantId:r.assistant_id,principalId:r.principal_id,channel:r.channel,label:r.label,revision:r.revision,requestedConversations:r.requested_conversations===1,requestedAlerts:r.requested_alerts===1,status:r.status,createdAt:r.created_at,updatedAt:r.updated_at});
const fields=(v:Record<string,unknown>,expected:string[])=>{if(Object.keys(v).sort().join(',')!==expected.sort().join(','))throw new ChannelSubscriptionError('invalid');};
const preferences=(v:Record<string,unknown>)=>{
 if(typeof v.label!=='string'||!v.label.trim()||v.label.trim().length>80||/[\u0000-\u001f\u007f]/.test(v.label)||typeof v.requestedConversations!=='boolean'||typeof v.requestedAlerts!=='boolean')throw new ChannelSubscriptionError('invalid');
 return {label:v.label.trim(),conversations:Number(v.requestedConversations),alerts:Number(v.requestedAlerts)};
};
/** Stores subscriber intent only. No address, credential, identity pairing,
 * session, authority grant or delivery is created by these operations. */
export class ChannelSubscriptionRepository {
 private readonly database:Database;
 constructor(database:Database){this.database=database;}
 list(assistantId:string):ChannelSubscription[]{return (this.database.connection.prepare('SELECT * FROM channel_subscriptions WHERE assistant_id=? ORDER BY created_at,id').all(assistantId) as Row[]).map(map);}
 private account(id:string){if(!this.database.connection.prepare('SELECT 1 FROM local_accounts WHERE principal_id=? AND disabled=0').get(id))throw new ChannelSubscriptionError('account_unavailable');}
 apply(assistantId:string,actorId:string,input:Record<string,unknown>):ChannelSubscription{
  if(!uuid(assistantId)||!uuid(actorId)||typeof input.operation!=='string')throw new ChannelSubscriptionError('invalid');
  this.account(actorId);
  const now=new Date().toISOString(),db=this.database.connection;
  if(input.operation==='create'){
   fields(input,['operation','principalId','channel','label','requestedConversations','requestedAlerts']);
   if(!uuid(input.principalId)||typeof input.channel!=='string'||!['telegram','ios-push','android-push'].includes(input.channel))throw new ChannelSubscriptionError('invalid');
   this.account(input.principalId);const p=preferences(input);if(input.channel!=='telegram'&&p.conversations)throw new ChannelSubscriptionError('invalid');
   if(this.list(assistantId).length>=128)throw new ChannelSubscriptionError('limit');
   const id=randomUUID();db.prepare('INSERT INTO channel_subscriptions VALUES (?,?,?,?,?,?,1,?,?,\'unpaired\',?,?)').run(id,assistantId,input.principalId,actorId,String(input.channel),p.label,p.conversations,p.alerts,now,now);
   return this.list(assistantId).find(x=>x.id===id)!;
  }
  if(!['update','disable','remove'].includes(String(input.operation)))throw new ChannelSubscriptionError('invalid');
  fields(input,input.operation==='update'?['operation','id','expectedRevision','label','requestedConversations','requestedAlerts']:['operation','id','expectedRevision']);
  if(!uuid(input.id)||!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<1)throw new ChannelSubscriptionError('invalid');
  const row=db.prepare('SELECT * FROM channel_subscriptions WHERE id=? AND assistant_id=?').get(input.id,assistantId) as Row|undefined;
  if(!row)throw new ChannelSubscriptionError('not_found');
  if(row.revision!==input.expectedRevision||row.status==='removed')throw new ChannelSubscriptionError('stale');
  const p=input.operation==='update'?preferences(input):{label:row.label,conversations:0,alerts:0};
  if(input.operation==='update'){this.account(row.principal_id);if(row.channel!=='telegram'&&p.conversations)throw new ChannelSubscriptionError('invalid');}
  const status=input.operation==='remove'?'removed':input.operation==='disable'?'disabled':'unpaired';
  const result=db.prepare('UPDATE channel_subscriptions SET label=?,requested_conversations=?,requested_alerts=?,status=?,revision=revision+1,updated_at=? WHERE id=? AND assistant_id=? AND revision=?').run(p.label,p.conversations,p.alerts,status,now,input.id,assistantId,Number(input.expectedRevision));
  if(result.changes!==1)throw new ChannelSubscriptionError('stale');
  return map(db.prepare('SELECT * FROM channel_subscriptions WHERE id=?').get(input.id) as Row);
 }
}
