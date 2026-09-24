import type {Database} from './database.ts';
export type ChannelPersonalContext={revision:number;ownerAllowed:boolean;consented:boolean};
/** Person-owned context is independent of pairing, transport and administration. */
export class ChannelPersonalContextRepository {
 private readonly database:Database;
 constructor(database:Database){this.database=database;}
 inspect(assistantId:string,principalId:string):ChannelPersonalContext{
  const row=this.database.connection.prepare('SELECT revision,owner_allowed,consented FROM channel_personal_context WHERE assistant_id=? AND principal_id=?').get(assistantId,principalId) as {revision:number;owner_allowed:number;consented:number}|undefined;
  return row?{revision:row.revision,ownerAllowed:row.owner_allowed===1,consented:row.consented===1}:{revision:0,ownerAllowed:false,consented:false};
 }
 eligible(assistantId:string,principalId:string):boolean{return !!this.database.connection.prepare("SELECT 1 FROM channel_subscriptions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.assistant_id=? AND s.principal_id=? AND a.disabled=0 AND s.status='unpaired' AND s.channel='telegram' AND s.requested_conversations=1").get(assistantId,principalId);}
 allowed(assistantId:string,principalId:string):boolean{const p=this.inspect(assistantId,principalId);return p.ownerAllowed&&p.consented&&this.eligible(assistantId,principalId);}
 owner(assistantId:string,principalId:string,expectedRevision:number,allowed:boolean){return this.change(assistantId,principalId,expectedRevision,allowed,false);}
 consent(assistantId:string,principalId:string,expectedRevision:number,consented:boolean){const p=this.inspect(assistantId,principalId);if(consented&&(!p.ownerAllowed||!this.eligible(assistantId,principalId)))throw Error('Personal context is not permitted');return this.change(assistantId,principalId,expectedRevision,p.ownerAllowed,consented);}
 private change(assistantId:string,principalId:string,expectedRevision:number,ownerAllowed:boolean,consented:boolean){
  return this.database.transaction(tx=>{
   if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||this.inspect(assistantId,principalId).revision!==expectedRevision)throw Error('Personal context revision changed');
   if(ownerAllowed&&!this.eligible(assistantId,principalId))throw Error('Eligible subscriber required');
   tx.run('INSERT INTO channel_personal_context VALUES (?,?,?,?,?,?) ON CONFLICT(assistant_id,principal_id) DO UPDATE SET revision=excluded.revision,owner_allowed=excluded.owner_allowed,consented=excluded.consented,updated_at=excluded.updated_at',assistantId,principalId,expectedRevision+1,Number(ownerAllowed),Number(consented),new Date().toISOString());
   // A new permission/consent epoch must not resume earlier extraction work.
   tx.run("UPDATE automatic_memory_work SET state='cancelled',input_text='',prepared_json=NULL,reason='personal_context_changed' WHERE scope_key IN (SELECT scope_key FROM automatic_memory_policies WHERE assistant_id=? AND principal_id=?) AND state IN ('queued','running','prepared')",assistantId,principalId);
   return this.inspect(assistantId,principalId);
  });
 }
}
