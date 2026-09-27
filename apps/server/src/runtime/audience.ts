// Endpoint-scoped disclosure evidence. This does not identify speakers or grant authority.
export type AudienceIdentity={principalId:string;sessionId:string;endpointId:string|null};
export type AudienceObservation={sourceId:string;evidenceRef:string;endpointId:string;principalId:string;observedAt:string;expiresAt:string;coverageKnown:boolean;ownerPresent:boolean;occupants:number};
export type AudienceSnapshot={classification:'solo-supported'|'shared'|'unknown';basis:'automatic'|'manual'|'unavailable'|'restricted';revision:number;sourceId:string|null;evidenceRef:string|null;expiresAt:string|null;automatic:boolean;privateAllowed:boolean;leaseId:string|null;leaseExpiresAt:string|null};
export type AudienceLeaseRequest={operation:'begin'|'renew'|'end';leaseId:string;expectedAudienceRevision:number};
export class AudienceLeaseError extends Error {
 readonly status:number;readonly code:string;
 constructor(status:number,code:string,message:string){super(message);this.status=status;this.code=code;}
}
const LEASE_LIVENESS_MS=20_000;
export type AudienceOptions={sourceIds?:string[];poll?:(identity:AudienceIdentity,signal:AbortSignal)=>Promise<AudienceObservation|null>;subscribeInvalidation?:(listener:()=>void)=>()=>void;now?:()=>number};
type Entry={generation:number;identity:AudienceIdentity;observation?:AudienceObservation|undefined;manual?:{mode:'solo'|'shared';expires:number}|undefined;lease?:{id:string;expires:number;current:()=>boolean}|undefined;restricted:boolean;revision:number;key:string;value:AudienceSnapshot;listeners:Set<(value:AudienceSnapshot)=>void>;touched:number;polling?:AbortController|undefined};
export class AudienceCoordinator{
 private readonly entries=new Map<string,Entry>();private readonly timer:ReturnType<typeof setInterval>;private readonly now:()=>number;
 private unsubscribeSource:(()=>void)|undefined;private readonly options:AudienceOptions;private readonly changed:()=>void;
 constructor(options:AudienceOptions={},changed:()=>void=()=>{}){this.options=options;this.changed=changed;this.now=options.now??Date.now;this.timer=setInterval(()=>this.tick(),250);this.timer.unref();try{this.unsubscribeSource=options.subscribeInvalidation?.(()=>{for(const e of this.entries.values()){e.generation++;e.polling?.abort();e.observation=undefined;e.lease=undefined;this.reconcile(e);}});}catch(error){clearInterval(this.timer);throw error;}}
 private entry(identity:AudienceIdentity):Entry{const key=JSON.stringify(identity);let e=this.entries.get(key);if(!e){if(this.entries.size>=1000)throw new Error('Audience session capacity reached');const value:AudienceSnapshot={classification:'unknown',basis:'unavailable',revision:0,sourceId:null,evidenceRef:null,expiresAt:null,automatic:false,privateAllowed:false,leaseId:null,leaseExpiresAt:null};e={generation:0,identity:{...identity},restricted:false,revision:0,key:'',value,listeners:new Set(),touched:this.now()};this.entries.set(key,e);}e.touched=this.now();return e;}
 snapshot(identity:AudienceIdentity):AudienceSnapshot{return structuredClone(this.reconcile(this.entry(identity)));}
 lease(identity:AudienceIdentity,input:AudienceLeaseRequest,current:()=>boolean=()=>true):AudienceSnapshot{
  if(!input||Object.keys(input).some(k=>!['operation','leaseId','expectedAudienceRevision'].includes(k))||!['begin','renew','end'].includes(input.operation)||typeof input.leaseId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.leaseId)||!Number.isSafeInteger(input.expectedAudienceRevision)||input.expectedAudienceRevision<0)throw new AudienceLeaseError(422,'audience_lease_invalid','A lease operation, random UUID and audience revision are required');
  const e=this.entry(identity);this.reconcile(e);
  // A late close from an older app process cannot withdraw its replacement or a
  // subsequent manual decision. Cleanup never creates audience permission.
  if(input.operation==='end'&&e.lease?.id!==input.leaseId)return structuredClone(e.value);
  if(input.operation==='end'){
   // The exact owner may withdraw only its contribution even if independent
   // evidence revised the snapshot. A stale revision must not strand a lease.
   e.lease=undefined;return structuredClone(this.reconcile(e));
  }
  if(input.operation==='renew'&&e.lease?.id!==input.leaseId)throw new AudienceLeaseError(409,'audience_lease_inactive','The lease is inactive or expired');
  if(e.revision!==input.expectedAudienceRevision)throw new AudienceLeaseError(409,'audience_revision_conflict','The audience revision changed');
  if(input.operation==='renew')e.lease!.expires=this.now()+LEASE_LIVENESS_MS;
  else{
   if(!identity.endpointId||!this.leaseCurrent(current))throw new AudienceLeaseError(409,'audience_lease_scope_changed','The authenticated endpoint changed');
   if(e.restricted||e.manual?.mode==='shared'||this.contradiction(e.observation))throw new AudienceLeaseError(409,'audience_lease_restricted','The current audience restricts private access');
   if(e.lease?.id===input.leaseId)throw new AudienceLeaseError(409,'audience_lease_active','Renew an active lease instead of beginning it again');
   e.generation++;e.polling?.abort();e.manual=undefined;e.lease={id:input.leaseId,expires:this.now()+LEASE_LIVENESS_MS,current};
  }
  return structuredClone(this.reconcile(e));
 }
 private leaseCurrent(current:()=>boolean):boolean{try{return current();}catch{return false;}}
 private contradiction(o:AudienceObservation|undefined):boolean{return !!o&&(o.occupants>1||o.coverageKnown&&(!o.ownerPresent||o.occupants!==1));}
 declare(identity:AudienceIdentity,mode:'solo'|'shared'|'clear'|'lock'|'unlock',seconds=300):AudienceSnapshot{
  if(!['solo','shared','clear','lock','unlock'].includes(mode))throw new Error('Unsupported audience declaration');
  if(!Number.isInteger(seconds)||seconds<1||seconds>900)throw new Error('A manual declaration must expire within fifteen minutes');
  // An explicit control action fences a pending lease acquisition even when it
  // leaves the classification unchanged (for example, clearing unknown).
  const e=this.entry(identity);e.generation++;e.polling?.abort();e.lease=undefined;e.key='';if(mode==='lock'){e.restricted=true;e.manual=undefined;}else if(mode==='unlock'){e.restricted=false;e.manual=undefined;e.observation=undefined;}else if(mode==='clear')e.manual=undefined;else{if(!identity.endpointId)throw new Error('Open Session disclosure and apply a choice before declaring an audience');e.manual={mode,expires:this.now()+seconds*1000};}return structuredClone(this.reconcile(e));
 }
 // Only an operator-configured source adapter can publish automatic evidence.
 observe(identity:AudienceIdentity,input:AudienceObservation|null):void{const e=this.entry(identity);e.generation++;e.polling?.abort();this.applyObservation(e,input);}
 private applyObservation(e:Entry,input:AudienceObservation|null):void{e.observation=undefined;if(input&&this.valid(e.identity,input))e.observation=structuredClone(input);this.reconcile(e);}
 private valid(identity:AudienceIdentity,o:AudienceObservation):boolean{const now=this.now(),at=Date.parse(o.observedAt),expires=Date.parse(o.expiresAt);return !!identity.endpointId&&o.endpointId===identity.endpointId&&o.principalId===identity.principalId&&(this.options.sourceIds??[]).includes(o.sourceId)&&typeof o.evidenceRef==='string'&&o.evidenceRef.length>0&&o.evidenceRef.length<=256&&Number.isInteger(o.occupants)&&o.occupants>=0&&o.occupants<=100&&typeof o.coverageKnown==='boolean'&&typeof o.ownerPresent==='boolean'&&Number.isFinite(at)&&at<=now+500&&now-at<=5000&&Number.isFinite(expires)&&expires>now&&expires<=at+5000;}
 private reconcile(e:Entry):AudienceSnapshot{
  const now=this.now();if(e.manual&&e.manual.expires<=now)e.manual=undefined;if(e.observation&&!this.valid(e.identity,e.observation))e.observation=undefined;
  if(e.lease&&(e.lease.expires<=now||!this.leaseCurrent(e.lease.current)||e.restricted||this.contradiction(e.observation)))e.lease=undefined;
  const o=e.observation,m=e.manual;let classification:AudienceSnapshot['classification']='unknown',basis:AudienceSnapshot['basis']='unavailable',expiresAt:string|null=null,sourceId:string|null=null,evidenceRef:string|null=null;
  if(e.restricted){basis='restricted';}
  else if(m?.mode==='shared'){classification='shared';basis='manual';expiresAt=new Date(m.expires).toISOString();}
  else if(o&&o.occupants>1){classification='shared';basis='automatic';expiresAt=o.expiresAt;sourceId=o.sourceId;evidenceRef=o.evidenceRef;}
  // Known automatic coverage can contradict a still-current manual solo declaration.
  else if(o&&o.coverageKnown){if(o.ownerPresent&&o.occupants===1)classification='solo-supported';basis='automatic';expiresAt=o.expiresAt;sourceId=o.sourceId;evidenceRef=o.evidenceRef;}
  else if(m?.mode==='solo'){classification='solo-supported';basis='manual';expiresAt=new Date(m.expires).toISOString();}
  else if(e.lease){classification='solo-supported';basis='manual';expiresAt=new Date(e.lease.expires).toISOString();}
  const leaseId=e.lease?.id??null,key=JSON.stringify([classification,basis,sourceId,leaseId]);const changed=key!==e.key;e.key=key;if(changed)e.revision++;
  e.value={classification,basis,revision:e.revision,sourceId,evidenceRef,expiresAt,automatic:basis==='automatic',privateAllowed:classification==='solo-supported',leaseId,leaseExpiresAt:e.lease?new Date(e.lease.expires).toISOString():null};
  if(changed){this.changed();for(const fn of e.listeners)fn(structuredClone(e.value));}return e.value;
 }
 subscribe(identity:AudienceIdentity,fn:(value:AudienceSnapshot)=>void):()=>void{const e=this.entry(identity);if(e.listeners.size>=16)throw new Error('Too many audience subscribers');e.listeners.add(fn);fn(this.snapshot(identity));return ()=>e.listeners.delete(fn);}
 tick():void{const now=this.now();for(const [key,e]of this.entries){this.reconcile(e);if(!e.listeners.size&&now-e.touched>1800000){e.polling?.abort();this.entries.delete(key);continue;}if(this.options.poll&&e.identity.endpointId&&!e.polling){const generation=e.generation,controller=e.polling=new AbortController(),timeout=setTimeout(()=>controller.abort(),750);const promise=Promise.resolve().then(()=>this.options.poll!(e.identity,controller.signal));void Promise.race([promise,new Promise<null>(resolve=>controller.signal.addEventListener('abort',()=>resolve(null),{once:true}))]).then(value=>{if(this.entries.get(key)===e&&e.generation===generation)this.applyObservation(e,value);},()=>{if(this.entries.get(key)===e&&e.generation===generation)this.applyObservation(e,null);}).finally(()=>{clearTimeout(timeout);if(e.polling===controller)e.polling=undefined;});}}}
 close():void{clearInterval(this.timer);this.unsubscribeSource?.();for(const e of this.entries.values())e.polling?.abort();this.entries.clear();}
}
