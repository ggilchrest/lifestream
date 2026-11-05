import {isDeepStrictEqual} from 'node:util';
import {gameHostDigest} from '@lifestream/contracts/game-host';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type * as G from '@lifestream/contracts/game-activity';
import {createContractValidator} from '@lifestream/contracts';
import type {Database} from './database.ts';
import type {ActivityCheckpointRepository,ActivityOwner} from './game-activity.ts';

export type GameHostDispatchIdentity={attachmentId:string;hostId:string;commandId:string;requestDigest:string;sourceRevision:string};
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const digest=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
/** Additional durable one-time native dispatch metadata, never a capability grant.
 * Existing controller reservation/accounting remains the sole budget owner. */
export class GameHostDispatchRepository{
 private readonly database:Database;
 private readonly checkpoints:ActivityCheckpointRepository;
 constructor(database:Database,checkpoints:ActivityCheckpointRepository,private readonly retiredHostCurrent?:(runId:string,hostId:string)=>boolean){this.database=database;this.checkpoints=checkpoints;}
 private readonly firstRefusal=new WeakSet<object>();
 private checked(owner:ActivityOwner,r:G.GameActionRequest,current:(checkpoint:G.ActivityCheckpoint,request:G.GameActionRequest)=>boolean,phase:string){
  const refused=(predicate:string)=>{if(process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1'&&!this.firstRefusal.has(r)){this.firstRefusal.add(r);try{console.info(JSON.stringify({event:'game-host-dispatch-first-refusal',runId:r.scope.runId,actionId:r.payload.actionId,phase,predicate,observedAtMs:Date.now(),requestExpiresAtMs:Date.parse(r.deadlineAt),admissionExpiresAtMs:Date.parse(r.payload.admission.expiresAt)}));}catch{}}return null;};
  const expired=(at:number,suffix:string)=>at>=Date.parse(r.deadlineAt)?refused('request_expired_'+suffix):at>=Date.parse(r.payload.admission.expiresAt)?refused('admission_expired_'+suffix):at>=Date.parse(r.payload.dispatchValidation.preparedContextFreshUntil)?refused('dispatch_expired_'+suffix):undefined;
  try{
   const now=Date.now();if(r.executionMode!=='normal'||Date.parse(r.payload.admission.issuedAt)>now)return refused('request_not_current');if(expired(now,'before_current')===null)return null;
   const row=this.checkpoints.get(owner,r.scope.runId);if(!row)return refused('checkpoint_unavailable');if(!isDeepStrictEqual(row.checkpoint.scope,r.scope))return refused('checkpoint_scope');if(row.checkpoint.pinsDigest!==r.payload.expectedPinsDigest)return refused('checkpoint_pins');if(current(row.checkpoint,r)!==true)return refused('owner_current');
   const after=Date.now();if(after<now)return refused('clock_regressed');if(expired(after,'after_current')===null)return null;return row;
  }catch{return refused('qualification_threw');}
 }

 private identity(value:GameHostDispatchIdentity,r:G.GameActionRequest){const d=boundedGameDataSnapshot(value,1024) as GameHostDispatchIdentity|null;return d&&Object.keys(d).sort().join(',')==='attachmentId,commandId,hostId,requestDigest,sourceRevision'&&uuid(d.attachmentId)&&uuid(d.hostId)&&uuid(d.commandId)&&digest(d.requestDigest)&&digest(d.sourceRevision)&&d.requestDigest===gameHostDigest(r)?Object.freeze(d):null;}
 claim(owner:ActivityOwner,raw:G.GameActionRequest,value:GameHostDispatchIdentity,current:(checkpoint:G.ActivityCheckpoint,request:G.GameActionRequest)=>boolean):boolean{
  const r=boundedGameDataSnapshot(raw,131072) as G.GameActionRequest|null;
  if(!r||r.executionMode!=='normal'||!validator.validate(schema+'GameActionRequest',r).valid||typeof current!=='function')return false;
  const d=this.identity(value,r);if(!d)return false;
  return this.database.durableTransaction(tx=>{
   const before=this.checked(owner,r,current,'claim-before');if(!before)return false;
   const reservation=tx.get<{state:string;fingerprint:string}>('SELECT state,fingerprint FROM activity_controller_reservations WHERE run_id=? AND action_id=?',r.scope.runId,r.payload.actionId);
   if(!reservation||reservation.state!=='reserved'||reservation.fingerprint!==d.requestDigest||tx.get('SELECT 1 FROM game_host_dispatch WHERE command_id=? OR action_id=?',d.commandId,r.payload.actionId))return false;
   // A permanent worst-case charge is not live host occupancy. Only an exact
   // retired checkpoint plus a fresh host-owned terminal proof can distinguish
   // them; default callers still treat every uncertain dispatch as exclusive.
   const exclusive=()=>{
    const blockers=tx.all<Record<string,unknown>>("SELECT d.* FROM game_host_dispatch d JOIN activity_controller_reservations r ON r.run_id=d.run_id AND r.action_id=d.action_id WHERE (d.run_id=? OR d.host_id=?) AND r.state='reserved' AND d.command_id<>? LIMIT 65",r.scope.runId,d.hostId,d.commandId);
    return blockers.length<=64&&blockers.every(b=>{
     if(b.run_id===r.scope.runId||typeof b.run_id!=='string'||typeof b.host_id!=='string'||!this.retiredHostCurrent)return false;
     const checkpoint=tx.get("SELECT state,payload_json FROM activity_checkpoints WHERE run_id=?",b.run_id),claim=tx.get("SELECT disposition,receipt_digest FROM game_start_claims WHERE run_id=?",b.run_id);
     if(checkpoint?.state!=='retracted'||checkpoint.payload_json!==null||!claim||!['stopped','completed'].includes(String(claim.disposition))||!digest(claim.receipt_digest)||tx.get('SELECT 1 FROM game_controller_slots WHERE run_id=?',b.run_id))return false;
     try{if(this.retiredHostCurrent(b.run_id,b.host_id)!==true)return false;}catch{return false;}
     if(!isDeepStrictEqual(tx.get('SELECT * FROM game_host_dispatch WHERE command_id=?',b.command_id),b)||!isDeepStrictEqual(tx.get('SELECT state,payload_json FROM activity_checkpoints WHERE run_id=?',b.run_id),checkpoint)||!isDeepStrictEqual(tx.get('SELECT disposition,receipt_digest FROM game_start_claims WHERE run_id=?',b.run_id),claim)||tx.get('SELECT 1 FROM game_controller_slots WHERE run_id=?',b.run_id))throw new Error('game_host_dispatch_withdrawn');return true;
    });
   };
   if(!exclusive())return false;
   tx.run("INSERT INTO game_host_dispatch(run_id,action_id,attachment_id,host_id,command_id,request_digest,source_revision,state,receipt_digest) VALUES(?,?,?,?,?,?,?,'claimed',NULL)",r.scope.runId,r.payload.actionId,d.attachmentId,d.hostId,d.commandId,d.requestDigest,d.sourceRevision);
   const after=this.checked(owner,r,current,'claim-after');if(!after||after.ledgerRevision!==before.ledgerRevision||!exclusive())throw new Error('game_host_dispatch_withdrawn');return true;
  });
 }
 enter(owner:ActivityOwner,raw:G.GameActionRequest,value:GameHostDispatchIdentity,current:(checkpoint:G.ActivityCheckpoint,request:G.GameActionRequest)=>boolean):boolean{
  const r=boundedGameDataSnapshot(raw,131072) as G.GameActionRequest|null;if(!r||!validator.validate(schema+'GameActionRequest',r).valid||typeof current!=='function')return false;
  const d=this.identity(value,r);if(!d)return false;
  return this.database.durableTransaction(tx=>{
   const before=this.checked(owner,r,current,'enter-before');if(!before)return false;
   const row=tx.get<{state:string}>('SELECT state FROM game_host_dispatch WHERE run_id=? AND action_id=? AND attachment_id=? AND host_id=? AND command_id=? AND request_digest=? AND source_revision=?',r.scope.runId,r.payload.actionId,d.attachmentId,d.hostId,d.commandId,d.requestDigest,d.sourceRevision);
   if(row?.state!=='claimed'||!tx.get("SELECT 1 FROM activity_controller_reservations WHERE run_id=? AND action_id=? AND fingerprint=? AND state='reserved'",r.scope.runId,r.payload.actionId,d.requestDigest))return false;
   tx.run("UPDATE game_host_dispatch SET state='entered' WHERE command_id=? AND state='claimed'",d.commandId);
   const after=this.checked(owner,r,current,'enter-after');if(!after||after.ledgerRevision!==before.ledgerRevision)throw new Error('game_host_dispatch_withdrawn');return true;
  });
 }
 /** Bounded ingress digest is historical metadata; it never settles a reservation. */
 receipt(d:GameHostDispatchIdentity,resultDigest:string):boolean{
  if(!digest(resultDigest))return false;
  return this.database.durableTransaction(tx=>{const row=tx.get<{state:string;receipt_digest:string|null}>('SELECT state,receipt_digest FROM game_host_dispatch WHERE command_id=? AND attachment_id=? AND request_digest=?',d.commandId,d.attachmentId,d.requestDigest);if(row?.state!=='entered'||row.receipt_digest!==null)return false;tx.run('UPDATE game_host_dispatch SET receipt_digest=? WHERE command_id=?',resultDigest,d.commandId);return true;});
 }
 /** Retain uncertainty even without a usable actor/session. No release/refund. */
 unresolved(d:GameHostDispatchIdentity):void{
  this.database.durableTransaction(tx=>tx.run("UPDATE game_host_dispatch SET state='unresolved' WHERE command_id=? AND attachment_id=? AND request_digest=? AND state IN ('claimed','entered')",d.commandId,d.attachmentId,d.requestDigest));
 }
}
