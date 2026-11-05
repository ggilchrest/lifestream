import {createHash,randomBytes} from 'node:crypto';
import type {CameraResourceBroker,CameraResourceLease} from './production-camera-binding.ts';
import type {PresenceBinding} from './qualified-presence-source.ts';

export type UbuntuObservationSnapshot={binding:PresenceBinding;contextKey:string;selectionKey:string;executionKey:string;retentionExpiresAt:number;actorId:string;endpointRevision:number;registrationRevision:number;modelRevision:string};
export type UbuntuObservationOptions={broker:CameraResourceBroker;snapshot:()=>UbuntuObservationSnapshot|null;
 /** Explicit host configuration, bounded by the original capture reservation. */
 leaseTtlMs:number;now?:()=>number;monotonicMs?:()=>number;onWithdraw?:()=>void};
type Capture={snapshot:UbuntuObservationSnapshot;lease:CameraResourceLease;until:number;ttlMs:number};
type Frame={handle:object;until:number;expiresAt:number};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Foreground observation custody, not capture, permission or identity authority.
 * The actual broker lease remains separate from each single-use <=5s operation.
 * No timers, automatic renewals, stale evidence or changed-fence continuity. */
export class UbuntuPresenceObservationSession {
 private readonly options:UbuntuObservationOptions|null;
 private capture:Capture|undefined;private frame:Frame|undefined;
 private closed=false;private entering=false;private renewing=false;
 private lastUtc=-Infinity;private lastMono=-Infinity;
 constructor(options:UbuntuObservationOptions|null=null){this.options=options;}
 private clocks(){const utc=(this.options?.now??Date.now)(),mono=(this.options?.monotonicMs??(()=>performance.now()))();
  if(![utc,mono].every(Number.isFinite)||utc<this.lastUtc||mono<this.lastMono)throw Error('OBSERVATION_CLOCK_INVALID');
  this.lastUtc=utc;this.lastMono=mono;return {utc,mono};}
 private ttl(){const value=this.options?.leaseTtlMs;if(!Number.isSafeInteger(value)||!value||value<1||value>60_000)throw Error('OBSERVATION_BOUND_INVALID');return value;}
 private original(c:Capture):boolean{
  try{if(this.closed||this.capture!==c||!this.options||this.ttl()!==c.ttlMs)return false;
   const start=this.clocks();if(start.utc>=Math.min(c.lease.expiresAt,c.snapshot.retentionExpiresAt)||start.mono>=c.until)return false;
   const current=this.options.snapshot();if(!current||hash(current)!==hash(c.snapshot))return false;
   const lease=this.options.broker.lease(c.lease.leaseId);this.options.broker.assertLease(lease,c.lease.fencingToken);
   const end=this.clocks();return !this.closed&&this.capture===c&&hash(lease)===hash(c.lease)&&lease.status==='active'&&end.utc<Math.min(c.lease.expiresAt,c.snapshot.retentionExpiresAt)&&end.mono<c.until;
  }catch{return false;}
 }
 open():boolean{
  if(!this.options||this.closed||this.capture||this.entering)return false;this.entering=true;let lease:CameraResourceLease|undefined;
  try{const start=this.clocks(),snapshot=this.options.snapshot(),ttl=this.ttl();
   if(!snapshot||!Number.isFinite(snapshot.retentionExpiresAt)||snapshot.retentionExpiresAt<=start.utc||this.closed)return false;
   const owner=`ubuntu-observation:${randomBytes(16).toString('hex')}`;
   lease=this.options.broker.acquireLease({resourceId:snapshot.binding.resourceId,operation:'capture',owner,ttlMs:Math.max(1,Math.min(ttl,Math.floor(snapshot.retentionExpiresAt-start.utc)))});
   const end=this.clocks();if(this.closed||lease.owner!==owner||lease.operation!=='capture'||lease.resourceId!==snapshot.binding.resourceId||lease.status!=='active'||lease.expiresAt<=end.utc||lease.expiresAt>end.utc+ttl)throw Error('OBSERVATION_LEASE_INVALID');
   const c:Capture={snapshot:structuredClone(snapshot),lease:structuredClone(lease),until:Math.min(start.mono+ttl,end.mono+Math.min(lease.expiresAt,snapshot.retentionExpiresAt)-end.utc),ttlMs:ttl};this.capture=c;
   if(!this.original(c)){this.close();return false;}return true;
  }catch{if(lease)try{this.options.broker.releaseLease({leaseId:lease.leaseId,fencingToken:lease.fencingToken});}catch{}this.close();return false;}
  finally{this.entering=false;}
 }
 read():{snapshot:UbuntuObservationSnapshot;lease:CameraResourceLease;until:number}|null{
  const c=this.capture;if(!c||!this.original(c)){if(c&&this.capture===c)this.close();return null;}return structuredClone(c);
 }
 begin():{handle:object;expiresAt:number;until:number}|null{
  if(this.frame||this.entering||this.renewing)return null;this.entering=true;
  try{const c=this.capture;if(!c||!this.original(c)){if(c)this.close();return null;}const start=this.clocks(),handle=Object.freeze({});
   const f:Frame={handle,expiresAt:Math.min(start.utc+5000,c.lease.expiresAt,c.snapshot.retentionExpiresAt),until:Math.min(start.mono+5000,c.until)};this.frame=f;
   if(!this.currentFrame(handle)){this.finish(handle);return null;}return {...f};
  }catch{return null;}finally{this.entering=false;}
 }
 currentFrame(handle:object):boolean{
  const f=this.frame,c=this.capture;if(!f||f.handle!==handle||!c)return false;if(!this.original(c)){this.close();return false;}
  try{const end=this.clocks();return this.frame===f&&this.capture===c&&!this.closed&&end.utc<f.expiresAt&&end.mono<f.until;}catch{return false;}
 }
 finish(handle:object):void{if(this.frame?.handle===handle)this.frame=undefined;}
 renew():boolean{
  if(this.closed||!this.options||this.frame||this.entering||this.renewing)return false;this.renewing=true;
  try{const c=this.capture;if(!c||!this.original(c)){if(c)this.close();return false;}const start=this.clocks(),ttl=this.ttl();
   const lease=this.options.broker.renewLease({leaseId:c.lease.leaseId,fencingToken:c.lease.fencingToken,ttlMs:Math.max(1,Math.min(ttl,Math.floor(c.snapshot.retentionExpiresAt-start.utc)))});
   const end=this.clocks();if(this.closed||this.capture!==c||lease.leaseId!==c.lease.leaseId||lease.fencingToken!==c.lease.fencingToken||lease.owner!==c.lease.owner||lease.resourceId!==c.lease.resourceId||lease.operation!=='capture'||lease.status!=='active'||lease.expiresAt<=end.utc||lease.expiresAt>end.utc+ttl)throw Error('OBSERVATION_RENEWAL_INVALID');
   const next={snapshot:c.snapshot,lease:structuredClone(lease),until:Math.min(start.mono+ttl,end.mono+Math.min(lease.expiresAt,c.snapshot.retentionExpiresAt)-end.utc),ttlMs:ttl};this.capture=next;
   if(!this.original(next)){this.close();return false;}return true;
  }catch{this.close();return false;}finally{this.renewing=false;}
 }
 close():void{
  if(this.closed)return;this.closed=true;const c=this.capture;this.capture=undefined;this.frame=undefined;
  // Latch withdrawal before callback cascades, and release only the captured lease.
  try{this.options?.onWithdraw?.();}catch{}finally{if(c)try{this.options?.broker.releaseLease({leaseId:c.lease.leaseId,fencingToken:c.lease.fencingToken});}catch{}}
 }
}
