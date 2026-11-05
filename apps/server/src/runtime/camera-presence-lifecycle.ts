import type {Database} from '@lifestream/storage-sqlite';
import {AudienceCoordinator,type AudienceIdentity} from './audience.ts';
import {InitiativeHost} from './initiative-host.ts';
import {ProductionCameraBinding,type ProductionCameraPorts} from './production-camera-binding.ts';
import {QualifiedPresenceSource,type PresenceBinding,type QualifiedPresencePorts} from './qualified-presence-source.ts';

type DestinationContext=Parameters<InitiativeHost['receiveQualified']>[1];
export type CameraPresenceLifecyclePorts={
 database:Database;audience:AudienceCoordinator;sourceId:string;
 camera:ProductionCameraPorts;presence:QualifiedPresencePorts;
 /** Forward the original frozen participating owner map; never mint custody here. */
 availability?:QualifiedPresencePorts['availability'];
 /** A genuinely connected, current destination, not a completed HTTP response. */
 destination:()=>DestinationContext|null;
 now?:()=>number;
};
export type CameraPresenceRefresh={status:'unavailable'|'noOpportunity'|'noDestination'|'processed';result?:Awaited<ReturnType<InitiativeHost['receiveQualified']>>};
type Published={identity:AudienceIdentity;sourceId:string;evidenceRef:string;revision:number};

/** Internal preparation only. No server installation, native capture or permission acquisition. */
export class CameraPresenceLifecycle {
 readonly camera:ProductionCameraBinding;
 readonly source:QualifiedPresenceSource;
 /** Future composition must use this SAME host for ordinary Initiative operations. */
 readonly initiative:InitiativeHost;
 private readonly ports:CameraPresenceLifecyclePorts;
 private capturedBinding:PresenceBinding|null=null;
 private published:Published|undefined;
 private running:Promise<CameraPresenceRefresh>|undefined;
 private closed=false;
 constructor(ports:CameraPresenceLifecyclePorts){
  this.ports=ports;this.camera=new ProductionCameraBinding(ports.camera);
  this.source=new QualifiedPresenceSource(ports.sourceId,{...ports.presence,...(ports.availability?{availability:ports.availability}:{}),binding:()=>{
   const binding=ports.presence.binding();this.capturedBinding=binding?structuredClone(binding):null;return binding;
  }});
  this.initiative=new InitiativeHost(ports.database,undefined,ports.now??Date.now,this.source);
 }
 private withdrawPublished():void{
  const old=this.published;this.published=undefined;if(!old)return;
  // A late stop cannot erase a replacement source or subsequent manual decision.
  const actual=this.ports.audience.snapshot(old.identity);
  if(actual.sourceId===old.sourceId&&actual.evidenceRef===old.evidenceRef&&actual.revision===old.revision)this.ports.audience.observe(old.identity,null);
 }
 private async pump():Promise<CameraPresenceRefresh>{
  if(this.closed)return {status:'unavailable'};
  const observation=this.source.poll(),binding=this.capturedBinding;
  if(this.closed)return {status:'unavailable'};
  if(!observation||!binding){this.withdrawPublished();this.initiative.invalidate('sourceChanged');return {status:'unavailable'};}
  const identity:AudienceIdentity={principalId:binding.scope.userId,sessionId:binding.sessionId,endpointId:binding.endpointId};
  if(this.published&&JSON.stringify(this.published.identity)!==JSON.stringify(identity))this.withdrawPublished();
  const opportunity=this.source.opportunityId(),custody=opportunity?this.source.opportunityGuard(opportunity):null;
  this.ports.audience.observe(identity,observation);
  const accepted=this.ports.audience.snapshot(identity);
  this.published=accepted.sourceId===observation.sourceId&&accepted.evidenceRef===observation.evidenceRef?{identity,sourceId:observation.sourceId,evidenceRef:observation.evidenceRef,revision:accepted.revision}:undefined;
  if(this.closed){this.withdrawPublished();return {status:'unavailable'};}
  const id=this.source.opportunityId();if(!id)return {status:'noOpportunity'};
  // Qualified physical evidence does not override the current disclosure owner.
  const audienceRevision=accepted.revision;
  const audienceCurrent=()=>{const current=this.ports.audience.snapshot(identity);return !this.closed&&current.privateAllowed&&current.revision===audienceRevision;};
  if(!audienceCurrent()){this.initiative.invalidate('audienceChanged');return {status:'unavailable'};}
  let context:DestinationContext|null;
  try{context=this.ports.destination();}catch{context=null;}
  if(this.closed)return {status:'unavailable'};
  if(!context){this.initiative.invalidate('endpointUnavailable');return {status:'noDestination'};}
  // All original source, session, readiness, consent, preparation and output checks remain.
  if(custody&&!custody()){this.initiative.invalidate('sourceChanged');return {status:'unavailable'};}
  const destination=context;
  // Keep the destination's live callbacks; copying them can hide a later session revision.
  const captured=Object.create(destination) as DestinationContext;
  Object.defineProperty(captured,'audienceAdmissionCurrent',{value:audienceCurrent,writable:false,configurable:false,enumerable:true});
  Object.defineProperty(captured,'authorized',{value:()=>audienceCurrent()&&destination.authorized()&&audienceCurrent(),writable:false,configurable:false,enumerable:true});
  if(custody)Object.defineProperty(captured,'custodyCurrent',{value:custody,writable:false,configurable:false,enumerable:true});
  return {status:'processed',result:await this.initiative.receiveQualified(id,captured)};
 }
 refresh():Promise<CameraPresenceRefresh>{
  if(this.closed)return Promise.resolve({status:'unavailable'});
  if(this.running)return this.running;
  const running=Promise.resolve().then(()=>this.pump()).finally(()=>{if(this.running===running)this.running=undefined;});
  this.running=running;return running;
 }
 close():void{
  if(this.closed)return;this.closed=true;
  this.source.stop();
  try{this.withdrawPublished();}finally{try{this.camera.close();}finally{this.initiative.close();}}
  // The shared AudienceCoordinator is caller-owned and remains available to successors.
 }
}

/** Absent or incomplete explicit configuration is unavailable without touching any resource. */
export function createCameraPresenceLifecycle(ports:Partial<CameraPresenceLifecyclePorts>|null=null):CameraPresenceLifecycle|null{
 if(!ports||!ports.database||!ports.audience||typeof ports.sourceId!=='string'||!ports.sourceId||Buffer.byteLength(ports.sourceId)>80||typeof ports.destination!=='function')return null;
 const camera=ports.camera,presence=ports.presence;
 if(!camera||!presence||!camera.broker||!['resource','acquireLease','lease','assertLease','releaseLease','renewLease'].every(k=>typeof camera.broker[k as keyof typeof camera.broker]==='function')||![camera.selection,camera.scopeCurrent,camera.hostLeaseCurrent,presence.binding,presence.current,presence.owner,presence.camera,presence.identity].every(fn=>typeof fn==='function'))return null;
 return new CameraPresenceLifecycle(ports as CameraPresenceLifecyclePorts);
}
