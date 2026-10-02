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
 constructor(database:Database,checkpoints:ActivityCheckpointRepository){this.database=database;this.checkpoints=checkpoints;}
 private checked(owner:ActivityOwner,r:G.GameActionRequest,current:(checkpoint:G.ActivityCheckpoint,request:G.GameActionRequest)=>boolean){
  try{const now=Date.now();if(r.executionMode!=='normal'||Date.parse(r.payload.admission.issuedAt)>now||now>=Math.min(Date.parse(r.deadlineAt),Date.parse(r.payload.admission.expiresAt),Date.parse(r.payload.dispatchValidation.preparedContextFreshUntil)))return null;const row=this.checkpoints.get(owner,r.scope.runId);return row&&isDeepStrictEqual(row.checkpoint.scope,r.scope)&&row.checkpoint.pinsDigest===r.payload.expectedPinsDigest&&current(row.checkpoint,r)===true?row:null;}catch{return null;}
 }
 private identity(value:GameHostDispatchIdentity,r:G.GameActionRequest){const d=boundedGameDataSnapshot(value,1024) as GameHostDispatchIdentity|null;return d&&Object.keys(d).sort().join(',')==='attachmentId,commandId,hostId,requestDigest,sourceRevision'&&uuid(d.attachmentId)&&uuid(d.hostId)&&uuid(d.commandId)&&digest(d.requestDigest)&&digest(d.sourceRevision)&&d.requestDigest===gameHostDigest(r)?Object.freeze(d):null;}
 claim(owner:ActivityOwner,raw:G.GameActionRequest,value:GameHostDispatchIdentity,current:(checkpoint:G.ActivityCheckpoint,request:G.GameActionRequest)=>boolean):boolean{
  const r=boundedGameDataSnapshot(raw,131072) as G.GameActionRequest|null;
  if(!r||r.executionMode!=='normal'||!validator.validate(schema+'GameActionRequest',r).valid||typeof current!=='function')return false;
  const d=this.identity(value,r),before=this.checked(owner,r,current);if(!d||!before)return false;
  return this.database.durableTransaction(tx=>{
   const reservation=tx.get<{state:string;fingerprint:string}>('SELECT state,fingerprint FROM activity_controller_reservations WHERE run_id=? AND action_id=?',r.scope.runId,r.payload.actionId);
   if(!reservation||reservation.state!=='reserved'||reservation.fingerprint!==d.requestDigest||tx.get('SELECT 1 FROM game_host_dispatch WHERE command_id=? OR action_id=?',d.commandId,r.payload.actionId)||tx.get("SELECT 1 FROM game_host_dispatch d JOIN activity_controller_reservations r ON r.run_id=d.run_id AND r.action_id=d.action_id WHERE (d.run_id=? OR d.host_id=?) AND r.state='reserved'",r.scope.runId,d.hostId))return false;
   const active=this.checked(owner,r,current);if(!active||active.ledgerRevision!==before.ledgerRevision)return false;
   tx.run("INSERT INTO game_host_dispatch(run_id,action_id,attachment_id,host_id,command_id,request_digest,source_revision,state,receipt_digest) VALUES(?,?,?,?,?,?,?,'claimed',NULL)",r.scope.runId,r.payload.actionId,d.attachmentId,d.hostId,d.commandId,d.requestDigest,d.sourceRevision);
   const after=this.checked(owner,r,current);if(!after||after.ledgerRevision!==before.ledgerRevision)throw new Error('game_host_dispatch_withdrawn');return true;
  });
 }
 enter(owner:ActivityOwner,raw:G.GameActionRequest,value:GameHostDispatchIdentity,current:(checkpoint:G.ActivityCheckpoint,request:G.GameActionRequest)=>boolean):boolean{
  const r=boundedGameDataSnapshot(raw,131072) as G.GameActionRequest|null;if(!r||!validator.validate(schema+'GameActionRequest',r).valid||typeof current!=='function')return false;
  const d=this.identity(value,r),before=this.checked(owner,r,current);if(!d||!before)return false;
  return this.database.durableTransaction(tx=>{
   const row=tx.get<{state:string}>('SELECT state FROM game_host_dispatch WHERE run_id=? AND action_id=? AND attachment_id=? AND host_id=? AND command_id=? AND request_digest=? AND source_revision=?',r.scope.runId,r.payload.actionId,d.attachmentId,d.hostId,d.commandId,d.requestDigest,d.sourceRevision);
   if(row?.state!=='claimed'||!tx.get("SELECT 1 FROM activity_controller_reservations WHERE run_id=? AND action_id=? AND fingerprint=? AND state='reserved'",r.scope.runId,r.payload.actionId,d.requestDigest))return false;
   const active=this.checked(owner,r,current);if(!active||active.ledgerRevision!==before.ledgerRevision)return false;
   tx.run("UPDATE game_host_dispatch SET state='entered' WHERE command_id=? AND state='claimed'",d.commandId);
   const after=this.checked(owner,r,current);if(!after||after.ledgerRevision!==before.ledgerRevision)throw new Error('game_host_dispatch_withdrawn');return true;
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
