import {createHash,randomUUID} from 'node:crypto';
import type {VisualScope} from '@lifestream/runtime/perception/port';

/** Internal resource custody, not a permission prompt, device driver or public grant. */
export type CameraResource={resourceId:string;kind:string;health:string;permissionStatus:string;removed?:boolean;capabilities:readonly string[]};
export type CameraResourceLease={leaseId:string;resourceId:string;operation:string;owner:string;fencingToken:string;expiresAt:number;status:string};
export type CameraResourceBroker={
 resource:(id:string)=>CameraResource;
 acquireLease:(input:{resourceId:string;operation:string;owner:string;ttlMs:number})=>CameraResourceLease;
 lease:(id:string)=>CameraResourceLease;
 assertLease:(lease:CameraResourceLease,fencingToken:string)=>unknown;
 releaseLease:(input:{leaseId:string;fencingToken:string})=>unknown;
 renewLease:(input:{leaseId:string;fencingToken:string;ttlMs:number})=>CameraResourceLease;
};
export type CameraSelection={resourceId:string;sourceBindingRef:string;configurationRevision:number;permission:'granted'|'denied'|'unknown'};
export type AcceptedCameraLease={leaseId:string;clockMappingId:string;expiresAt:number};
export type ProductionCameraPorts={
 broker:CameraResourceBroker;
 selection:(scope:VisualScope)=>CameraSelection|null;
 /** Actual authenticated scope, consent, interpretation/egress and foreground owner. */
 scopeCurrent:(scope:VisualScope)=>boolean;
 /** Reads the original host's accepted lease, never a browser assertion. */
 hostLeaseCurrent:(scope:VisualScope,lease:AcceptedCameraLease)=>boolean;
 now?:()=>number;monotonicMs?:()=>number;
};
export type CameraReservation={reservationId:string;resourceId:string;sourceBindingRef:string;configurationRevision:number};
type Entry={scope:VisualScope;selection:CameraSelection;resource:CameraResourceLease;reservation:CameraReservation;host?:AcceptedCameraLease;deadline:number;utc:number;mono:number;signal:AbortSignal;abort:()=>void};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeKeys=['assistantId','principalId','relationshipId','environmentId','conversationId','sessionId','endpointId','sessionRevision','audienceRevision','scopeGeneration','sourceBindingRef','captureConfigurationRevision'] as const;
const scopeKey=(scope:VisualScope)=>digest(scopeKeys.map(k=>scope[k]));
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&Buffer.byteLength(v)<=256;
const validScope=(s:VisualScope)=>scopeKeys.every(k=>['sessionRevision','audienceRevision','scopeGeneration','captureConfigurationRevision'].includes(k)?Number.isSafeInteger(s[k])&&Number(s[k])>=0:k==='relationshipId'?s[k]===null||text(s[k]):text(s[k]));
export class CameraBindingUnavailable extends Error{constructor(){super('Configured camera custody is unavailable');this.name='CameraBindingUnavailable';}}

/** Unwired by default. Reserve only after explicit enable preparation and granted permission. */
export class ProductionCameraBinding {
 private readonly entries=new Map<string,Entry>();
 private readonly now:()=>number;private readonly mono:()=>number;
 private readonly ports:ProductionCameraPorts;
 constructor(ports:ProductionCameraPorts){this.ports=ports;this.now=ports.now??Date.now;this.mono=ports.monotonicMs??(()=>performance.now());}
 private selected(scope:VisualScope):CameraSelection|null{
  try{
   if(!validScope(scope)||this.ports.scopeCurrent(scope)!==true)return null;
   const s=this.ports.selection(scope);if(!s||!text(s.resourceId)||s.permission!=='granted'||s.sourceBindingRef!==scope.sourceBindingRef||s.configurationRevision!==scope.captureConfigurationRevision)return null;
   const r=this.ports.broker.resource(s.resourceId);
   return r.resourceId===s.resourceId&&r.kind==='camera'&&r.health==='healthy'&&!r.removed&&r.permissionStatus==='granted'&&r.capabilities.includes('capture')?structuredClone(s):null;
  }catch{return null;}
 }
 /** Metadata read does not reserve a resource or capture. */
 available(scope:VisualScope):boolean{return this.selected(scope)!==null;}
 prepare(input:VisualScope,signal:AbortSignal):CameraReservation{
  const scope=structuredClone(input),selection=this.selected(scope),utc=this.now(),mono=this.mono();
  if(!selection||signal.aborted||this.entries.size>=4||![utc,mono].every(Number.isFinite))throw new CameraBindingUnavailable();
  let resource:CameraResourceLease|undefined;
  try{
   resource=this.ports.broker.acquireLease({resourceId:selection.resourceId,operation:'capture',owner:`conversation-camera:${scopeKey(scope)}`,ttlMs:60_000});
   if(!this.resourceMatches(resource,selection.resourceId,`conversation-camera:${scopeKey(scope)}`)||resource.expiresAt<=utc||resource.expiresAt>utc+60_000)throw new CameraBindingUnavailable();
   const reservation={reservationId:randomUUID(),resourceId:selection.resourceId,sourceBindingRef:selection.sourceBindingRef,configurationRevision:selection.configurationRevision};
   const entry:Entry={scope,selection,resource:structuredClone(resource),reservation,deadline:mono+resource.expiresAt-utc,utc,mono,signal,abort:()=>this.release(reservation)};
   this.entries.set(reservation.reservationId,entry);signal.addEventListener('abort',entry.abort,{once:true});
   if(!this.currentEntry(entry,false)){this.release(reservation);throw new CameraBindingUnavailable();}
   return structuredClone(reservation);
  }catch(error){
   // Release only this captured acquisition; never look up a resource's successor.
   if(resource)try{this.ports.broker.releaseLease({leaseId:resource.leaseId,fencingToken:resource.fencingToken});}catch{/* expired/retired */}
   throw error instanceof CameraBindingUnavailable?error:new CameraBindingUnavailable();
  }
 }
 private resourceMatches(r:CameraResourceLease,resourceId:string,owner:string):boolean{return !!r&&text(r.leaseId)&&text(r.fencingToken)&&r.resourceId===resourceId&&r.owner===owner&&r.operation==='capture'&&r.status==='active'&&Number.isFinite(r.expiresAt);}
 private currentEntry(e:Entry,requireHost:boolean):boolean{
  try{
   const utc=this.now(),mono=this.mono();
   if(![utc,mono].every(Number.isFinite)||utc<e.utc||mono<e.mono||mono>=e.deadline||utc>=e.resource.expiresAt||e.signal.aborted)return false;
   e.utc=utc;e.mono=mono;
   const selected=this.selected(e.scope),r=this.ports.broker.lease(e.resource.leaseId);
   if(!selected||digest(selected)!==digest(e.selection)||!this.resourceMatches(r,e.resource.resourceId,e.resource.owner)||r.fencingToken!==e.resource.fencingToken||r.expiresAt!==e.resource.expiresAt)return false;
   this.ports.broker.assertLease(r,e.resource.fencingToken);
   const allowed=!requireHost||!!e.host&&utc<e.host.expiresAt&&this.ports.hostLeaseCurrent(e.scope,structuredClone(e.host))===true;
   const finalUtc=this.now(),finalMono=this.mono();
   if(!allowed||![finalUtc,finalMono].every(Number.isFinite)||finalUtc<utc||finalMono<mono||finalMono>=e.deadline||finalUtc>=e.resource.expiresAt||requireHost&&finalUtc>=e.host!.expiresAt)return false;
   e.utc=finalUtc;e.mono=finalMono;return true;
  }catch{return false;}
 }
 private entry(reservation:CameraReservation):Entry|undefined{const e=this.entries.get(reservation.reservationId);return e&&digest(e.reservation)===digest(reservation)?e:undefined;}
 adopt(reservation:CameraReservation,host:AcceptedCameraLease):boolean{
  const e=this.entry(reservation);if(!e||e.host||!this.currentEntry(e,false))return false;
  const accepted=structuredClone(host),now=this.now(),mono=this.mono();
  if(!uuid.test(accepted.leaseId)||!text(accepted.clockMappingId)||!Number.isFinite(accepted.expiresAt)||accepted.expiresAt<=now||accepted.expiresAt>now+60_000)return false;
  try{if(this.ports.hostLeaseCurrent(e.scope,accepted)!==true)return false;}catch{return false;}
  e.host=accepted;e.deadline=Math.min(e.deadline,mono+accepted.expiresAt-now);
  return this.currentEntry(e,true);
 }
 current(reservation:CameraReservation,host:AcceptedCameraLease):boolean{const e=this.entry(reservation);return !!e?.host&&digest(e.host)===digest(host)&&this.currentEntry(e,true);}
 /** Only a genuinely accepted renewed host lease may extend resource custody. */
 renew(reservation:CameraReservation,host:AcceptedCameraLease):boolean{
  const e=this.entry(reservation);if(!e?.host||!this.currentEntry(e,false)||e.host.leaseId!==host.leaseId||e.host.clockMappingId!==host.clockMappingId)return false;
  const accepted=structuredClone(host),utc=this.now(),mono=this.mono(),ttl=accepted.expiresAt-utc;
  if(!Number.isFinite(ttl)||ttl<=0||ttl>60_000||!Number.isInteger(ttl))return false;
  try{
   if(this.ports.hostLeaseCurrent(e.scope,accepted)!==true)return false;
   const r=this.ports.broker.renewLease({leaseId:e.resource.leaseId,fencingToken:e.resource.fencingToken,ttlMs:ttl});
   if(!this.resourceMatches(r,e.resource.resourceId,e.resource.owner)||r.fencingToken!==e.resource.fencingToken||r.expiresAt!==accepted.expiresAt)return false;
   e.resource=structuredClone(r);e.host=accepted;e.deadline=mono+ttl;return this.currentEntry(e,true);
  }catch{return false;}
 }
 release(reservation:CameraReservation,hostLeaseId?:string):void{
  const e=this.entry(reservation);if(!e||hostLeaseId!==undefined&&e.host?.leaseId!==hostLeaseId)return;
  this.entries.delete(reservation.reservationId);e.signal.removeEventListener('abort',e.abort);
  try{this.ports.broker.releaseLease({leaseId:e.resource.leaseId,fencingToken:e.resource.fencingToken});}catch{/* exact expired lease only */}
 }
 close():void{for(const e of [...this.entries.values()])this.release(e.reservation);}
}
